import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listStoredJobs, persistJobRecord, readJobRecord, updateJobControlState, updateStoredJobRecord } from "../../src/job-store.js";
import { __testables } from "../../src/index.js";
import { registerActiveJobSession, unregisterActiveJobSession, resolvePendingApproval } from "../../src/job-runtime.js";
import { appendEvent } from "../../src/job-event-bus.js";
import { createUiEvent } from "../../src/workflow-ui-events.js";
import { NoHealthyExecutorError } from "../../src/model-health.js";
import { buildMinimalConfig } from "../helpers/fake-runtime.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, number | string | string[]>();
  body = "";

  setHeader(name: string, value: number | string | string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  write(chunk: unknown): boolean {
    this.body += String(chunk);
    return true;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) {
      this.body += String(chunk);
    }
    this.emit("finish");
    return this;
  }
}

test("team agent resolution uses config registry by default and env as override", () => {
  const config = buildMinimalConfig();
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
    },
    writer: {
      id: "writer",
      role: "write",
      model: {
        ...config.executor,
        model: "writer-model",
      },
    },
  };

  assert.deepEqual(__testables.resolveTeamAgents(config, undefined), [
    { name: "researcher", role: "research" },
    { name: "writer", role: "write" },
  ]);
  assert.deepEqual(__testables.resolveTeamAgents(config, JSON.stringify([{ name: "env_agent", role: "override" }])), [
    { name: "env_agent", role: "override" },
  ]);
});

test("registered role agent resolution exposes verifier routing metadata", () => {
  const config = buildMinimalConfig();
  config.agents = {
    qa_agent: {
      id: "qa_agent",
      role: "team verifier",
      model: {
        ...config.executor,
        model: "verifier-model",
      },
    },
  };

  assert.deepEqual(__testables.resolveRegisteredRoleAgent(config, "verifier"), {
    id: "qa_agent",
    role: "team verifier",
    model: "verifier-model",
  });
});

test("team approval gate persists ApprovalRequest and resolves through job runtime", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_team_gate_root",
    title: "Team Gate Root",
    description: "Root task",
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_team_gate",
    goal: "Approve team subtask",
    mode: "team",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_team_gate",
    goal: "Approve team subtask",
    mode: "team",
    status: "running",
    verified: false,
    output: "Running...",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
  const controller = new AbortController();
  registerActiveJobSession("job_team_gate", "Approve team subtask", controller);

  try {
    const gatePromise = __testables.createTeamApprovalGate("job_team_gate")([{
      id: "task_team_review",
      title: "Review before execution",
      description: "Needs approval",
      status: "awaiting_approval",
      assignee: "reviewer",
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    const pendingRecord = readJobRecord("job_team_gate");
    assert.equal(pendingRecord?.approvalRequests?.length, 1);
    assert.equal(pendingRecord?.approvalRequests?.[0]?.taskIds[0], "task_team_review");
    assert.equal(pendingRecord?.control?.approvalStatus, "pending");

    assert.equal(resolvePendingApproval("job_team_gate", "approved"), true);
    assert.equal(await gatePromise, true);
  } finally {
    unregisterActiveJobSession("job_team_gate");
  }
});

test("team approval mode requires async job creation", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
    goal: "Run a gated team job",
    mode: "team",
    policy: {
      approval_mode: "always",
    },
  }), res);
  const body = JSON.parse(res.body) as { error: { message: string; type: string } };

  assert.equal(res.statusCode, 400);
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.message.includes("policy.async=true"), true);
});

function buildAuthorizedRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
    },
  } as IncomingMessage;
}

function buildAuthorizedJsonRequest(url: string, body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(req, {
    method: "POST",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
      "content-type": "application/json",
    },
  });
  queueMicrotask(() => {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  });
  return req;
}

test("job store persists records and API returns job payload", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_job_test",
    title: "Task",
    description: "desc",
    status: "completed",
    verified: true,
    output: "done",
    attempts: 1,
    artifacts: [{ id: "artifact_job_test", type: "file", path: "runtime/test.txt", contentPreview: "done", source: "task_run" }],
  });
  const plan = createPlanRecord({
    id: "plan_job_test",
    goal: "Goal",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_api_test",
    goal: "Goal",
    mode: "task",
    status: "completed",
    verified: true,
    output: "done",
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
  });

  persistJobRecord({
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
  });

  const stored = readJobRecord(job.id);
  assert.notEqual(stored, null);
  assert.equal(stored?.job.id, job.id);

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${job.id}`), res);
  const body = JSON.parse(res.body) as { job: { id: string } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.job.id, job.id);
});

test("job list endpoint returns enriched items for dashboard consumers", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_job_list_dashboard",
    title: "Interrupted task",
    description: "Needs resume",
    status: "blocked",
    verified: false,
    output: "Execution was interrupted by a service restart.",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_job_list_dashboard",
    goal: "Show me in the dashboard",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_list_dashboard",
    goal: "Show me in the dashboard",
    mode: "task",
    status: "blocked",
    verified: false,
    output: "Execution was interrupted by a service restart.",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
  updateJobControlState(job.id, {
    recoveredAt: "2026-05-27T08:00:00.000Z",
    recoveryReason: "service_restart",
    autoResumeStatus: "failed",
    autoResumeAttemptedAt: "2026-05-27T08:00:05.000Z",
    autoResumeFailedAt: "2026-05-27T08:00:06.000Z",
    autoResumeFailureMessage: "planner unavailable",
  });

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs"), res);
  const body = JSON.parse(res.body) as {
    object: string;
    data: Array<{
      id: string;
      status: string;
      timeline_url?: string;
      events_url?: string;
      stream_url?: string;
      recovery?: {
        auto_resume_status?: string | null;
        auto_resume_failure_message?: string | null;
      } | null;
      actions?: Array<{ id?: string; href?: string; method?: string }>;
    }>;
  };

  assert.equal(res.statusCode, 200);
  assert.equal(body.object, "list");
  const item = body.data.find((entry) => entry.id === "job_list_dashboard");
  assert.equal(Boolean(item), true);
  assert.equal(item?.status, "blocked");
  assert.equal(item?.timeline_url, "/v1/jobs/job_list_dashboard/timeline");
  assert.equal(item?.events_url, "/v1/jobs/job_list_dashboard/events");
  assert.equal(item?.stream_url, "/v1/jobs/job_list_dashboard/stream");
  assert.equal(item?.recovery?.auto_resume_status, "failed");
  assert.equal(item?.recovery?.auto_resume_failure_message, "planner unavailable");
  assert.equal(item?.actions?.some((action) => action.id === "resume_now" && action.method === "POST" && action.href === "/v1/jobs/job_list_dashboard/resume"), true);
});

test("jobs dashboard endpoint renders persisted job overview html", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_job_dashboard_html",
    title: "Dashboard task",
    description: "Completed work",
    status: "completed",
    verified: true,
    output: "done",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_job_dashboard_html",
    goal: "Visible in dashboard HTML",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_dashboard_html",
    goal: "Visible in dashboard HTML",
    mode: "task",
    status: "completed",
    verified: true,
    output: "done",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/dashboard"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.body.includes("Job Dashboard"), true);
  assert.equal(res.body.includes("Visible in dashboard HTML"), false);
  assert.equal(res.body.includes("/jobs/job_dashboard_html/timeline"), false);
  assert.equal(res.body.includes("new URL('/jobs/data', window.location.origin)"), true);
  assert.equal(res.body.includes("page_size"), true);
});

test("browser dashboard wrapper renders without auth and polls browser data route", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    method: "GET",
    url: "/jobs/dashboard",
    headers: {},
  } as IncomingMessage, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.body.includes("Job Dashboard"), true);
  assert.equal(res.body.includes("new URL('/jobs/data', window.location.origin)"), true);
  assert.equal(res.body.includes("let jobs = []"), true);
});

test("browser jobs data route pages dashboard items", async () => {
  const suffix = randomUUID().slice(0, 8);
  for (let index = 0; index < 3; index += 1) {
    const taskRun = createTaskRunRecord({
      id: `taskrun_dashboard_page_${index}_${suffix}`,
      title: `Dashboard page task ${index}`,
      description: "Paged dashboard fixture",
      status: index === 1 ? "failed" : "completed",
      verified: index !== 1,
      output: "done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: `plan_dashboard_page_${index}_${suffix}`,
      goal: `Paged dashboard job ${index} ${suffix}`,
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: `job_dashboard_page_${index}_${suffix}`,
      goal: `Paged dashboard job ${index} ${suffix}`,
      mode: "task",
      status: index === 1 ? "failed" : "completed",
      verified: index !== 1,
      output: "done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
  }

  const firstPageRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/jobs/data?q=${suffix}&page=1&page_size=2`), firstPageRes);
  const firstPageBody = JSON.parse(firstPageRes.body) as {
    object: string;
    data: Array<{ id: string; status: string }>;
    pagination: { page: number; page_size: number; total: number; total_pages: number; has_next: boolean };
    counts: { by_status: Record<string, number> };
  };

  assert.equal(firstPageRes.statusCode, 200);
  assert.equal(firstPageBody.object, "list");
  assert.equal(firstPageBody.data.length, 2);
  assert.equal(firstPageBody.pagination.page, 1);
  assert.equal(firstPageBody.pagination.page_size, 2);
  assert.equal(firstPageBody.pagination.total, 3);
  assert.equal(firstPageBody.pagination.total_pages, 2);
  assert.equal(firstPageBody.pagination.has_next, true);
  assert.equal(firstPageBody.counts.by_status.completed, 2);
  assert.equal(firstPageBody.counts.by_status.failed, 1);

  const secondPageRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/jobs/data?q=${suffix}&page=2&page_size=2`), secondPageRes);
  const secondPageBody = JSON.parse(secondPageRes.body) as {
    data: Array<{ id: string }>;
    pagination: { page: number; has_next: boolean; has_prev: boolean };
  };

  assert.equal(secondPageRes.statusCode, 200);
  assert.equal(secondPageBody.data.length, 1);
  assert.equal(secondPageBody.pagination.page, 2);
  assert.equal(secondPageBody.pagination.has_prev, true);
  assert.equal(secondPageBody.pagination.has_next, false);
});

test("browser timeline wrapper streams through non-v1 route", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    method: "GET",
    url: "/jobs/job_dashboard_html/timeline",
    headers: {},
  } as IncomingMessage, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.body.includes("EventSource('/jobs/' + jobId + '/stream')"), true);
});

test("job artifacts endpoint returns artifact list and 404 for missing jobs", async () => {
  const jobId = "job_api_test";
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${jobId}/artifacts`), okRes);
  const okBody = JSON.parse(okRes.body) as { job_id: string; count: number; artifacts: Array<{ id: string }> };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, jobId);
  assert.equal(okBody.count > 0, true);

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/artifacts"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job steps endpoint returns task timeline with executor progress", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_steps_test",
    title: "Continue from artifact",
    description: "Worker produced a partial artifact before the model stopped.",
    status: "blocked",
    verified: false,
    output: "partial output",
    attempts: 1,
    artifacts: [{
      id: "artifact_steps_test",
      type: "json",
      path: "runtime/command-results/steps-test.json",
      contentPreview: "{\"ok\":true}",
      source: "executor",
      sourceTaskRunId: "taskrun_steps_test",
    }],
    executorHistory: [{
      status: "partial_success",
      summary: "Collected useful intermediate data.",
      tool_calls_made: [],
      artifacts: [{
        type: "json",
        path: "runtime/command-results/steps-test.json",
        content_preview: "{\"ok\":true}",
      }],
      raw_result: "partial output",
      error: "Model response was truncated.",
      source: "native_tool",
    }],
  });
  const plan = createPlanRecord({
    id: "plan_steps_test",
    goal: "Continue from partial progress",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_steps_test",
    goal: "Continue from partial progress",
    mode: "task",
    status: "blocked",
    verified: false,
    output: "partial output",
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: taskRun.artifacts });

  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${job.id}/steps`), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    count: number;
    steps: Array<{
      id: string;
      job_id: string;
      plan_id: string;
      latest_executor_status: string | null;
      executor_history: Array<{ status: string; artifacts: Array<{ path?: string }> }>;
    }>;
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, job.id);
  assert.equal(okBody.count, 1);
  assert.equal(okBody.steps[0]?.id, taskRun.id);
  assert.equal(okBody.steps[0]?.job_id, job.id);
  assert.equal(okBody.steps[0]?.plan_id, plan.id);
  assert.equal(okBody.steps[0]?.latest_executor_status, "partial_success");
  assert.equal(okBody.steps[0]?.executor_history[0]?.status, "partial_success");
  assert.equal(okBody.steps[0]?.executor_history[0]?.artifacts[0]?.path, "runtime/command-results/steps-test.json");

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/steps"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job create endpoint runs task mode through the control plane", async () => {
  __testables.setTaskExecutorForTests(async (goal, model, requirePlannerCircuit, context) => {
    assert.equal(goal, "Create a control-plane job");
    assert.equal(model, "dual-agent-orchestrator");
    assert.equal(requirePlannerCircuit, true);
    assert.equal(Boolean(context?.jobId), true);
    assert.equal(Boolean(context?.planId), true);
    assert.equal(Boolean(context?.taskRunId), true);

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Created Job Task",
      description: goal,
      status: "completed",
      verified: true,
      output: "created job done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "task",
      status: "completed",
      verified: true,
      output: "created job done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "created job done",
      logPath: "runtime/logs/create-job.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Create a control-plane job",
      mode: "task",
      model_route: "dual-agent-orchestrator",
      policy: {
        allow_network: true,
        allow_shell: true,
        approval_mode: "on_dangerous_only",
      },
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      resolved_model: string;
      log_path: string;
      step_count: number;
      job: { id: string; status: string; output: string };
      workflow: { job: { id: string } };
    };

    assert.equal(res.statusCode, 201);
    assert.equal(body.object, "job");
    assert.equal(body.resolved_model, "dual-agent-orchestrator");
    assert.equal(body.log_path, "runtime/logs/create-job.jsonl");
    assert.equal(body.step_count, 1);
    assert.equal(body.job.status, "completed");
    assert.equal(body.job.output, "created job done");
    assert.equal(body.workflow.job.id, body.job_id);
    assert.notEqual(readJobRecord(body.job_id), null);

    const invalidRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", { goal: "" }), invalidRes);
    const invalidBody = JSON.parse(invalidRes.body) as { error?: { type?: string } };
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidBody.error?.type, "invalid_request_error");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job create endpoint supports async start for realtime clients", async () => {
  __testables.setTaskExecutorForTests(async (goal, model, requirePlannerCircuit, context) => {
    assert.equal(goal, "Create an async control-plane job");
    assert.equal(model, "dual-agent-orchestrator");
    assert.equal(requirePlannerCircuit, true);
    context?.emitEvent?.({
      type: "workflow.step.start",
      step: 1,
      data: { replan_count: 0 },
    });
    context?.emitEvent?.({
      type: "workflow.planner.decision",
      step: 1,
      data: {
        status: "need_executor",
        reasoning_summary: "Search first, then summarize.",
        next_step: "Run web search",
        verdict: "not_applicable",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Async Job Task",
      description: goal,
      status: "completed",
      verified: true,
      output: "async job done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "task",
      status: "completed",
      verified: true,
      output: "async job done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    return {
      content: "async job done",
      logPath: "runtime/logs/create-job-async.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Create an async control-plane job",
      mode: "task",
      model_route: "dual-agent-orchestrator",
      policy: {
        async: true,
      },
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      status: string;
      accepted: boolean;
      stream_url: string;
      events_url: string;
      timeline_url: string;
      job: { id: string; status: string };
    };

    assert.equal(res.statusCode, 202);
    assert.equal(body.object, "job");
    assert.equal(body.accepted, true);
    assert.equal(body.job.status, "running");
    assert.equal(body.stream_url, `/v1/jobs/${body.job_id}/stream`);
    assert.equal(body.events_url, `/v1/jobs/${body.job_id}/events`);
    assert.equal(body.timeline_url, `/v1/jobs/${body.job_id}/timeline`);

    const streamRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(body.stream_url), streamRes);
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.body.includes("event: job.snapshot"), true);
    assert.equal(streamRes.body.includes("\"type\":\"job.created\""), true);
    streamRes.end();

    let completedRecord = readJobRecord(body.job_id);
    for (let i = 0; i < 30 && completedRecord?.job.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completedRecord = readJobRecord(body.job_id);
    }

    assert.equal(completedRecord?.job.status, "completed");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(body.events_url), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type: string }>;
    };
    assert.equal(eventsBody.events.some((event) => event.type === "planner.start"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "planner.decision"), true);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job create endpoint persists a running record before slow task execution finishes", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  __testables.setTaskExecutorForTests(async (goal, _model, _requirePlannerCircuit, context) => {
    await gate;
    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Slow Job Task",
      description: goal,
      status: "completed",
      verified: true,
      output: "slow job done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "task",
      status: "completed",
      verified: true,
      output: "slow job done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    return {
      content: "slow job done",
      logPath: "runtime/logs/create-job-running-dashboard.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Create a dashboard-visible running job",
      mode: "task",
      model_route: "dual-agent-orchestrator",
      policy: {
        async: true,
      },
    }), createRes);
    const createBody = JSON.parse(createRes.body) as { job_id: string };
    const runningRecord = readJobRecord(createBody.job_id);
    assert.equal(createRes.statusCode, 202);
    assert.equal(runningRecord?.job.status, "running");

    const listRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs"), listRes);
    const listBody = JSON.parse(listRes.body) as { data: Array<{ id: string; status: string }> };
    assert.equal(listBody.data.some((item) => item.id === createBody.job_id && item.status === "running"), true);

    const dashboardRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/dashboard"), dashboardRes);
    assert.equal(dashboardRes.statusCode, 200);
    assert.equal(dashboardRes.body.includes("new URL('/jobs/data', window.location.origin)"), true);
    assert.equal(dashboardRes.body.includes(createBody.job_id), false);

    const dashboardDataRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/jobs/data?q=${createBody.job_id}&page=1&page_size=50`), dashboardDataRes);
    const dashboardDataBody = JSON.parse(dashboardDataRes.body) as { data: Array<{ id: string; status: string; goal: string }> };
    assert.equal(dashboardDataBody.data.some((item) =>
      item.id === createBody.job_id
      && item.status === "running"
      && item.goal === "Create a dashboard-visible running job"), true);
  } finally {
    unblock();
    await new Promise((resolve) => setTimeout(resolve, 20));
    __testables.setTaskExecutorForTests(null);
  }
});

test("job create endpoint supports team mode with the same control-plane contract", async () => {
  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Coordinate a researcher and writer");
    assert.equal(model, "dual-agent-orchestrator");
    context?.emitEvent?.({
      type: "workflow.step.start",
      step: 1,
      data: { replan_count: 0 },
    });
    context?.emitEvent?.({
      type: "workflow.planner.decision",
      step: 1,
      data: {
        status: "workflow",
        reasoning_summary: "Split research and writing across the team.",
        next_step: "Dispatch team tasks",
        verdict: "approved",
      },
    });

    const researchTask = createTaskRunRecord({
      id: "taskrun_team_research",
      title: "Research",
      description: "Inspect source material",
      status: "completed",
      assignee: "researcher",
      verified: true,
      output: "research done",
      attempts: 1,
      artifacts: [],
    });
    const writeTask = createTaskRunRecord({
      id: "taskrun_team_write",
      title: "Write",
      description: "Produce summary",
      status: "completed",
      assignee: "writer",
      dependsOn: [researchTask.id],
      verified: true,
      output: "write done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [researchTask.id, writeTask.id],
      summary: "Team plan with 2 task runs.",
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team job done",
      plan,
      taskRuns: [researchTask, writeTask],
      artifacts: [],
      memorySummary: "shared context",
    });
    persistJobRecord({
      job,
      plan,
      taskRuns: [researchTask, writeTask],
      artifacts: [],
    });
    return {
      content: "team job done",
      logPath: "runtime/logs/create-team-job.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [researchTask, writeTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Coordinate a researcher and writer",
      mode: "team",
      model_route: "dual-agent-orchestrator",
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      job: { id: string; mode: string; status: string };
      plan: { mode: string };
      step_count: number;
    };

    assert.equal(res.statusCode, 201);
    assert.equal(body.object, "job");
    assert.equal(body.job.id, body.job_id);
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.plan.mode, "team");
    assert.equal(body.step_count, 2);
    const record = readJobRecord(body.job_id);
    assert.notEqual(record, null);
    assert.equal(record?.job.verificationResult?.status, "verified");
    assert.equal(record?.job.verificationResult?.checks.length, 6);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${body.job_id}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as { events: Array<{ type: string; agent: string; status: string; meta?: Record<string, unknown> }> };
    const verificationEvent = eventsBody.events.find((event) => event.type === "system.verification_passed");
    assert.equal(Boolean(verificationEvent), true);
    assert.equal(verificationEvent?.agent, "system");
    assert.equal(verificationEvent?.status, "success");
    const checkEvent = eventsBody.events.find((event) => event.type === "system.verification_check_passed" && event.meta?.verification_check_name === "artifact_presence");
    assert.equal(Boolean(checkEvent), true);
    assert.equal(checkEvent?.agent, "verifier");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("team job create endpoint applies shared verifier result", async () => {
  __testables.setTeamExecutorForTests(async (goal, _model, context) => {
    const teamTask = createTaskRunRecord({
      id: "taskrun_team_verifier_failure",
      title: "Tool-backed team task",
      description: goal,
      status: "completed",
      assignee: "researcher",
      verified: true,
      output: "tool completed without artifacts",
      attempts: 1,
      artifacts: [],
      executorHistory: [{
        status: "success",
        summary: "tool ok",
        tool_calls_made: [{ tool: "read_file", arguments: { path: "missing.txt" } }],
        artifacts: [],
        raw_result: "tool ok",
      }],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [teamTask.id],
      summary: "Team verifier failure plan.",
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team verifier failure",
      plan,
      taskRuns: [teamTask],
      artifacts: [],
    });
    return {
      content: "team verifier failure",
      logPath: "runtime/logs/create-team-job-verifier-failure.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [teamTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Run a team job with verifier failure",
      mode: "team",
      model_route: "dual-agent-orchestrator",
    }), res);
    const body = JSON.parse(res.body) as {
      job_id: string;
      job: { mode: string; status: string; verified: boolean };
    };

    assert.equal(res.statusCode, 201);
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.job.verified, false);

    const record = readJobRecord(body.job_id);
    assert.equal(record?.job.verified, false);
    assert.equal(record?.job.verificationResult?.status, "insufficient");
    assert.equal(record?.job.verificationResult?.checks.some((check) => check.name === "artifact_presence" && check.status === "insufficient"), true);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${body.job_id}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as { events: Array<{ type: string; status: string }> };
    const verificationEvent = eventsBody.events.find((event) => event.type === "system.verification_failed");
    assert.equal(Boolean(verificationEvent), true);
    assert.equal(verificationEvent?.status, "blocked");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job create endpoint supports async team mode", async () => {
  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Run an async team job");
    assert.equal(model, "dual-agent-orchestrator");
    context?.emitEvent?.({
      type: "workflow.step.start",
      step: 1,
      data: { replan_count: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const teamTask = createTaskRunRecord({
      id: "taskrun_async_team_root",
      title: "Team Root Task",
      description: goal,
      status: "completed",
      assignee: "planner",
      verified: true,
      output: "async team done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [teamTask.id],
      summary: "Async team plan.",
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "async team done",
      plan,
      taskRuns: [teamTask],
      artifacts: [],
      memorySummary: "async team memory",
    });
    return {
      content: "async team done",
      logPath: "runtime/logs/create-team-job-async.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [teamTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Run an async team job",
      mode: "team",
      model_route: "dual-agent-orchestrator",
      policy: {
        async: true,
      },
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      accepted: boolean;
      job: { mode: string; status: string };
    };

    assert.equal(res.statusCode, 202);
    assert.equal(body.object, "job");
    assert.equal(body.accepted, true);
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "running");

    let completedRecord = readJobRecord(body.job_id);
    for (let i = 0; i < 30 && completedRecord?.job.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completedRecord = readJobRecord(body.job_id);
    }

    assert.equal(completedRecord?.job.mode, "team");
    assert.equal(completedRecord?.job.status, "completed");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job runtime profile endpoint exposes platform and tool capabilities", async () => {
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/runtime-profile"), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    diagnostics_summary: {
      dependency_warnings: number;
      dependency_checks: number;
    };
    runtime_profile: {
      platform: { os: string; shell: string };
      filesystem: { workspaceRoot: string; runtimeRoot: string };
      diagnostics: {
        dependencyChecks: Array<{ name: string; status: string }>;
      };
      tools: Array<{ name: string; fallbackOnly?: boolean }>;
    };
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, "job_steps_test");
  assert.equal(typeof okBody.runtime_profile.platform.os, "string");
  assert.equal(typeof okBody.runtime_profile.platform.shell, "string");
  assert.equal(Boolean(okBody.runtime_profile.filesystem.workspaceRoot), true);
  assert.equal(Boolean(okBody.runtime_profile.filesystem.runtimeRoot), true);
  assert.equal(typeof okBody.diagnostics_summary.dependency_warnings, "number");
  assert.equal(typeof okBody.diagnostics_summary.dependency_checks, "number");
  assert.equal(okBody.runtime_profile.diagnostics.dependencyChecks.length > 0, true);
  assert.equal(okBody.runtime_profile.tools.some((tool) => tool.name === "read_file"), true);
  assert.equal(okBody.runtime_profile.tools.some((tool) => tool.name === "shell_command" && tool.fallbackOnly === true), true);

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/runtime-profile"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job events endpoint reconstructs job timeline from persisted state", async () => {
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    count: number;
    snapshot: null | {
      job_id: string;
      event_count: number;
      replay?: { next_seq?: number; can_resume_from?: number };
    };
    events: Array<{ type: string; jobId: string; taskRunId?: string; agent: string; status: string; meta?: Record<string, unknown> }>;
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, "job_steps_test");
  assert.equal(okBody.count, okBody.events.length);
  assert.equal(okBody.events.some((event) => event.type === "job.created"), true);
  assert.equal(okBody.events.some((event) => event.type === "plan.created"), true);
  assert.equal(okBody.events.some((event) => event.type === "step.blocked" && event.taskRunId === "taskrun_steps_test"), true);
  assert.equal(okBody.events.some((event) => event.type === "executor.partial_success" && event.taskRunId === "taskrun_steps_test"), true);
  assert.equal(okBody.events.some((event) => event.type === "artifact.created" && event.taskRunId === "taskrun_steps_test"), true);
  assert.equal(okBody.events.every((event) => typeof event.jobId === "string" && typeof event.agent === "string"), true);
  assert.equal(okBody.snapshot?.job_id, "job_steps_test");
  assert.equal(typeof okBody.snapshot?.replay?.next_seq, "number");
  assert.equal(typeof okBody.snapshot?.replay?.can_resume_from, "number");

  const cancelRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_steps_test/cancel"),
    method: "POST",
  } as IncomingMessage, cancelRes);
  assert.equal(cancelRes.statusCode, 200);

  const afterCancelRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), afterCancelRes);
  const afterCancelBody = JSON.parse(afterCancelRes.body) as { events: Array<{ type: string }> };
  assert.equal(afterCancelBody.events.some((event) => event.type === "job.cancelled"), true);

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/events"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job events endpoint keeps snapshot replay cursor global when using since_seq", async () => {
  const allEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), allEventsRes);
  const allEventsBody = JSON.parse(allEventsRes.body) as {
    snapshot: {
      seq: number;
      event_count: number;
      replay?: { next_seq?: number; can_resume_from?: number };
    } | null;
    events: Array<{ seq: number; type: string }>;
  };
  const cursor = allEventsBody.events.find((event) => event.type === "plan.created")?.seq ?? 0;

  const filteredRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/job_steps_test/events?since_seq=${cursor}`), filteredRes);
  const filteredBody = JSON.parse(filteredRes.body) as {
    count: number;
    snapshot: {
      seq: number;
      event_count: number;
      replay?: { next_seq?: number; can_resume_from?: number };
    } | null;
    events: Array<{ seq: number; type: string }>;
  };

  assert.equal(filteredRes.statusCode, 200);
  assert.equal(filteredBody.events.every((event) => event.seq > cursor), true);
  assert.equal((filteredBody.snapshot?.seq ?? 0) >= (filteredBody.events.at(-1)?.seq ?? 0), true);
  assert.equal(filteredBody.snapshot?.seq, allEventsBody.snapshot?.seq);
  assert.equal(filteredBody.snapshot?.event_count, allEventsBody.snapshot?.event_count);
  assert.equal(filteredBody.snapshot?.replay?.next_seq, allEventsBody.snapshot?.replay?.next_seq);
  assert.equal(filteredBody.snapshot?.replay?.can_resume_from, allEventsBody.snapshot?.replay?.can_resume_from);
});

test("job events endpoint keeps snapshot replay cursor global when limit truncates the window", async () => {
  const allEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), allEventsRes);
  const allEventsBody = JSON.parse(allEventsRes.body) as {
    snapshot: {
      seq: number;
      event_count: number;
      replay?: { next_seq?: number; can_resume_from?: number };
    } | null;
    events: Array<{ seq: number }>;
  };

  const limitedRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events?limit=2"), limitedRes);
  const limitedBody = JSON.parse(limitedRes.body) as {
    count: number;
    snapshot: {
      seq: number;
      event_count: number;
      replay?: { next_seq?: number; can_resume_from?: number };
    } | null;
    events: Array<{ seq: number }>;
  };

  assert.equal(limitedRes.statusCode, 200);
  assert.equal(limitedBody.count, 2);
  assert.equal(limitedBody.events.length, 2);
  assert.equal((limitedBody.snapshot?.seq ?? 0) > (limitedBody.events.at(-1)?.seq ?? 0), true);
  assert.equal(limitedBody.snapshot?.seq, allEventsBody.snapshot?.seq);
  assert.equal(limitedBody.snapshot?.event_count, allEventsBody.snapshot?.event_count);
  assert.equal(limitedBody.snapshot?.replay?.next_seq, allEventsBody.snapshot?.replay?.next_seq);
  assert.equal(limitedBody.snapshot?.replay?.can_resume_from, allEventsBody.snapshot?.replay?.can_resume_from);
});

test("job events endpoint filters by type status seq and paginates results", async () => {
  const allEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), allEventsRes);
  const allEventsBody = JSON.parse(allEventsRes.body) as {
    events: Array<{ seq: number; type: string; status: string }>;
  };
  const artifactEvent = allEventsBody.events.find((event) => event.type === "artifact.created");
  assert.equal(Boolean(artifactEvent), true);

  const filteredRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/job_steps_test/events?type=artifact.created&status=${artifactEvent?.status}&seq=${artifactEvent?.seq}&page=1&page_size=1`), filteredRes);
  const filteredBody = JSON.parse(filteredRes.body) as {
    count: number;
    total: number;
    filters?: { type?: string[]; status?: string[]; seq?: number | null };
    pagination?: { page?: number; page_size?: number; total?: number; total_pages?: number };
    events: Array<{ seq: number; type: string; status: string }>;
  };

  assert.equal(filteredRes.statusCode, 200);
  assert.equal(filteredBody.count, 1);
  assert.equal(filteredBody.total, 1);
  assert.deepEqual(filteredBody.filters?.type, ["artifact.created"]);
  assert.deepEqual(filteredBody.filters?.status, [artifactEvent?.status]);
  assert.equal(filteredBody.filters?.seq, artifactEvent?.seq);
  assert.equal(filteredBody.pagination?.page, 1);
  assert.equal(filteredBody.pagination?.page_size, 1);
  assert.equal(filteredBody.events[0]?.seq, artifactEvent?.seq);
});

test("job events endpoint rejects invalid replay query parameters", async () => {
  const invalidSinceSeqRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events?since_seq=abc"), invalidSinceSeqRes);
  const invalidSinceSeqBody = JSON.parse(invalidSinceSeqRes.body) as { error?: { type?: string; message?: string } };

  assert.equal(invalidSinceSeqRes.statusCode, 400);
  assert.equal(invalidSinceSeqBody.error?.type, "invalid_request_error");
  assert.equal(invalidSinceSeqBody.error?.message, "since_seq must be a non-negative integer.");

  const invalidLimitRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events?limit=-1"), invalidLimitRes);
  const invalidLimitBody = JSON.parse(invalidLimitRes.body) as { error?: { type?: string; message?: string } };

  assert.equal(invalidLimitRes.statusCode, 400);
  assert.equal(invalidLimitBody.error?.type, "invalid_request_error");
  assert.equal(invalidLimitBody.error?.message, "limit must be a non-negative integer.");
});

test("job stream endpoint replays standardized timeline events and snapshot", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/stream"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(String(res.headers.get("content-type")).includes("text/event-stream"), true);
  assert.equal(res.body.includes("event: job.snapshot"), true);
  assert.equal(res.body.includes("event: job.event"), true);
  assert.equal(res.body.includes("\"type\":\"executor.partial_success\""), true);
  assert.equal(res.body.includes("\"replayed_count\""), true);
  assert.equal(res.body.includes("id: "), true);

  res.end();
});

test("job stream emits redirect metadata for resumed jobs", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_stream_resumed_source",
    title: "Resumed source",
    description: "source",
    status: "blocked",
    verified: false,
    output: "interrupted",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_stream_resumed_source",
    goal: "Follow resumed stream",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_stream_resumed_source",
    goal: "Follow resumed stream",
    mode: "task",
    status: "blocked",
    verified: false,
    output: "interrupted",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  persistJobRecord({
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  updateJobControlState(job.id, {
    recoveredAt: new Date().toISOString(),
    recoveryReason: "service_restart",
    resumedToJobId: "job_stream_resumed_target",
  });

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_stream_resumed_source/stream"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes("event: job.redirect"), true);
  assert.equal(res.body.includes("\"job_id\":\"job_stream_resumed_target\""), true);
  assert.equal(res.body.includes("\"stream_url\":\"/v1/jobs/job_stream_resumed_target/stream\""), true);

  res.end();
});

test("job stream supports since_seq replay and Last-Event-ID resume", async () => {
  const allEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), allEventsRes);
  const allEventsBody = JSON.parse(allEventsRes.body) as {
    events: Array<{ seq: number; type: string }>;
  };
  const cursor = allEventsBody.events.find((event) => event.type === "plan.created")?.seq ?? 0;

  const sinceSeqRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest(`/v1/jobs/job_steps_test/stream?since_seq=${cursor}`),
  } as IncomingMessage, sinceSeqRes);

  assert.equal(sinceSeqRes.statusCode, 200);
  assert.equal(sinceSeqRes.body.includes(`"resumed_from_seq":${cursor}`), true);
  assert.equal(sinceSeqRes.body.includes('"replayed_count"'), true);
  assert.equal(sinceSeqRes.body.includes('"type":"job.created"'), false);

  sinceSeqRes.end();

  const lastEventIdRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_steps_test/stream"),
    headers: {
      authorization: "Bearer dual-agent-local",
      "last-event-id": String(cursor),
    },
  } as IncomingMessage, lastEventIdRes);

  assert.equal(lastEventIdRes.statusCode, 200);
  assert.equal(lastEventIdRes.body.includes(`"resumed_from_seq":${cursor}`), true);
  assert.equal(lastEventIdRes.body.includes('"type":"job.created"'), false);

  lastEventIdRes.end();
});

test("job stream endpoint filters replay events by type status seq and page", async () => {
  const allEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), allEventsRes);
  const allEventsBody = JSON.parse(allEventsRes.body) as {
    events: Array<{ seq: number; type: string; status: string }>;
  };
  const artifactEvent = allEventsBody.events.find((event) => event.type === "artifact.created");
  assert.equal(Boolean(artifactEvent), true);

  const streamRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/job_steps_test/stream?type=artifact.created&status=${artifactEvent?.status}&seq=${artifactEvent?.seq}&page=1&page_size=1`), streamRes);

  assert.equal(streamRes.statusCode, 200);
  assert.equal(streamRes.body.includes("event: job.snapshot"), true);
  assert.equal(streamRes.body.includes('"filtered_count":1'), true);
  assert.equal(streamRes.body.includes('"page":1'), true);
  assert.equal(streamRes.body.includes('"page_size":1'), true);
  assert.equal(streamRes.body.includes('"type":"artifact.created"'), true);
  assert.equal(streamRes.body.includes('"type":"job.created"'), false);
  streamRes.end();
});

test("job stream rejects invalid replay cursors", async () => {
  const invalidSinceSeqRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/stream?since_seq=-1"), invalidSinceSeqRes);
  const invalidSinceSeqBody = JSON.parse(invalidSinceSeqRes.body) as { error?: { type?: string; message?: string } };

  assert.equal(invalidSinceSeqRes.statusCode, 400);
  assert.equal(invalidSinceSeqBody.error?.type, "invalid_request_error");
  assert.equal(invalidSinceSeqBody.error?.message, "since_seq must be a non-negative integer.");

  const invalidLastEventIdRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_steps_test/stream"),
    headers: {
      authorization: "Bearer dual-agent-local",
      "last-event-id": "oops",
    },
  } as IncomingMessage, invalidLastEventIdRes);
  const invalidLastEventIdBody = JSON.parse(invalidLastEventIdRes.body) as { error?: { type?: string; message?: string } };

  assert.equal(invalidLastEventIdRes.statusCode, 400);
  assert.equal(invalidLastEventIdBody.error?.type, "invalid_request_error");
  assert.equal(invalidLastEventIdBody.error?.message, "Last-Event-ID must be a non-negative integer.");
});

test("job stream replays verification check events", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_stream_verification_check",
    title: "Verify evidence",
    description: "Verify evidence artifacts",
    status: "completed",
    assignee: "verifier",
    verified: true,
    output: "Verification passed.",
    attempts: 1,
    artifacts: [],
    verificationResult: {
      status: "verified",
      summary: "Verification completed successfully.",
      checks: [
        { name: "artifact_presence", passed: true, status: "passed", detail: "1 artifact present with content." },
      ],
    },
  });
  const plan = createPlanRecord({
    id: "plan_stream_verification_check",
    goal: "Stream verification check events",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_stream_verification_check",
    goal: "Stream verification check events",
    mode: "task",
    status: "completed",
    verified: true,
    output: "done",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
    verificationResult: taskRun.verificationResult,
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });

  const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_stream_verification_check/events"), eventsRes);
  const eventsBody = JSON.parse(eventsRes.body) as {
    events: Array<{ seq: number; type: string; meta?: Record<string, unknown> }>;
  };

  const checkEvent = eventsBody.events.find((event) => event.type.startsWith("system.verification_check_"));
  assert.equal(Boolean(checkEvent), true);

  const streamRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_stream_verification_check/stream"), streamRes);
  assert.equal(streamRes.statusCode, 200);
  assert.equal(streamRes.body.includes("event: job.event"), true);
  assert.equal(streamRes.body.includes("system.verification_check_"), true);
  assert.equal(streamRes.body.includes("verification_check_name"), true);
  streamRes.end();

  const replayCursor = Math.max(0, (checkEvent?.seq ?? 1) - 1);
  const replayRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_stream_verification_check/stream"),
    headers: {
      authorization: "Bearer dual-agent-local",
      "last-event-id": String(replayCursor),
    },
  } as IncomingMessage, replayRes);
  assert.equal(replayRes.statusCode, 200);
  assert.equal(replayRes.body.includes(`"resumed_from_seq":${replayCursor}`), true);
  assert.equal(replayRes.body.includes("system.verification_check_"), true);
  replayRes.end();
});

test("job events and stream expose team agent registry and verifier fallback", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_team_observability",
    title: "Inspect",
    description: "Inspect files",
    status: "completed",
    assignee: "researcher",
    verified: true,
    output: "done",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_team_observability",
    goal: "Team observability",
    mode: "team",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_team_observability",
    goal: "Team observability",
    mode: "team",
    status: "completed",
    verified: true,
    output: "done",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
  appendEvent(createUiEvent({
    jobId: job.id,
    seq: 1,
    agent: "system",
    phase: "start",
    type: "system.team_agent_registry_snapshot",
    title: "Team agent registry captured",
    summary: "Runtime team agent role status was captured for this run.",
    status: "running",
    meta: {
      roles: [
        { role: "verifier", status: "fallback", fallback_to: "system_verifiers" },
      ],
    },
  }));
  appendEvent(createUiEvent({
    jobId: job.id,
    seq: 2,
    agent: "verifier",
    phase: "result",
    type: "system.team_verifier_fallback",
    title: "Verifier fallback active",
    summary: "No registered verifier agent was found; using deterministic system checks.",
    status: "partial_success",
    taskRunId: taskRun.id,
    meta: {
      role: "verifier",
      task_id: taskRun.id,
      fallback: "system_verifiers",
      reason: "No registered verifier agent was found; using deterministic system checks.",
    },
  }));

  const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_team_observability/events?type=system.team_verifier_fallback"), eventsRes);
  const eventsBody = JSON.parse(eventsRes.body) as {
    events: Array<{ type: string; meta?: Record<string, unknown> }>;
  };
  assert.equal(eventsBody.events.some((event) => event.type === "system.team_verifier_fallback"), true);
  assert.equal(eventsBody.events[0]?.meta?.fallback, "system_verifiers");

  const jobRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_team_observability"), jobRes);
  const jobBody = JSON.parse(jobRes.body) as { team_agent_registry?: { roles?: Array<{ role?: string; status?: string }> } };
  assert.equal(jobBody.team_agent_registry?.roles?.some((entry) => entry.role === "verifier" && entry.status === "fallback"), true);

  const streamRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_team_observability/stream"), streamRes);
  assert.equal(streamRes.statusCode, 200);
  assert.equal(streamRes.body.includes("system.team_verifier_fallback"), true);
  assert.equal(streamRes.body.includes("system.team_agent_registry_snapshot"), true);
  streamRes.end();
});

test("job cancel endpoint updates control metadata", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_api_test/cancel"),
    method: "POST",
  } as IncomingMessage, res);
  const body = JSON.parse(res.body) as { ok: boolean; control: { cancelledAt?: string } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.control.cancelledAt, "string");
});

test("job retry endpoint creates a new stored job and links retry metadata", async () => {
  __testables.setTaskExecutorForTests(async () => {
    const taskRun = createTaskRunRecord({
      id: "taskrun_retry_new",
      title: "Retry Task",
      description: "retry desc",
      status: "completed",
      verified: true,
      output: "retry done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: "plan_retry_new",
      goal: "Goal",
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: "job_retry_new",
      goal: "Goal",
      mode: "task",
      status: "completed",
      verified: true,
      output: "retry done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "retry done",
      logPath: "runtime/logs/retry.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_api_test/retry"),
      method: "POST",
    } as IncomingMessage, res);
    const body = JSON.parse(res.body) as { ok: boolean; retried_from: string; job: { id: string }; control: { retryOf?: string } };

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.retried_from, "job_api_test");
    assert.equal(body.job.id, "job_retry_new");
    assert.equal(body.control.retryOf, "job_api_test");

    const original = readJobRecord("job_api_test");
    assert.equal(original?.control?.retriedToJobId, "job_retry_new");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job retry endpoint preserves team mode", async () => {
  const teamTask = createTaskRunRecord({
    id: "taskrun_team_retry_source",
    title: "Team Retry Source",
    description: "retry team desc",
    status: "failed",
    assignee: "planner",
    verified: false,
    output: "team retry source failed",
    attempts: 1,
    artifacts: [],
  });
  const teamPlan = createPlanRecord({
    id: "plan_team_retry_source",
    goal: "Retry this team job",
    mode: "team",
    taskRunIds: [teamTask.id],
    summary: "Team retry source plan.",
  });
  const teamJob = createJobRecord({
    id: "job_team_retry_source",
    goal: "Retry this team job",
    mode: "team",
    status: "failed",
    verified: false,
    output: "team retry source failed",
    plan: teamPlan,
    taskRuns: [teamTask],
    artifacts: [],
    memorySummary: "team retry source memory",
  });
  persistJobRecord({
    job: teamJob,
    plan: teamPlan,
    taskRuns: [teamTask],
    artifacts: [],
  });

  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Retry this team job");
    assert.equal(model, undefined);
    const retriedTask = createTaskRunRecord({
      id: "taskrun_team_retry_new",
      title: "Retried Team Task",
      description: "retried team desc",
      status: "completed",
      assignee: "planner",
      verified: true,
      output: "team retry done",
      attempts: 1,
      artifacts: [],
    });
    const retriedPlan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [retriedTask.id],
      summary: "Retried team plan.",
    });
    const retriedJob = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team retry done",
      plan: retriedPlan,
      taskRuns: [retriedTask],
      artifacts: [],
      memorySummary: "team retry memory",
    });
    return {
      content: "team retry done",
      logPath: "runtime/logs/team-retry.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job: retriedJob,
      plan: retriedPlan,
      taskRuns: [retriedTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_team_retry_source/retry"),
      method: "POST",
    } as IncomingMessage, res);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      retried_from: string;
      job: { id: string; mode: string; status: string };
      control: { retryOf?: string };
    };

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.retried_from, "job_team_retry_source");
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.control.retryOf, "job_team_retry_source");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job cancel endpoint interrupts an active running job", async () => {
  let activeJobId = "";
  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    activeJobId = context?.jobId ?? "";
    await new Promise<void>((resolve, reject) => {
      if (!context) {
        reject(new Error("Missing execution context"));
        return;
      }
      context.signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      }, { once: true });
    });
    throw new Error("unreachable");
  });

  try {
    const retryRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    const retryPromise = __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_api_test/retry"),
      method: "POST",
    } as IncomingMessage, retryRes);

    for (let i = 0; i < 50 && !activeJobId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(Boolean(activeJobId), true);

    const cancelRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest(`/v1/jobs/${activeJobId}/cancel`),
      method: "POST",
    } as IncomingMessage, cancelRes);
    const cancelBody = JSON.parse(cancelRes.body) as { interrupted: boolean; active: boolean; control: { cancelledAt?: string } };
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelBody.active, true);
    assert.equal(cancelBody.interrupted, true);
    assert.equal(typeof cancelBody.control.cancelledAt, "string");

    await retryPromise;
    assert.equal(retryRes.statusCode >= 400, true);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job approve endpoint resolves pending approval and records lifecycle metadata", async () => {
  const approvalTask = createTaskRunRecord({
    id: "taskrun_approval_api",
    title: "Approval Gate",
    description: "Wait for reviewer approval",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    attempts: 0,
    artifacts: [],
  });
  const approvalPlan = createPlanRecord({
    id: "plan_approval_api",
    goal: "Approval workflow",
    mode: "task",
    taskRunIds: [approvalTask.id],
    summary: "Approval workflow plan.",
  });
  const approvalJob = createJobRecord({
    id: "job_approval_api",
    goal: "Approval workflow",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  persistJobRecord({
    job: approvalJob,
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  updateStoredJobRecord("job_approval_api", (record) => ({
    ...record,
    approvalRequests: [{
      id: "appr_api_1",
      jobId: "job_approval_api",
      taskIds: [approvalTask.id],
      reason: "Approve the workflow",
      status: "pending",
      createdAt: new Date().toISOString(),
    }],
    control: {
      pendingApprovalId: "appr_api_1",
      approvalStatus: "pending",
    },
  }));

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs/job_approval_api/approve", {
    approval_id: "appr_api_1",
    decision: "approved",
    note: "looks good",
  }), res);
  const body = JSON.parse(res.body) as {
    ok: boolean;
    approval_id: string;
    decision: string;
    signaled: boolean;
    control: { approvalStatus?: string; pendingApprovalId?: string };
  };

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.approval_id, "appr_api_1");
  assert.equal(body.decision, "approved");
  assert.equal(body.signaled, false);
  assert.equal(body.control.approvalStatus, "approved");
  assert.equal(body.control.pendingApprovalId, undefined);

  const updated = readJobRecord("job_approval_api");
  assert.equal(updated?.approvalRequests?.[0]?.status, "approved");
  assert.equal(updated?.approvalRequests?.[0]?.responseNote, "looks good");

  const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_approval_api/events"), eventsRes);
  const eventsBody = JSON.parse(eventsRes.body) as {
    events: Array<{ type: string; meta?: Record<string, unknown> }>;
  };
  const approvalEvent = eventsBody.events.find((event) => event.type === "approval.approved");
  assert.equal(Boolean(approvalEvent), true);
  assert.equal(approvalEvent?.meta?.approval_id, "appr_api_1");
});

test("job resume endpoint creates a resumed job and blocks awaiting approval jobs", async () => {
  const blockedTask = createTaskRunRecord({
    id: "taskrun_resume_source",
    title: "Blocked Task",
    description: "Needs later resume",
    status: "blocked",
    verified: false,
    output: "blocked output",
    attempts: 1,
    artifacts: [],
  });
  const blockedPlan = createPlanRecord({
    id: "plan_resume_source",
    goal: "Resume me",
    mode: "task",
    taskRunIds: [blockedTask.id],
  });
  const blockedJob = createJobRecord({
    id: "job_resume_source",
    goal: "Resume me",
    mode: "task",
    status: "blocked",
    verified: false,
    output: "blocked output",
    plan: blockedPlan,
    taskRuns: [blockedTask],
    artifacts: [],
  });
  persistJobRecord({
    job: blockedJob,
    plan: blockedPlan,
    taskRuns: [blockedTask],
    artifacts: [],
  });

  const approvalTask = createTaskRunRecord({
    id: "taskrun_resume_waiting",
    title: "Approval Wait",
    description: "Should not resume directly",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    attempts: 0,
    artifacts: [],
  });
  const approvalPlan = createPlanRecord({
    id: "plan_resume_waiting",
    goal: "Await approval first",
    mode: "task",
    taskRunIds: [approvalTask.id],
  });
  const approvalJob = createJobRecord({
    id: "job_resume_waiting",
    goal: "Await approval first",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  persistJobRecord({
    job: approvalJob,
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  updateStoredJobRecord("job_resume_waiting", (record) => ({
    ...record,
    control: {
      ...record.control,
      pendingApprovalId: "appr_resume_waiting",
      approvalStatus: "pending",
    },
    approvalRequests: [{
      id: "appr_resume_waiting",
      jobId: "job_resume_waiting",
      taskIds: [approvalTask.id],
      reason: "Approve before resume",
      status: "pending",
      createdAt: new Date().toISOString(),
    }],
  }));

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Resumed Task",
      description: "resumed desc",
      status: "completed",
      verified: true,
      output: "resumed done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal: "Resume me",
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal: "Resume me",
      mode: "task",
      status: "completed",
      verified: true,
      output: "resumed done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "resumed done",
      logPath: "runtime/logs/resume.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const resumeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_resume_source/resume"),
      method: "POST",
    } as IncomingMessage, resumeRes);
    const resumeBody = JSON.parse(resumeRes.body) as {
      ok: boolean;
      resumed_from: string;
      job: { id: string };
      control: { resumeOf?: string };
    };

    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeBody.ok, true);
    assert.equal(resumeBody.resumed_from, "job_resume_source");
    assert.equal(resumeBody.control.resumeOf, "job_resume_source");

    const sourceRecord = readJobRecord("job_resume_source");
    assert.equal(sourceRecord?.control?.resumedToJobId, resumeBody.job.id);
    assert.equal(typeof sourceRecord?.control?.resumedAt, "string");

    const resumedRecord = readJobRecord(resumeBody.job.id);
    assert.equal(resumedRecord?.control?.resumeOf, "job_resume_source");

    const waitingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_resume_waiting/resume"),
      method: "POST",
    } as IncomingMessage, waitingRes);
    const waitingBody = JSON.parse(waitingRes.body) as { error?: { type?: string; message?: string } };

    assert.equal(waitingRes.statusCode, 409);
    assert.equal(waitingBody.error?.type, "conflict_error");
    assert.equal(waitingBody.error?.message?.includes("/approve"), true);
    assert.equal(waitingBody.error?.failure_category, "approval_blocked");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job resume endpoint preserves team mode", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_team_resume_source",
    title: "Team Resume Source",
    description: "Needs team resume",
    status: "blocked",
    assignee: "planner",
    verified: false,
    output: "team resume source blocked",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_team_resume_source",
    goal: "Resume this team job",
    mode: "team",
    taskRunIds: [taskRun.id],
    summary: "Team resume source plan.",
  });
  const job = createJobRecord({
    id: "job_team_resume_source",
    goal: "Resume this team job",
    mode: "team",
    status: "blocked",
    verified: false,
    output: "team resume source blocked",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
    memorySummary: "team resume source memory",
  });
  persistJobRecord({
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Resume this team job");
    assert.equal(model, undefined);
    const resumedTask = createTaskRunRecord({
      id: "taskrun_team_resume_new",
      title: "Resumed Team Task",
      description: "resumed team desc",
      status: "completed",
      assignee: "planner",
      verified: true,
      output: "team resumed done",
      attempts: 1,
      artifacts: [],
    });
    const resumedPlan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [resumedTask.id],
      summary: "Resumed team plan.",
    });
    const resumedJob = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team resumed done",
      plan: resumedPlan,
      taskRuns: [resumedTask],
      artifacts: [],
      memorySummary: "team resumed memory",
    });
    return {
      content: "team resumed done",
      logPath: "runtime/logs/team-resume.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job: resumedJob,
      plan: resumedPlan,
      taskRuns: [resumedTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_team_resume_source/resume"),
      method: "POST",
    } as IncomingMessage, res);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      resumed_from: string;
      job: { id: string; mode: string; status: string };
      control: { resumeOf?: string };
    };

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.resumed_from, "job_team_resume_source");
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.control.resumeOf, "job_team_resume_source");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job events snapshot summarizes failure categories for diagnostics", async () => {
  const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), eventsRes);
  const body = JSON.parse(eventsRes.body) as {
    snapshot?: {
      failure_summary?: {
        total?: number;
        by_category?: Record<string, number>;
        latest_category?: string | null;
      };
    };
  };

  assert.equal(eventsRes.statusCode, 200);
  assert.equal((body.snapshot?.failure_summary?.total ?? 0) > 0, true);
  assert.equal(Object.keys(body.snapshot?.failure_summary?.by_category ?? {}).length > 0, true);
  assert.equal(typeof body.snapshot?.failure_summary?.latest_category, "string");
});

test("restart recovery auto-resumes interrupted running jobs and preserves approval jobs", async () => {
  const suffix = randomUUID().slice(0, 8);
  const runningTaskId = `taskrun_restart_running_${suffix}`;
  const runningPlanId = `plan_restart_running_${suffix}`;
  const runningJobId = `job_restart_running_${suffix}`;
  const approvalTaskId = `taskrun_restart_approval_${suffix}`;
  const approvalPlanId = `plan_restart_approval_${suffix}`;
  const approvalJobId = `job_restart_approval_${suffix}`;
  const runningTask = createTaskRunRecord({
    id: runningTaskId,
    title: "Interrupted Task",
    description: "Was running before restart",
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const runningPlan = createPlanRecord({
    id: runningPlanId,
    goal: "Recover me after restart",
    mode: "task",
    taskRunIds: [runningTask.id],
  });
  const runningJob = createJobRecord({
    id: runningJobId,
    goal: "Recover me after restart",
    mode: "task",
    status: "running",
    verified: false,
    output: "Running...",
    plan: runningPlan,
    taskRuns: [runningTask],
    artifacts: [],
  });
  persistJobRecord({
    job: runningJob,
    plan: runningPlan,
    taskRuns: [runningTask],
    artifacts: [],
  });

  const approvalTask = createTaskRunRecord({
    id: approvalTaskId,
    title: "Approval Task",
    description: "Still waiting for approval",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    attempts: 0,
    artifacts: [],
  });
  const approvalPlan = createPlanRecord({
    id: approvalPlanId,
    goal: "Wait for approval across restart",
    mode: "task",
    taskRunIds: [approvalTask.id],
  });
  const approvalJob = createJobRecord({
    id: approvalJobId,
    goal: "Wait for approval across restart",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  persistJobRecord({
    job: approvalJob,
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Recovered Task",
      description: "continued after restart",
      status: "completed",
      verified: true,
      output: "recovered done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal: "Recover me after restart",
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal: "Recover me after restart",
      mode: "task",
      status: "completed",
      verified: true,
      output: "recovered done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "recovered done",
      logPath: "runtime/logs/restart-resume.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const recoveredIds = await __testables.recoverInterruptedJobs(undefined, {
      jobIds: [runningJobId, approvalJobId],
    });
    assert.equal(recoveredIds.includes(runningJobId), true);
    assert.equal(recoveredIds.includes(approvalJobId), false);

    const recoveredRecord = readJobRecord(runningJobId);
    assert.equal(recoveredRecord?.job.status, "blocked");
    assert.equal(recoveredRecord?.job.output.includes("service restart"), true);
    assert.equal(recoveredRecord?.control?.recoveryReason, "service_restart");
    assert.equal(typeof recoveredRecord?.control?.recoveredAt, "string");
    assert.equal(typeof recoveredRecord?.control?.resumedAt, "string");
    assert.equal(typeof recoveredRecord?.control?.resumedToJobId, "string");
    assert.equal(recoveredRecord?.taskRuns[0]?.status, "blocked");

    const resumedJobId = recoveredRecord?.control?.resumedToJobId;
    assert.equal(typeof resumedJobId, "string");

    const resumedRecord = resumedJobId ? readJobRecord(resumedJobId) : null;
    assert.equal(resumedRecord?.control?.resumeOf, runningJobId);
    assert.equal(resumedRecord?.job.status, "completed");

    const approvalRecord = readJobRecord(approvalJobId);
    assert.equal(approvalRecord?.job.status, "awaiting_approval");
    assert.equal(approvalRecord?.taskRuns[0]?.status, "awaiting_approval");

    const recoveredJobRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${runningJobId}`), recoveredJobRes);
    const recoveredJobBody = JSON.parse(recoveredJobRes.body) as {
      job: { status: string };
      control: { recoveryReason?: string; recoveredAt?: string; resumedToJobId?: string };
    };
    assert.equal(recoveredJobRes.statusCode, 200);
    assert.equal(recoveredJobBody.job.status, "blocked");
    assert.equal(recoveredJobBody.control.recoveryReason, "service_restart");
    assert.equal(typeof recoveredJobBody.control.recoveredAt, "string");
    assert.equal(recoveredJobBody.control.resumedToJobId, resumedJobId);

    const recoveredEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${runningJobId}/events`), recoveredEventsRes);
    const recoveredEventsBody = JSON.parse(recoveredEventsRes.body) as {
      snapshot?: {
        recovery?: {
          status?: string;
          reason?: string;
          recoverable?: boolean;
          resumed_to_job_id?: string | null;
          affected_task_run_ids?: string[];
        } | null;
      };
      events: Array<{ type: string; meta?: Record<string, unknown> }>;
    };
    const recoveredEvent = [...recoveredEventsBody.events].reverse().find((event) => event.type === "job.recovered");
    const resumedEvent = [...recoveredEventsBody.events].reverse().find((event) => event.type === "job.resumed");
    assert.equal(Boolean(recoveredEvent), true);
    assert.equal(recoveredEvent?.meta?.recovery_reason, "service_restart");
    assert.equal(recoveredEvent?.meta?.recoverable, false);
    assert.equal(recoveredEvent?.meta?.resumed_to_job_id, resumedJobId);
    assert.deepEqual(recoveredEvent?.meta?.affected_task_run_ids, [runningTaskId]);
    assert.equal(Boolean(resumedEvent), true);
    assert.equal(resumedEvent?.meta?.resumed_to_job_id, resumedJobId);
    assert.equal(resumedEvent?.meta?.resumed_automatically, true);
    assert.equal(recoveredEventsBody.snapshot?.recovery?.status, "recovered");
    assert.equal(recoveredEventsBody.snapshot?.recovery?.reason, "service_restart");
    assert.equal(recoveredEventsBody.snapshot?.recovery?.recoverable, false);
    assert.equal(recoveredEventsBody.snapshot?.recovery?.resumed_to_job_id, resumedJobId);
    assert.deepEqual(recoveredEventsBody.snapshot?.recovery?.affected_task_run_ids, [runningTaskId]);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("restart recovery records structured auto-resume failure state", async () => {
  const suffix = randomUUID().slice(0, 8);
  const runningTaskId = `taskrun_restart_failure_${suffix}`;
  const runningPlanId = `plan_restart_failure_${suffix}`;
  const runningJobId = `job_restart_failure_${suffix}`;
  const runningTask = createTaskRunRecord({
    id: runningTaskId,
    title: "Interrupted Task",
    description: "Was running before restart",
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const runningPlan = createPlanRecord({
    id: runningPlanId,
    goal: "Recover me after restart but fail",
    mode: "task",
    taskRunIds: [runningTask.id],
  });
  const runningJob = createJobRecord({
    id: runningJobId,
    goal: "Recover me after restart but fail",
    mode: "task",
    status: "running",
    verified: false,
    output: "Running...",
    plan: runningPlan,
    taskRuns: [runningTask],
    artifacts: [],
  });
  persistJobRecord({
    job: runningJob,
    plan: runningPlan,
    taskRuns: [runningTask],
    artifacts: [],
  });

  __testables.setTaskExecutorForTests(async () => {
    throw new Error("planner unavailable");
  });

  try {
    const recoveredIds = await __testables.recoverInterruptedJobs(undefined, {
      jobIds: [runningJobId],
    });
    assert.equal(recoveredIds.includes(runningJobId), true);

    const recoveredRecord = readJobRecord(runningJobId);
    assert.equal(recoveredRecord?.job.status, "blocked");
    assert.equal(typeof recoveredRecord?.control?.autoResumeAttemptedAt, "string");
    assert.equal(typeof recoveredRecord?.control?.autoResumeFailedAt, "string");
    assert.equal(recoveredRecord?.control?.autoResumeFailureMessage, "planner unavailable");
    assert.equal(recoveredRecord?.control?.resumedToJobId, undefined);

    const recoveredJobRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${runningJobId}`), recoveredJobRes);
    const recoveredJobBody = JSON.parse(recoveredJobRes.body) as {
      control: {
        autoResumeAttemptedAt?: string;
        autoResumeFailedAt?: string;
        autoResumeFailureMessage?: string;
        resumedToJobId?: string;
      };
    };
    assert.equal(typeof recoveredJobBody.control.autoResumeAttemptedAt, "string");
    assert.equal(typeof recoveredJobBody.control.autoResumeFailedAt, "string");
    assert.equal(recoveredJobBody.control.autoResumeFailureMessage, "planner unavailable");
    assert.equal(recoveredJobBody.control.resumedToJobId, undefined);

    const recoveredEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${runningJobId}/events`), recoveredEventsRes);
    const recoveredEventsBody = JSON.parse(recoveredEventsRes.body) as {
      snapshot?: {
        recovery?: {
          auto_resume_attempted_at?: string | null;
          auto_resume_failed_at?: string | null;
          auto_resume_failure_message?: string | null;
          resumed_to_job_id?: string | null;
        } | null;
      };
      events: Array<{ type: string; summary?: string; meta?: Record<string, unknown> }>;
    };
    const recoveryEvent = [...recoveredEventsBody.events].reverse().find((event) => event.type === "job.recovered");
    const failedEvent = [...recoveredEventsBody.events].reverse().find((event) => event.type === "job.failed");
    assert.equal(recoveryEvent?.summary?.includes("Automatic resume failed"), true);
    assert.equal(recoveryEvent?.meta?.auto_resume_failure_message, "planner unavailable");
    assert.equal(Boolean(failedEvent), true);
    assert.equal(recoveredEventsBody.snapshot?.recovery?.auto_resume_failure_message, "planner unavailable");
    assert.equal(typeof recoveredEventsBody.snapshot?.recovery?.auto_resume_attempted_at, "string");
    assert.equal(typeof recoveredEventsBody.snapshot?.recovery?.auto_resume_failed_at, "string");
    assert.equal(recoveredEventsBody.snapshot?.recovery?.resumed_to_job_id, null);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("restart recovery limits batch auto-resume concurrency and records queue metadata", async () => {
  const suffix = randomUUID().slice(0, 8);
  let currentConcurrent = 0;
  let maxConcurrent = 0;
  const jobIds = Array.from({ length: 5 }, (_, index) => `job_restart_batch_${index}_${suffix}`);

  for (let index = 0; index < 5; index += 1) {
    const taskRun = createTaskRunRecord({
      id: `taskrun_restart_batch_${index}_${suffix}`,
      title: `Interrupted Task ${index}`,
      description: "Was running before restart",
      status: "pending",
      verified: false,
      output: "",
      attempts: 0,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: `plan_restart_batch_${index}_${suffix}`,
      goal: `Recover batch job ${index}`,
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: jobIds[index]!,
      goal: `Recover batch job ${index}`,
      mode: "task",
      status: "running",
      verified: false,
      output: "Running...",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
  }

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    currentConcurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
    await new Promise((resolve) => setTimeout(resolve, 40));
    currentConcurrent -= 1;

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Recovered batch task",
      description: "continued after restart",
      status: "completed",
      verified: true,
      output: "recovered batch done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal: _goal ?? "Recover batch job",
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal: _goal ?? "Recover batch job",
      mode: "task",
      status: "completed",
      verified: true,
      output: "recovered batch done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "recovered batch done",
      logPath: "runtime/logs/restart-batch-resume.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const recoveredIds = await __testables.recoverInterruptedJobs(undefined, {
      jobIds,
    });
    assert.equal(recoveredIds.filter((id) => jobIds.includes(id)).length, 5);
    assert.equal(maxConcurrent <= 3, true);

    for (let index = 0; index < 5; index += 1) {
      const record = readJobRecord(jobIds[index]!);
      assert.equal(record?.control?.autoResumeBatchSize, 5);
      assert.equal(typeof record?.control?.autoResumeQueuePosition, "number");
      assert.equal(record?.control?.autoResumeStatus, "succeeded");
    }
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("doctor report exposes runtime diagnostics and writable checks", () => {
  const report = __testables.buildDoctorReport() as {
    ok: boolean;
    generated_at: string;
    config_path: string;
    summary: {
      passed: number;
      failed: number;
      total: number;
    };
    recommendations: Array<{
      category: string;
      severity: string;
      message: string;
      suggested_action: string;
      related_checks: string[];
    }>;
    checks: Array<{
      name: string;
      ok: boolean;
      summary: string;
      detail?: Record<string, unknown>;
    }>;
  };

  assert.equal(typeof report.ok, "boolean");
  assert.equal(typeof report.generated_at, "string");
  assert.equal(typeof report.config_path, "string");
  assert.equal(typeof report.summary?.passed, "number");
  assert.equal(typeof report.summary?.failed, "number");
  assert.equal(typeof report.summary?.total, "number");
  assert.equal(Array.isArray(report.recommendations), true);
  assert.equal(Array.isArray(report.checks), true);
  assert.equal(report.checks.some((check) => check.name === "config_load" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "planner_model_config" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "executor_model_config" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "runtime_profile" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "task_routing_summary" && check.ok), true);
  const executorCandidateQueue = report.checks.find((check) => check.name === "executor_candidate_queue");
  assert.notEqual(executorCandidateQueue, undefined);
  assert.equal(typeof executorCandidateQueue?.detail?.candidate_count, "number");
  assert.equal(report.checks.some((check) => check.name === "workspace_writable"), true);
  assert.equal(report.checks.some((check) => check.name === "runtime_writable"), true);
  assert.equal(report.checks.some((check) => check.name === "proxy_health"), true);
  assert.equal(report.checks.some((check) => check.name === "search_provider_readiness"), true);
  assert.equal(report.summary.total, report.checks.length);
  assert.equal(report.recommendations.length > 0, true);
  assert.equal(typeof report.recommendations[0]?.suggested_action, "string");
});

test("job create failure events expose executor health metadata for task mode", async () => {
  const healthResults = [
    {
      modelId: "executor.default",
      role: "executor" as const,
      status: "unhealthy" as const,
      summary: "Probe failed with upstream status 503.",
      baseUrl: "https://example.invalid/v1",
      model: "executor-model",
      error: "503 Service Unavailable",
    },
  ];

  __testables.setTaskExecutorForTests(async () => {
    throw new NoHealthyExecutorError(healthResults);
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Fail task job when no executor is healthy",
      mode: "task",
      model_route: "dual-agent-orchestrator",
    }), res);
    const body = JSON.parse(res.body) as {
      error: { type: string; message: string };
    };

    assert.equal(res.statusCode, 500);
    assert.equal(body.error.type, "server_error");

    const failedRecord = listStoredJobs()
      .filter((record) => record.goal === "Fail task job when no executor is healthy" && record.status === "failed")
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))[0];
    assert.notEqual(failedRecord, undefined);
    assert.equal(failedRecord?.status, "failed");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${failedRecord?.id}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type: string; meta?: Record<string, unknown> }>;
    };
    const failedEvent = [...eventsBody.events].reverse().find((event) => event.type === "job.failed");
    assert.notEqual(failedEvent, undefined);
    assert.equal(failedEvent?.meta?.failure_category, "environment_failure");
    assert.deepEqual(failedEvent?.meta?.healthy_executor_ids, []);
    assert.deepEqual(failedEvent?.meta?.executor_health_results, healthResults);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job create failure events expose executor health metadata for team mode", async () => {
  const healthResults = [
    {
      modelId: "executor.alpha",
      role: "executor" as const,
      status: "healthy" as const,
      summary: "Probe succeeded.",
      baseUrl: "https://example.invalid/v1",
      model: "executor-alpha",
    },
    {
      modelId: "executor.beta",
      role: "executor" as const,
      status: "unhealthy" as const,
      summary: "Probe timed out.",
      baseUrl: "https://example.invalid/v1",
      model: "executor-beta",
      error: "timeout",
    },
  ];

  __testables.setTeamExecutorForTests(async () => {
    throw new NoHealthyExecutorError(healthResults);
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Fail team job when no executor is healthy",
      mode: "team",
      model_route: "dual-agent-orchestrator",
    }), res);
    const body = JSON.parse(res.body) as {
      error: { type: string; message: string };
    };

    assert.equal(res.statusCode, 500);
    assert.equal(body.error.type, "server_error");

    const failedRecord = listStoredJobs()
      .filter((record) => record.goal === "Fail team job when no executor is healthy" && record.status === "failed")
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))[0];
    assert.notEqual(failedRecord, undefined);
    assert.equal(failedRecord?.status, "failed");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${failedRecord?.id}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type: string; meta?: Record<string, unknown> }>;
    };
    const failedEvent = [...eventsBody.events].reverse().find((event) => event.type === "job.failed");
    assert.notEqual(failedEvent, undefined);
    assert.equal(failedEvent?.meta?.failure_category, "environment_failure");
    assert.deepEqual(failedEvent?.meta?.healthy_executor_ids, []);
    assert.deepEqual(failedEvent?.meta?.executor_health_results, healthResults);
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});
