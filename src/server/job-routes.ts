import { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { getRuntimeConfig, jsonResponse, jsonErrorResponse, readJsonBody, responseAlreadyStarted } from "./shared.js";
import { listStoredJobs, readJobRecord, updateStoredJobRecord, updateJobControlState, resolveApprovalRequest, type StoredJobRecord } from "../job-store.js";
import { getActiveJobSession, cancelActiveJobSession, resolvePendingApproval } from "../job-runtime.js";
import { appendEvent, getEvents, subscribe, getNextSeq, loadEventsFromDisk } from "../job-event-bus.js";
import { buildRuntimeProfile } from "../runtime/profile.js";
import { loadConfig } from "../config.js";
import { buildHealthyExecutorRuntimeConfig } from "../model-health.js";
import { renderJobsDashboardHtml } from "../jobs-dashboard.js";
import { renderTimelineHtml } from "../timeline.js";
import {
  buildJobResponse,
  buildJobListItem,
  buildWorkflowSummary,
  buildEventSnapshot,
  buildStepList,
  buildJobEvents,
  mergeJobEvents,
  createLifecycleEvent,
  buildJobRouteSet,
  buildResumeFollowTarget,
  isRecoveryLifecycleEvent,
  formatProgressUpdate,
  attachRequestAbortCancellation,
  executeJobByMode,
  normalizeDaoRunGoal,
  buildModelsResponse,
  buildHealthResponse,
  resolveRequestedModel,
  parseNonNegativeIntegerParam,
  sseWrite,
  sseWriteEvent,
  isObjectRecord,
  buildWorkflowPayload,
  filterJobEvents,
  readJobEventQuery,
  parseStringSetParam,
  getHeaderValue,
  buildWorkflowEvent,
} from "../index.js";
import type { Job } from "../types.js";

interface CreateJobRequest {
  goal?: string;
  mode?: "task" | "team";
  model_route?: string;
  policy?: { allow_network?: boolean; allow_shell?: boolean; approval_mode?: string; async?: boolean };
}
interface FixedTaskIds { jobId: string; planId: string; taskRunId: string; }

function buildListedJobsResponse(routeBasePath = "/v1/jobs"): Array<Record<string, unknown>> {
  return listStoredJobs().flatMap((stored) => {
    const record = readJobRecord(stored.id);
    if (!record) {
      return [{
        id: stored.id,
        goal: stored.goal,
        status: stored.status,
        saved_at: stored.savedAt,
        ...buildJobRouteSet(stored.id, routeBasePath),
      }];
    }
    return [buildJobListItem(record, routeBasePath)];
  });
}

function normalizeJobDashboardFilter(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function getJobRouteKind(record: StoredJobRecord): string {
  return normalizeJobDashboardFilter(record.job.intentRoute?.kind ?? record.plan.intentRoute?.kind ?? "unknown");
}

function buildListedJobsPageResponse(
  routeBasePath = "/jobs",
  options?: {
    page?: number;
    pageSize?: number;
    status?: string | null;
    route?: string | null;
    query?: string | null;
  },
): {
  object: "list";
  data: Array<Record<string, unknown>>;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
    has_prev: boolean;
    has_next: boolean;
  };
  counts: {
    by_status: Record<string, number>;
    by_route: Record<string, number>;
  };
} {
  const pageSize = Math.min(Math.max(options?.pageSize ?? 50, 1), 100);
  const page = Math.max(options?.page ?? 1, 1);
  const statusFilter = normalizeJobDashboardFilter(options?.status);
  const routeFilter = normalizeJobDashboardFilter(options?.route);
  const query = String(options?.query ?? "").trim().toLowerCase();

  type DashboardJobRow = {
    id: string;
    goal: string;
    status: string;
    routeKind: string;
    fallback?: Record<string, unknown>;
    record?: StoredJobRecord;
  };

  const buildFallbackRow = (stored: { id: string; savedAt: string; status: Job["status"]; goal: string }): DashboardJobRow => ({
    id: stored.id,
    goal: stored.goal,
    status: normalizeJobDashboardFilter(stored.status),
    routeKind: "unknown",
    fallback: {
      id: stored.id,
      goal: stored.goal,
      status: stored.status,
      saved_at: stored.savedAt,
      ...buildJobRouteSet(stored.id, routeBasePath),
    },
  });

  const queryRows = listStoredJobs()
    .filter((stored) => {
      if (!query) {
        return true;
      }
      return stored.id.toLowerCase().includes(query) || stored.goal.toLowerCase().includes(query);
    })
    .map(buildFallbackRow);

  const routeScopedRows = routeFilter
    ? queryRows.flatMap<DashboardJobRow>((row) => {
        const record = readJobRecord(row.id);
        if (!record) {
          return routeFilter === "unknown" ? [row] : [];
        }
        const routeKind = getJobRouteKind(record);
        if (routeKind !== routeFilter) {
          return [];
        }
        return [{
          id: record.job.id,
          goal: record.job.goal,
          status: normalizeJobDashboardFilter(record.job.status),
          routeKind,
          record,
        }];
      })
    : queryRows;

  const byStatus = routeScopedRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const statusScopedRows = statusFilter
    ? routeScopedRows.filter((row) => row.status === statusFilter)
    : routeScopedRows;

  const total = statusScopedRows.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRows = statusScopedRows.slice(start, start + pageSize);
  const hydratePageRecords = Boolean(query || routeFilter);
  const pageItems = pageRows.flatMap((row) => {
    if (row.record) {
      return [{
        row: {
          ...row,
          routeKind: getJobRouteKind(row.record),
        },
        item: buildJobListItem(row.record, routeBasePath),
      }];
    }
    const record = hydratePageRecords ? readJobRecord(row.id) : null;
    if (record) {
      return [{
        row: {
          ...row,
          status: normalizeJobDashboardFilter(record.job.status),
          routeKind: getJobRouteKind(record),
        },
        item: buildJobListItem(record, routeBasePath),
      }];
    }
    return [{
      row,
      item: row.fallback ?? {
        id: row.id,
        goal: row.goal,
        status: row.status,
        ...buildJobRouteSet(row.id, routeBasePath),
      },
    }];
  });

  const routeCountRows = routeFilter
    ? statusScopedRows
    : pageItems.map((entry) => entry.row);
  const byRoute = routeCountRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.routeKind] = (acc[row.routeKind] ?? 0) + 1;
    return acc;
  }, {});

  return {
    object: "list",
    data: pageItems.map((entry) => entry.item),
    pagination: {
      page: safePage,
      page_size: pageSize,
      total,
      total_pages: totalPages,
      has_prev: safePage > 1,
      has_next: safePage < totalPages,
    },
    counts: {
      by_status: byStatus,
      by_route: byRoute,
    },
  };
}

export async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, buildModelsResponse());
}

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const healthSelection = await buildHealthyExecutorRuntimeConfig(config);
  const payload = buildHealthResponse(healthSelection.config, healthSelection.results);
  if (healthSelection.healthyExecutorIds.length === 0) {
    payload.status = "degraded";
  }
  jsonResponse(res, payload.status === "ok" ? 200 : 503, payload);
}

export async function handleListJobs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: buildListedJobsResponse(),
  });
}

export async function handleJobsDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const html = renderJobsDashboardHtml([] as Array<{
    id: string;
    goal: string;
    mode?: string;
    status: string;
  }>, {
    dataUrl: "/jobs/data",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

export async function handleBrowserListJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const pageResult = parseNonNegativeIntegerParam(url.searchParams.get("page"), "page");
  if (!pageResult.ok) {
    jsonErrorResponse(res, 400, pageResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageSizeResult = parseNonNegativeIntegerParam(url.searchParams.get("page_size"), "page_size");
  if (!pageSizeResult.ok) {
    jsonErrorResponse(res, 400, pageSizeResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  jsonResponse(res, 200, buildListedJobsPageResponse("/jobs", {
    page: Math.max(pageResult.value ?? 1, 1),
    pageSize: Math.min(Math.max(pageSizeResult.value ?? 50, 1), 100),
    status: url.searchParams.get("status"),
    route: url.searchParams.get("route"),
    query: url.searchParams.get("q"),
  }));
}

export async function handleCreateJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<CreateJobRequest>(req);
  const rawGoal = typeof body.goal === "string" ? body.goal.trim() : "";
  const normalizedGoal = normalizeDaoRunGoal(rawGoal);
  const goal = normalizedGoal.goal;
  if (!goal) {
    jsonResponse(res, 400, {
      error: {
        message: "`goal` must be a non-empty string.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  if (body.mode !== undefined && body.mode !== "task" && body.mode !== "team") {
    jsonResponse(res, 400, {
      error: {
        message: "`mode` must be either \"task\" or \"team\".",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const modelRoute = typeof body.model_route === "string" && body.model_route.trim()
    ? body.model_route.trim()
    : undefined;
  const requestedMode = body.mode === "team" ? "team" : "task";
  if (requestedMode === "team" && body.policy?.approval_mode === "always" && body.policy.async !== true) {
    jsonResponse(res, 400, {
      error: {
        message: 'team approval_mode "always" requires policy.async=true so the job can wait for /approve.',
        type: "invalid_request_error",
      },
    });
    return;
  }
  if (body.policy?.async === true) {
    const fixedIds: FixedTaskIds = {
      jobId: `job_${randomUUID()}`,
      planId: `plan_${randomUUID()}`,
      taskRunId: `taskrun_${randomUUID()}`,
    };
    const executionPromise = executeJobByMode(requestedMode, goal, modelRoute, {
      requirePlannerCircuit: true,
      fixedIds,
      approvalMode: body.policy?.approval_mode,
    });
    void executionPromise.catch(() => {
      // Failure state is already persisted inside executeTaskGoal.
    });
    const record = readJobRecord(fixedIds.jobId);

    jsonResponse(res, 202, {
      object: "job",
      job_id: fixedIds.jobId,
      status: record?.job.status ?? "running",
      accepted: true,
      goal_sanitized: normalizedGoal.sanitized,
      goal_sanitized_reason: normalizedGoal.reason,
      stream_url: `/v1/jobs/${fixedIds.jobId}/stream`,
      events_url: `/v1/jobs/${fixedIds.jobId}/events`,
      timeline_url: `/v1/jobs/${fixedIds.jobId}/timeline`,
      ...(record ? buildJobResponse(record) as Record<string, unknown> : {
        job: {
          id: fixedIds.jobId,
          goal,
          mode: requestedMode,
          status: "running",
          verified: false,
          output: "Running...",
        },
      }),
    });
    return;
  }

  const result = await executeJobByMode(requestedMode, goal, modelRoute, {
    requirePlannerCircuit: true,
    approvalMode: body.policy?.approval_mode,
  });
  const record = readJobRecord(result.job.id);

  jsonResponse(res, 201, {
    object: "job",
    job_id: result.job.id,
    goal_sanitized: normalizedGoal.sanitized,
    goal_sanitized_reason: normalizedGoal.reason,
    resolved_model: result.resolvedModel,
    log_path: result.logPath,
    workflow: buildWorkflowPayload(result),
    ...(record ? buildJobResponse(record) as Record<string, unknown> : {
      job: result.job,
      plan: result.plan,
      taskRuns: result.taskRuns,
      artifacts: result.artifacts,
      control: {},
    }),
  });
}

export async function handleGetJob(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  jsonResponse(res, 200, buildJobResponse(record, routeBasePath));
}

export async function handleGetJobArtifacts(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  jsonResponse(res, 200, {
    job_id: jobId,
    count: record.artifacts.length,
    artifacts: record.artifacts,
  });
}

export async function handleGetJobSteps(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const steps = buildStepList(record);
  jsonResponse(res, 200, {
    job_id: jobId,
    count: steps.length,
    workflow_summary: buildWorkflowSummary(record),
    steps,
  });
}

export async function handleGetJobRuntimeProfile(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const config = loadConfig();
  const runtimeProfile = buildRuntimeProfile(config);
  jsonResponse(res, 200, {
    job_id: jobId,
    generated_at: new Date().toISOString(),
    diagnostics_summary: {
      dependency_warnings: runtimeProfile.diagnostics.dependencyChecks.filter((check) => check.status === "warning").length,
      dependency_checks: runtimeProfile.diagnostics.dependencyChecks.length,
    },
    runtime_profile: runtimeProfile,
  });
}

export async function handleGetJobEvents(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sinceSeqRaw = url.searchParams.get("since_seq");
  const seqRaw = url.searchParams.get("seq");
  const limitRaw = url.searchParams.get("limit");
  const pageRaw = url.searchParams.get("page");
  const pageSizeRaw = url.searchParams.get("page_size");
  const sinceSeqResult = parseNonNegativeIntegerParam(sinceSeqRaw, "since_seq");
  if (!sinceSeqResult.ok) {
    jsonErrorResponse(res, 400, sinceSeqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const seqResult = parseNonNegativeIntegerParam(seqRaw, "seq");
  if (!seqResult.ok) {
    jsonErrorResponse(res, 400, seqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const limitResult = parseNonNegativeIntegerParam(limitRaw, "limit");
  if (!limitResult.ok) {
    jsonErrorResponse(res, 400, limitResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageResult = parseNonNegativeIntegerParam(pageRaw, "page");
  if (!pageResult.ok) {
    jsonErrorResponse(res, 400, pageResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageSizeResult = parseNonNegativeIntegerParam(pageSizeRaw, "page_size");
  if (!pageSizeResult.ok) {
    jsonErrorResponse(res, 400, pageSizeResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const sinceSeq = sinceSeqResult.value;
  const seq = seqResult.value;
  const limit = limitResult.value;
  const requestedPage = pageResult.value;
  const requestedPageSize = pageSizeResult.value;
  const eventQuery = readJobEventQuery(url);

  const fullEvents = mergeJobEvents(record, loadEventsFromDisk(jobId));
  const filteredEvents = filterJobEvents(fullEvents, {
    sinceSeq,
    seq,
    types: parseStringSetParam(url, "type"),
    statuses: parseStringSetParam(url, "status"),
    agents: eventQuery.agent ? new Set([eventQuery.agent]) : undefined,
    phases: eventQuery.phase ? new Set([eventQuery.phase]) : undefined,
    taskRunIds: eventQuery.taskRunId ? new Set([eventQuery.taskRunId]) : undefined,
  });
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.max(1, requestedPageSize as number)
    : Number.isFinite(limit)
      ? Math.max(1, limit as number)
      : filteredEvents.length || 1;
  const page = Math.max(1, requestedPage ?? 1);
  const offset = (page - 1) * pageSize;
  const pageEvents = filteredEvents.slice(offset, offset + pageSize);
  const events = Number.isFinite(limit) && !Number.isFinite(requestedPage)
    ? filteredEvents.slice(0, limit as number)
    : pageEvents;
  jsonResponse(res, 200, {
    job_id: jobId,
    count: events.length,
    total: filteredEvents.length,
    filters: {
      type: [...parseStringSetParam(url, "type")],
      status: [...parseStringSetParam(url, "status")],
      agent: eventQuery.agent ?? null,
      phase: eventQuery.phase ?? null,
      task_run_id: eventQuery.taskRunId ?? null,
      seq: seq ?? null,
      since_seq: sinceSeq ?? null,
    },
    pagination: {
      page,
      page_size: pageSize,
      total: filteredEvents.length,
      total_pages: Math.max(1, Math.ceil(filteredEvents.length / pageSize)),
    },
    snapshot: buildEventSnapshot(record, fullEvents, routeBasePath),
    events,
  });
}

export async function handleJobStream(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  // Verify job exists
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const url = new URL(_req.url ?? "/", "http://127.0.0.1");
  const sinceSeqRaw = url.searchParams.get("since_seq");
  const seqRaw = url.searchParams.get("seq");
  const pageRaw = url.searchParams.get("page");
  const pageSizeRaw = url.searchParams.get("page_size");
  const lastEventIdRaw = getHeaderValue(_req, "last-event-id");
  const sinceSeqResult = parseNonNegativeIntegerParam(sinceSeqRaw, "since_seq");
  if (!sinceSeqResult.ok) {
    jsonErrorResponse(res, 400, sinceSeqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const seqResult = parseNonNegativeIntegerParam(seqRaw, "seq");
  if (!seqResult.ok) {
    jsonErrorResponse(res, 400, seqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageResult = parseNonNegativeIntegerParam(pageRaw, "page");
  if (!pageResult.ok) {
    jsonErrorResponse(res, 400, pageResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageSizeResult = parseNonNegativeIntegerParam(pageSizeRaw, "page_size");
  if (!pageSizeResult.ok) {
    jsonErrorResponse(res, 400, pageSizeResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const lastEventIdResult = parseNonNegativeIntegerParam(lastEventIdRaw, "Last-Event-ID");
  if (!lastEventIdResult.ok) {
    jsonErrorResponse(res, 400, lastEventIdResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const requestedSinceSeq = sinceSeqResult.value;
  const requestedLastEventId = lastEventIdResult.value;
  const replayCursor = Number.isFinite(requestedSinceSeq)
    ? requestedSinceSeq as number
    : Number.isFinite(requestedLastEventId)
      ? requestedLastEventId as number
      : undefined;
  const eventQuery = readJobEventQuery(url);

  // Load existing events from disk
  const existingEvents = mergeJobEvents(record, loadEventsFromDisk(jobId));
  const replaySource = replayCursor !== undefined
    ? existingEvents
    : (existingEvents.length > 0 ? existingEvents : getEvents(jobId));
  const filteredReplayEvents = filterJobEvents(replaySource, {
    types: parseStringSetParam(url, "type"),
    statuses: parseStringSetParam(url, "status"),
    agents: eventQuery.agent ? new Set([eventQuery.agent]) : undefined,
    phases: eventQuery.phase ? new Set([eventQuery.phase]) : undefined,
    taskRunIds: eventQuery.taskRunId ? new Set([eventQuery.taskRunId]) : undefined,
    seq: seqResult.value,
    sinceSeq: replayCursor,
  });
  const streamPageSize = Number.isFinite(pageSizeResult.value) ? Math.max(1, pageSizeResult.value as number) : filteredReplayEvents.length || 1;
  const streamPage = Math.max(1, pageResult.value ?? 1);
  const replayEvents = Number.isFinite(pageResult.value) || Number.isFinite(pageSizeResult.value)
    ? filteredReplayEvents.slice((streamPage - 1) * streamPageSize, streamPage * streamPageSize)
    : filteredReplayEvents;

  // Set SSE headers
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Send initial snapshot
  const snapshot = buildEventSnapshot(record, existingEvents, routeBasePath);
  if (snapshot) {
    sseWriteEvent(res, "job.snapshot", JSON.stringify({
      ...snapshot,
      replay: {
        ...(isObjectRecord(snapshot.replay) ? snapshot.replay : {}),
        resumed_from_seq: replayCursor ?? null,
        replayed_count: replayEvents.length,
        filtered_count: filteredReplayEvents.length,
        page: streamPage,
        page_size: streamPageSize,
        filters: {
          type: [...parseStringSetParam(url, "type")],
          status: [...parseStringSetParam(url, "status")],
          agent: eventQuery.agent ?? null,
          phase: eventQuery.phase ?? null,
          task_run_id: eventQuery.taskRunId ?? null,
          seq: seqResult.value ?? null,
          since_seq: replayCursor ?? null,
        },
      },
    }));
    if (isObjectRecord(snapshot.follow) && typeof snapshot.follow.type === "string") {
      sseWriteEvent(res, "job.redirect", JSON.stringify(snapshot.follow));
    }
  }

  // Send replay events
  for (const event of replayEvents) {
    sseWriteEvent(res, "job.event", JSON.stringify(event), event.seq);
  }

  // Subscribe to new events
  const unsubscribe = subscribe(jobId, (event) => {
    try {
      if (filterJobEvents([event], {
        types: parseStringSetParam(url, "type"),
        statuses: parseStringSetParam(url, "status"),
        agents: eventQuery.agent ? new Set([eventQuery.agent]) : undefined,
        phases: eventQuery.phase ? new Set([eventQuery.phase]) : undefined,
        taskRunIds: eventQuery.taskRunId ? new Set([eventQuery.taskRunId]) : undefined,
        seq: seqResult.value,
      }).length === 0) {
        return;
      }
      sseWriteEvent(res, "job.event", JSON.stringify(event), event.seq);
      if (event.type === "job.resumed" && isObjectRecord(event.meta) && typeof event.meta.resumed_to_job_id === "string") {
        const follow = buildResumeFollowTarget(jobId, event.meta.resumed_to_job_id, routeBasePath);
        if (follow) {
          sseWriteEvent(res, "job.redirect", JSON.stringify(follow), event.seq);
        }
      }
      if (isRecoveryLifecycleEvent(event.type)) {
        const latestRecord = readJobRecord(jobId);
        const latestEvents = latestRecord ? mergeJobEvents(latestRecord, loadEventsFromDisk(jobId)) : null;
        const latestSnapshot = latestRecord && latestEvents ? buildEventSnapshot(latestRecord, latestEvents, routeBasePath) : null;
        if (latestSnapshot) {
          sseWriteEvent(res, "job.snapshot", JSON.stringify({
            ...latestSnapshot,
            replay: {
              ...(isObjectRecord(latestSnapshot.replay) ? latestSnapshot.replay : {}),
              resumed_from_seq: replayCursor ?? null,
              replayed_count: replayEvents.length,
            },
          }), event.seq);
        }
      }
    } catch {
      // Client disconnected
      unsubscribe();
    }
  });

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      sseWriteEvent(res, "heartbeat", JSON.stringify({ time: new Date().toISOString() }));
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 30_000);
  heartbeat.unref?.();

  // Auto-cleanup after 10 minutes (SSE connections shouldn't last forever)
  const maxDuration = 10 * 60 * 1000;
  const timeout = setTimeout(() => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // Ignore
    }
  }, maxDuration);
  timeout.unref?.();

  // Clear timeout if response ends normally
  const originalEnd = res.end.bind(res);
  res.end = function (...args: Parameters<typeof originalEnd>) {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    unsubscribe();
    return originalEnd(...args);
  } as typeof res.end;
}

export async function handleCancelJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const active = getActiveJobSession(jobId);
  const interrupted = cancelActiveJobSession(jobId, `Run cancelled via API for job ${jobId}.`);
  const cancelledAt = new Date().toISOString();
  const updated = updateStoredJobRecord(jobId, (record) => ({
    ...record,
    savedAt: cancelledAt,
    job: {
      ...record.job,
      status: "cancelled",
      output: "Run cancelled.",
    },
    control: {
      ...record.control,
      cancellationRequestedAt: cancelledAt,
      cancelledAt,
    },
  }));
  if (!updated) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: updated.control?.cancelledAt ?? new Date().toISOString(),
    type: "job.cancelled",
    title: "Job cancelled",
    summary: "Cancellation was requested for this job.",
    status: "blocked",
    meta: {
      active: Boolean(active),
      interrupted,
      cancellation_requested_at: updated.control?.cancellationRequestedAt ?? null,
    },
  }));
  jsonResponse(res, 200, {
    ok: true,
    job_id: jobId,
    active: Boolean(active),
    interrupted,
    control: updated.control ?? {},
  });
}

export async function handleRetryJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonErrorResponse(res, 404, `Job not found: ${jobId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }

  const retryResult = await executeJobByMode(record.job.mode, record.job.goal, undefined, {
    requirePlannerCircuit: false,
  });
  updateJobControlState(jobId, {
    retriedAt: new Date().toISOString(),
    retriedToJobId: retryResult.job.id,
  });
  const retriedRecord = updateJobControlState(retryResult.job.id, {
    retryOf: jobId,
  });
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: new Date().toISOString(),
    type: "job.retried",
    title: "Job retried",
    summary: `A retry job was created: ${retryResult.job.id}.`,
    status: "success",
    meta: {
      retried_to_job_id: retryResult.job.id,
    },
  }));

  jsonResponse(res, 200, {
    ok: true,
    retried_from: jobId,
    job: retryResult.job,
    plan: retryResult.plan,
    taskRuns: retryResult.taskRuns,
    artifacts: retryResult.artifacts,
    control: retriedRecord?.control ?? { retryOf: jobId },
  });
}

export async function handleJobTimeline(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  // Load events from disk
  const events = loadEventsFromDisk(jobId);
  const timelineEvents = events.length > 0 ? events : buildJobEvents(record);

  // Render timeline HTML
  const html = renderTimelineHtml(
    jobId,
    timelineEvents,
    record.job.goal,
    record.job.status,
    buildWorkflowSummary(record) as {
      current_task?: { title?: string; status?: string } | null;
      awaiting_approval_task?: { title?: string; status?: string } | null;
      task_counts?: Record<string, number>;
    },
    buildEventSnapshot(record, timelineEvents, routeBasePath) as {
      follow?: { type?: string; job_id?: string; job_url?: string; timeline_url?: string; stream_url?: string; events_url?: string } | null;
      actions?: Array<{ id?: string; label?: string; kind?: string; href?: string; method?: string; emphasis?: string }>;
      recovery?: { auto_resume_failed_at?: string | null; auto_resume_failure_message?: string | null } | null;
    },
    { routeBasePath },
  );

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

export async function handleApproveJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const body = await readJsonBody<{ approval_id?: string; decision?: string; note?: string }>(req);
  if (!body.approval_id || !body.decision) {
    jsonErrorResponse(res, 400, "approval_id and decision are required.", "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  if (body.decision !== "approved" && body.decision !== "denied") {
    jsonErrorResponse(res, 400, 'decision must be "approved" or "denied".', "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  const record = readJobRecord(jobId);
  if (!record) {
    jsonErrorResponse(res, 404, `Job not found: ${jobId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }

  const updated = resolveApprovalRequest(jobId, body.approval_id, body.decision, body.note);
  if (!updated) {
    jsonErrorResponse(res, 400, `Approval not found: ${body.approval_id}`, "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  const signaled = resolvePendingApproval(jobId, body.decision);
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: new Date().toISOString(),
    type: body.decision === "approved" ? "approval.approved" : "approval.denied",
    title: body.decision === "approved" ? "Approval granted" : "Approval denied",
    summary: body.decision === "approved"
      ? "A pending approval request was approved."
      : "A pending approval request was denied.",
    status: body.decision === "approved" ? "success" : "blocked",
    phase: "approval",
    meta: {
      approval_id: body.approval_id,
      note: body.note ?? "",
      signaled,
    },
  }));

  jsonResponse(res, 200, {
    ok: true,
    job_id: jobId,
    approval_id: body.approval_id,
    decision: body.decision,
    signaled,
    control: updated.control ?? {},
  });
}

export async function handleResumeJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonErrorResponse(res, 404, `Job not found: ${jobId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }

  if (record.job.status === "completed") {
    jsonErrorResponse(res, 400, "Cannot resume a completed job.", "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  if (record.job.status === "awaiting_approval" || record.control?.pendingApprovalId) {
    jsonErrorResponse(res, 409, "Job is awaiting approval. Resolve it through /approve instead of /resume.", "conflict_error", {
      status: "blocked",
    });
    return;
  }

  const active = getActiveJobSession(jobId);
  if (active) {
    jsonErrorResponse(res, 409, "Job is currently running.", "conflict_error", {
      status: "blocked",
    });
    return;
  }

  const resumeResult = await executeJobByMode(record.job.mode, record.job.goal, undefined, {
    requirePlannerCircuit: false,
  });
  updateJobControlState(jobId, {
    resumedAt: new Date().toISOString(),
    resumedToJobId: resumeResult.job.id,
  });
  const resumedRecord = updateJobControlState(resumeResult.job.id, {
    resumeOf: jobId,
  });
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: new Date().toISOString(),
    type: "job.resumed",
    title: "Job resumed",
    summary: `A resumed job was created: ${resumeResult.job.id}.`,
    status: "success",
    meta: {
      resumed_to_job_id: resumeResult.job.id,
    },
  }));

  jsonResponse(res, 200, {
    ok: true,
    resumed_from: jobId,
    job: resumeResult.job,
    plan: resumeResult.plan,
    taskRuns: resumeResult.taskRuns,
    artifacts: resumeResult.artifacts,
    control: resumedRecord?.control ?? { resumeOf: jobId },
  });
}
