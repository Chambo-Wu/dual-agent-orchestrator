import { type IncomingMessage, type ServerResponse } from "node:http";
import { getRuntimeConfig, jsonResponse, jsonErrorResponse, readJsonBody } from "./shared.js";
import { executeJobByMode } from "../index.js";
import type { OrchestratorConfig } from "../types.js";
import { appendGoalEvent, buildGoalRecord, listGoals, persistGoal, readGoal, readGoalEvents } from "../goal-store.js";
import { resumeGoal, reviewGoal, retryGoalTask, runNextGoalTask } from "../goal-runtime.js";
import type { CreateGoalInput, GoalRecord, GoalTaskInput, GoalTaskMode } from "../goal-types.js";
import { insertLargeCheckTasks, planGoalTasks } from "../goal-planner.js";
import { buildGoalResponse } from "../goal-contract.js";
import { renderGoalsDashboardHtml, type GoalDashboardItem } from "../goals-dashboard.js";
import { renderGoalTimelineHtml } from "../goal-timeline.js";

interface CreateGoalRequest {
  goal?: string;
  insert_large_checks?: boolean;
  tasks?: Array<{
    title?: string;
    description?: string;
    mode?: "task" | "team";
  }>;
}

function normalizeCreateGoalInput(body: CreateGoalRequest, config: OrchestratorConfig): CreateGoalInput {
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) {
    throw new Error("`goal` must be a non-empty string.");
  }
  const tasks: GoalTaskInput[] | undefined = Array.isArray(body.tasks)
    ? body.tasks.flatMap((task) => {
        const title = typeof task?.title === "string" ? task.title.trim() : "";
        const description = typeof task?.description === "string" ? task.description.trim() : "";
        if (!title && !description) {
          return [];
        }
        const mode: GoalTaskMode = task?.mode === "team" ? "team" : "task";
        return [{
          title: title || description,
          description: description || title,
          mode,
        }];
      })
    : undefined;
  const plannedTasks = tasks && tasks.length > 0
    ? (body.insert_large_checks === true
        ? insertLargeCheckTasks(tasks, {
            interval: config.goalMode.largeCheckInterval,
            mode: config.goalMode.largeCheckMode,
          })
        : tasks)
    : planGoalTasks(goal, {
        autoInsertLargeChecks: config.goalMode.autoInsertLargeChecks,
        largeCheckInterval: config.goalMode.largeCheckInterval,
        largeCheckMode: config.goalMode.largeCheckMode,
      });
  return {
    goal,
    tasks: plannedTasks,
  };
}

export async function handleListGoals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: listGoals(),
  });
}

function buildGoalRouteSet(
  goalId: string,
  routeBasePath = "/v1/goals",
): Pick<GoalDashboardItem, "detail_url" | "timeline_url" | "events_url"> {
  return {
    detail_url: `${routeBasePath}/${goalId}`,
    timeline_url: `${routeBasePath}/${goalId}/timeline`,
    events_url: `${routeBasePath}/${goalId}/events`,
  };
}

function buildGoalActions(record: GoalRecord, routeBasePath = "/v1/goals"): GoalDashboardItem["actions"] {
  const actions: GoalDashboardItem["actions"] = [
    { label: "Timeline", href: `${routeBasePath}/${record.id}/timeline`, kind: "link", emphasis: "primary" },
    { label: "Details", href: `${routeBasePath}/${record.id}`, kind: "link" },
  ];
  if (record.status === "waiting_review") {
    actions.push({ label: "Review", href: `${routeBasePath}/${record.id}/review`, kind: "api", method: "POST" });
  } else if (record.tasks.some((task) => task.status === "blocked")) {
    actions.push({ label: "Resume", href: `${routeBasePath}/${record.id}/resume`, kind: "api", method: "POST" });
    actions.push({ label: "Retry", href: `${routeBasePath}/${record.id}/retry`, kind: "api", method: "POST" });
  } else if (record.tasks.some((task) => task.status === "failed")) {
    actions.push({ label: "Retry", href: `${routeBasePath}/${record.id}/retry`, kind: "api", method: "POST" });
  } else if (record.tasks.some((task) => task.status === "pending")) {
    actions.push({ label: "Run Next", href: `${routeBasePath}/${record.id}/run-next`, kind: "api", method: "POST" });
  }
  return actions;
}

function buildGoalListItem(record: GoalRecord, routeBasePath = "/v1/goals"): GoalDashboardItem {
  const currentTask = record.tasks.find((task) => task.id === record.currentTaskId) ?? null;
  return {
    id: record.id,
    goal: record.goal,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    completed_task_count: record.completedTaskCount,
    total_task_count: record.tasks.length,
    current_task: currentTask
      ? {
          id: currentTask.id,
          title: currentTask.title,
          status: currentTask.status,
          mode: currentTask.mode,
        }
      : null,
    final_review_status: record.finalReview.status,
    actions: buildGoalActions(record, routeBasePath),
    ...buildGoalRouteSet(record.id, routeBasePath),
  };
}

export function buildListedGoalsResponse(routeBasePath = "/v1/goals"): GoalDashboardItem[] {
  return listGoals().flatMap((stored) => {
    const record = readGoal(stored.id);
    return record ? [buildGoalListItem(record, routeBasePath)] : [];
  });
}

export async function handleCreateGoal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<CreateGoalRequest>(req);
  const config = getRuntimeConfig();
  const input = normalizeCreateGoalInput(body, config);
  const record = buildGoalRecord(input);
  persistGoal(record);
  appendGoalEvent(record.id, {
    type: "goal.created",
    title: "Goal created",
    summary: `Created goal ${record.id} with ${record.tasks.length} planned tasks.`,
    status: "success",
    meta: {
      goal_id: record.id,
      task_count: record.tasks.length,
      large_check_count: record.tasks.filter((task) => task.kind === "large_check").length,
      large_check_interval: config.goalMode.largeCheckInterval,
      large_check_mode: config.goalMode.largeCheckMode,
      status: record.status,
    },
  });
  jsonResponse(res, 201, buildGoalResponse(record));
}

export async function handleGoalEvents(_req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const record = readGoal(goalId);
  if (!record) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  jsonResponse(res, 200, {
    object: "list",
    goal_id: goalId,
    data: readGoalEvents(goalId),
  });
}

export async function handleGetGoal(_req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const record = readGoal(goalId);
  if (!record) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  jsonResponse(res, 200, buildGoalResponse(record));
}

export async function handleRunNextGoal(req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const body = await readJsonBody<{ model?: string }>(req);
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  const pendingTask = existing.tasks.find((task) => task.status === "pending");
  appendGoalEvent(goalId, {
    type: "goal.run_next_started",
    title: "Run-next started",
    summary: pendingTask
      ? `Starting goal task ${pendingTask.title}.`
      : "Starting next pending goal task.",
    status: "running",
    meta: {
      goal_id: goalId,
      task_id: pendingTask?.id ?? null,
      task_title: pendingTask?.title ?? null,
      task_kind: pendingTask?.kind ?? null,
    },
  });
  let result;
  try {
    result = await runNextGoalTask(goalId, {
      executeByMode: (mode, goal, model) => executeJobByMode(mode, goal, model),
    }, typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("no pending tasks") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  appendGoalEvent(goalId, {
    type: "goal.run_next_completed",
    title: "Run-next completed",
    summary: `Task ${result.executedTask.title} finished with status ${result.executedTask.status}.`,
    status: result.executedTask.status === "completed" ? "success" : result.executedTask.status === "blocked" ? "blocked" : "failed",
    meta: {
      goal_id: goalId,
      task_id: result.executedTask.id,
      task_title: result.executedTask.title,
      task_kind: result.executedTask.kind,
      task_status: result.executedTask.status,
      job_id: result.execution.job.id,
      goal_status: result.goal.status,
      verified: result.execution.job.verified,
    },
  });
  jsonResponse(res, 200, {
    object: "goal_run",
    goal: result.goal,
    executed_task: result.executedTask,
    execution: {
      job_id: result.execution.job.id,
      status: result.execution.job.status,
      verified: result.execution.job.verified,
      output: result.execution.job.output,
    },
    control: buildGoalResponse(result.goal).control,
    recent_events: readGoalEvents(goalId).slice(-10),
    links: {
      goal: `/v1/goals/${goalId}`,
      events: `/v1/goals/${goalId}/events`,
      job: `/v1/jobs/${result.execution.job.id}`,
    },
  });
}

export async function handleRetryGoal(req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const body = await readJsonBody<{ model?: string }>(req);
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  const retryableTask = [...existing.tasks].reverse().find((task) => task.status === "failed" || task.status === "blocked");
  appendGoalEvent(goalId, {
    type: "goal.retry_started",
    title: "Goal retry started",
    summary: retryableTask
      ? `Retrying goal task ${retryableTask.title}.`
      : "Retrying latest failed or blocked goal task.",
    status: "running",
    meta: {
      goal_id: goalId,
      task_id: retryableTask?.id ?? null,
      task_title: retryableTask?.title ?? null,
      task_kind: retryableTask?.kind ?? null,
    },
  });
  try {
    const result = await retryGoalTask(goalId, {
      executeByMode: (mode, goal, model) => executeJobByMode(mode, goal, model),
    }, typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined);
    appendGoalEvent(goalId, {
      type: "goal.retry_completed",
      title: "Goal retry completed",
      summary: `Retried task ${result.executedTask.title} finished with status ${result.executedTask.status}.`,
      status: result.executedTask.status === "completed" ? "success" : result.executedTask.status === "blocked" ? "blocked" : "failed",
      meta: {
        goal_id: goalId,
        task_id: result.executedTask.id,
        task_title: result.executedTask.title,
        task_kind: result.executedTask.kind,
        task_status: result.executedTask.status,
        job_id: result.execution.job.id,
        goal_status: result.goal.status,
        verified: result.execution.job.verified,
      },
    });
    jsonResponse(res, 200, {
      object: "goal_run",
      goal: result.goal,
      executed_task: result.executedTask,
      execution: {
        job_id: result.execution.job.id,
        status: result.execution.job.status,
        verified: result.execution.job.verified,
        output: result.execution.job.output,
      },
      control: buildGoalResponse(result.goal).control,
      recent_events: readGoalEvents(goalId).slice(-10),
      links: {
        goal: `/v1/goals/${goalId}`,
        events: `/v1/goals/${goalId}/events`,
        job: `/v1/jobs/${result.execution.job.id}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("not found") ? 404 : message.includes("no retryable tasks") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : statusCode === 404 ? "not_found_error" : "invalid_request_error", {
      status: "failed",
    });
  }
}

export async function handleResumeGoal(_req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  try {
    const record = resumeGoal(goalId);
    const resumedTask = record.tasks.find((task) => task.status === "pending" && task.id === record.currentTaskId);
    appendGoalEvent(goalId, {
      type: "goal.resumed",
      title: "Goal resumed",
      summary: resumedTask
        ? `Resumed blocked task ${resumedTask.title}.`
        : "Goal moved back to ready state.",
      status: "success",
      meta: {
        goal_id: goalId,
        task_id: resumedTask?.id ?? null,
        task_title: resumedTask?.title ?? null,
        task_kind: resumedTask?.kind ?? null,
        goal_status: record.status,
      },
    });
    jsonResponse(res, 200, buildGoalResponse(record));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("no resumable tasks") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : "invalid_request_error", {
      status: "failed",
    });
  }
}

export async function handleReviewGoal(req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const body = await readJsonBody<{ model?: string }>(req);
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  appendGoalEvent(goalId, {
    type: "goal.review_started",
    title: "Goal review started",
    summary: "Starting final review for the completed goal tasks.",
    status: "running",
    meta: {
      goal_id: goalId,
      completed_task_count: existing.completedTaskCount,
      total_task_count: existing.tasks.length,
    },
  });
  try {
    const result = await reviewGoal(goalId, {
      executeByMode: (mode, goal, model) => executeJobByMode(mode, goal, model),
    }, typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined);
    appendGoalEvent(goalId, {
      type: "goal.review_completed",
      title: "Goal review completed",
      summary: `Final review finished with status ${result.goal.finalReview.status}.`,
      status: result.goal.finalReview.status === "completed" ? "completed" : result.goal.finalReview.status === "blocked" ? "blocked" : "failed",
      meta: {
        goal_id: goalId,
        job_id: result.execution.job.id,
        review_status: result.goal.finalReview.status,
        goal_status: result.goal.status,
        verified: result.execution.job.verified,
      },
    });
    jsonResponse(res, 200, {
      object: "goal_review",
      goal: result.goal,
      final_review: result.goal.finalReview,
      execution: {
        job_id: result.execution.job.id,
        status: result.execution.job.status,
        verified: result.execution.job.verified,
        output: result.execution.job.output,
      },
      control: buildGoalResponse(result.goal).control,
      recent_events: readGoalEvents(goalId).slice(-10),
      links: {
        goal: `/v1/goals/${goalId}`,
        events: `/v1/goals/${goalId}/events`,
        job: `/v1/jobs/${result.execution.job.id}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("not ready for final review") || message.includes("already completed") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : "invalid_request_error", {
      status: "failed",
    });
  }
}

export async function handleGoalsDashboard(_req: IncomingMessage, res: ServerResponse, routeBasePath = "/v1/goals"): Promise<void> {
  const html = renderGoalsDashboardHtml(buildListedGoalsResponse(routeBasePath), {
    dataUrl: routeBasePath === "/goals" ? "/goals/data" : "/v1/goals/data",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

export async function handleBrowserListGoals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: buildListedGoalsResponse("/goals"),
  });
}

export async function handleGoalTimeline(_req: IncomingMessage, res: ServerResponse, goalId: string, routeBasePath = "/v1/goals"): Promise<void> {
  const record = readGoal(goalId);
  if (!record) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  const html = renderGoalTimelineHtml(record, readGoalEvents(goalId), {
    routeBasePath,
    apiBasePath: routeBasePath === "/goals" ? "/v1/goals" : routeBasePath,
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}
