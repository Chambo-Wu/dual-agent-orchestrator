import { randomUUID } from "node:crypto";

export type UiEventAgent = "planner" | "executor" | "tool" | "system" | "verifier" | "synthesizer";
export type UiEventPhase = "start" | "reasoning" | "decision" | "result" | "retry" | "approval" | "final";
export type UiEventStatus = "running" | "success" | "partial_success" | "failed" | "blocked" | "completed" | "awaiting_approval";

export interface WorkflowUiEvent {
  id: string;
  jobId: string;
  seq: number;
  time: string;
  agent: UiEventAgent;
  phase: UiEventPhase;
  type: string;
  title: string;
  summary: string;
  status: UiEventStatus;
  step?: number;
  taskRunId?: string;
  meta: Record<string, unknown>;
}

export interface InternalWorkflowEvent {
  type: string;
  step?: number;
  data: Record<string, unknown>;
}

export function createUiEvent(input: {
  jobId: string;
  seq: number;
  time?: string;
  agent: UiEventAgent;
  phase: UiEventPhase;
  type: string;
  title: string;
  summary: string;
  status: UiEventStatus;
  step?: number;
  taskRunId?: string;
  meta?: Record<string, unknown>;
}): WorkflowUiEvent {
  return {
    id: `evt_${randomUUID().slice(0, 8)}`,
    jobId: input.jobId,
    seq: input.seq,
    time: input.time ?? new Date().toISOString(),
    agent: input.agent,
    phase: input.phase,
    type: input.type,
    title: input.title,
    summary: input.summary,
    status: input.status,
    step: input.step,
    taskRunId: input.taskRunId,
    meta: input.meta ?? {},
  };
}

export function normalizeWorkflowEvent(
  internal: InternalWorkflowEvent,
  jobId: string,
  seq: number,
  time?: string,
  taskRunId?: string,
): WorkflowUiEvent {
  switch (internal.type) {
    case "workflow.step.start":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "planner",
        phase: "start",
        type: "planner.start",
        title: "Planner started step",
        summary: `Started orchestration step ${internal.step ?? 1}.`,
        status: "running",
        step: internal.step,
        meta: { replan_count: internal.data.replan_count ?? 0 },
      });

    case "workflow.planner.decision":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "planner",
        phase: "decision",
        type: "planner.decision",
        title: "Planner made a decision",
        summary: formatPlannerSummary(internal.data),
        status: mapPlannerStatus(internal.data.status),
        step: internal.step,
        meta: {
          planner_status: internal.data.status ?? null,
          reasoning_summary: internal.data.reasoning_summary ?? "",
          next_step: internal.data.next_step ?? "",
          verdict: internal.data.verdict ?? null,
          workflow_id: asString(internal.data.workflow_id),
          workflow_task_count: typeof internal.data.workflow_task_count === "number" ? internal.data.workflow_task_count : 0,
        },
      });

    case "workflow.plan.created":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "planner",
        phase: "decision",
        type: "planner.workflow_plan_created",
        title: "Workflow plan created",
        summary: formatWorkflowPlanCreatedSummary(internal.data),
        status: "running",
        step: internal.step,
        meta: {
          workflow_id: asString(internal.data.workflow_id),
          strategy: asString(internal.data.strategy),
          task_count: typeof internal.data.task_count === "number" ? internal.data.task_count : 0,
          finish_mode: asString(internal.data.finish_mode),
        },
      });

    case "workflow.plan.validated":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "system",
        phase: "result",
        type: "system.workflow_plan_validated",
        title: "Workflow plan validated",
        summary: formatWorkflowPlanValidatedSummary(internal.data),
        status: "success",
        step: internal.step,
        meta: {
          workflow_id: asString(internal.data.workflow_id),
          task_count: typeof internal.data.task_count === "number" ? internal.data.task_count : 0,
        },
      });

    case "workflow.plan.rejected":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "system",
        phase: "retry",
        type: "system.workflow_plan_rejected",
        title: "Workflow plan rejected",
        summary: formatWorkflowPlanRejectedSummary(internal.data),
        status: "blocked",
        step: internal.step,
        meta: {
          workflow_id: asString(internal.data.workflow_id),
          issues: Array.isArray(internal.data.issues) ? internal.data.issues : [],
        },
      });

    case "workflow.plan.replanned":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "planner",
        phase: "retry",
        type: "planner.workflow_plan_replanned",
        title: "Workflow plan replanned",
        summary: formatWorkflowPlanReplannedSummary(internal.data),
        status: "running",
        step: internal.step,
        meta: {
          workflow_id: asString(internal.data.workflow_id),
          replacement_workflow_id: asString(internal.data.replacement_workflow_id),
          task_id: asString(internal.data.task_id),
          replan_count: typeof internal.data.replan_count === "number" ? internal.data.replan_count : 0,
        },
      });

    case "workflow.task.ready":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: mapWorkflowTaskAgent(internal.data.role),
        phase: "start",
        type: "workflow.task.ready",
        title: "Workflow task ready",
        summary: formatWorkflowTaskSummary(internal.data, "ready"),
        status: "running",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.task.assigned":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: mapWorkflowTaskAgent(internal.data.role),
        phase: "decision",
        type: "workflow.task.assigned",
        title: "Workflow task assigned",
        summary: formatWorkflowTaskSummary(internal.data, "assigned"),
        status: "running",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.task.awaiting_approval":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: "system",
        phase: "approval",
        type: "workflow.task.awaiting_approval",
        title: "Workflow task awaiting approval",
        summary: formatWorkflowTaskSummary(internal.data, "awaiting_approval"),
        status: "awaiting_approval",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.task.completed":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: mapWorkflowTaskAgent(internal.data.role),
        phase: "result",
        type: "workflow.task.completed",
        title: "Workflow task completed",
        summary: formatWorkflowTaskSummary(internal.data, "completed"),
        status: "completed",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.task.failed":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: mapWorkflowTaskAgent(internal.data.role),
        phase: "result",
        type: "workflow.task.failed",
        title: "Workflow task failed",
        summary: formatWorkflowTaskSummary(internal.data, "failed"),
        status: "failed",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.task.skipped":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: mapWorkflowTaskAgent(internal.data.role),
        phase: "result",
        type: "workflow.task.skipped",
        title: "Workflow task skipped",
        summary: formatWorkflowTaskSummary(internal.data, "skipped"),
        status: "blocked",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.task.superseded":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId: asString(internal.data.task_id) || taskRunId,
        agent: mapWorkflowTaskAgent(internal.data.role),
        phase: "retry",
        type: "workflow.task.superseded",
        title: "Workflow task superseded",
        summary: formatWorkflowTaskSupersededSummary(internal.data),
        status: "blocked",
        step: internal.step,
        meta: buildWorkflowTaskMeta(internal.data),
      });

    case "workflow.executor.start":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "executor",
        phase: "start",
        type: "executor.start",
        title: "Executor started work",
        summary: formatExecutorStartSummary(internal.data),
        status: "running",
        step: internal.step,
        meta: {
          instruction: truncate(asString(internal.data.instruction), 240),
          allowed_tools: normalizeStringArray(internal.data.allowed_tools),
        },
      });

    case "workflow.executor.result":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "executor",
        phase: "result",
        type: mapExecutorResultType(internal.data.status),
        title: "Executor returned a result",
        summary: asString(internal.data.summary) || "Executor completed a step.",
        status: mapExecutorStatus(internal.data.status),
        step: internal.step,
        meta: {
          executor_status: internal.data.status ?? null,
          artifact_count: typeof internal.data.artifact_count === "number" ? internal.data.artifact_count : 0,
        },
      });

    case "workflow.tool.start":
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "tool",
        phase: "start",
        type: "tool.start",
        title: "Tool call started",
        summary: formatToolStartSummary(internal.data),
        status: "running",
        step: internal.step,
        meta: {
          tool: asString(internal.data.tool),
          arguments: sanitizeArguments(internal.data.arguments),
        },
      });

    case "workflow.tool.result": {
      const ok = Boolean(internal.data.ok);
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "tool",
        phase: "result",
        type: ok ? "tool.result" : "tool.failed",
        title: ok ? "Tool returned a result" : "Tool failed",
        summary: asString(internal.data.summary) || (ok ? "Tool completed." : "Tool failed."),
        status: ok ? "success" : "failed",
        step: internal.step,
        meta: {
          tool: asString(internal.data.tool),
          ok,
        },
      });
    }

    case "workflow.complexity.assessed": {
      const mode = asString(internal.data.execution_mode) || "orchestrated";
      const score = typeof internal.data.complexity_score === "number" ? internal.data.complexity_score : 0;
      const reasons = Array.isArray(internal.data.reasons)
        ? internal.data.reasons.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "system",
        phase: "decision",
        type: "system.complexity_assessed",
        title: "Task complexity assessed",
        summary: mode === "direct"
          ? `Task was classified as simple and will try the fast path first.`
          : `Task was classified as multi-step and will use full orchestration.`,
        status: "running",
        step: internal.step,
        meta: {
          execution_mode: mode,
          complexity_score: score,
          reasons,
          task_type: asString(internal.data.task_type),
          route_type: asString(internal.data.route_type),
        },
      });
    }

    default:
      return createUiEvent({
        jobId,
        seq,
        time,
        taskRunId,
        agent: "system",
        phase: "result",
        type: internal.type,
        title: "System event",
        summary: truncate(JSON.stringify(internal.data), 200) || "System emitted an event.",
        status: "running",
        step: internal.step,
        meta: internal.data,
      });
  }
}

function formatPlannerSummary(data: Record<string, unknown>): string {
  const plannerStatus = asString(data.status);
  const reasoning = asString(data.reasoning_summary);
  const nextStep = asString(data.next_step);
  const workflowId = asString(data.workflow_id);
  const workflowTaskCount = typeof data.workflow_task_count === "number" ? data.workflow_task_count : 0;

  if (plannerStatus === "workflow") {
    const workflowLabel = workflowId
      ? `Planner proposed workflow ${workflowId}`
      : "Planner proposed a workflow plan";
    return workflowTaskCount > 0
      ? `${workflowLabel} with ${workflowTaskCount} tasks.`
      : `${workflowLabel}.`;
  }

  if (plannerStatus === "final") {
    return "Planner believes the task is ready to finalize.";
  }
  if (reasoning) {
    return truncate(reasoning, 160);
  }
  if (nextStep) {
    return `Next step: ${truncate(nextStep, 120)}`;
  }
  return "Planner updated the execution strategy.";
}

function formatExecutorStartSummary(data: Record<string, unknown>): string {
  const instruction = asString(data.instruction);
  if (instruction) {
    return truncate(instruction, 160);
  }

  const tools = normalizeStringArray(data.allowed_tools);
  if (tools.length > 0) {
    return `Executor will use: ${tools.join(", ")}.`;
  }
  return "Executor started working on the current step.";
}

function formatWorkflowPlanCreatedSummary(data: Record<string, unknown>): string {
  const workflowId = asString(data.workflow_id) || "workflow";
  const strategy = asString(data.strategy);
  const taskCount = typeof data.task_count === "number" ? data.task_count : 0;
  if (strategy && taskCount > 0) {
    return `Created ${workflowId} using ${strategy} with ${taskCount} tasks.`;
  }
  if (taskCount > 0) {
    return `Created ${workflowId} with ${taskCount} tasks.`;
  }
  return `Created ${workflowId}.`;
}

function formatWorkflowPlanValidatedSummary(data: Record<string, unknown>): string {
  const workflowId = asString(data.workflow_id) || "workflow";
  const taskCount = typeof data.task_count === "number" ? data.task_count : 0;
  return taskCount > 0
    ? `${workflowId} passed validation with ${taskCount} tasks.`
    : `${workflowId} passed validation.`;
}

function formatWorkflowPlanRejectedSummary(data: Record<string, unknown>): string {
  const workflowId = asString(data.workflow_id) || "workflow";
  const issues = Array.isArray(data.issues)
    ? data.issues.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return issues.length > 0
    ? `${workflowId} was rejected: ${truncate(issues[0] ?? "", 140)}`
    : `${workflowId} was rejected during validation.`;
}

function formatWorkflowPlanReplannedSummary(data: Record<string, unknown>): string {
  const workflowId = asString(data.workflow_id) || "workflow";
  const replacementWorkflowId = asString(data.replacement_workflow_id) || "replacement workflow";
  const taskId = asString(data.task_id);
  if (taskId) {
    return `${workflowId} was replaced by ${replacementWorkflowId} after task ${taskId} failed.`;
  }
  return `${workflowId} was replaced by ${replacementWorkflowId}.`;
}

function formatToolStartSummary(data: Record<string, unknown>): string {
  const tool = asString(data.tool);
  if (!tool) {
    return "Calling a tool.";
  }
  const argSummary = summarizeArguments(data.arguments);
  return argSummary ? `${tool}(${argSummary})` : tool;
}

function formatWorkflowTaskSummary(data: Record<string, unknown>, state: "ready" | "assigned" | "awaiting_approval" | "completed" | "failed" | "skipped"): string {
  const title = asString(data.title) || asString(data.task_id) || "workflow task";
  switch (state) {
    case "ready":
      return `${title} is ready to run.`;
    case "assigned":
      return `${title} is now running.`;
    case "awaiting_approval":
      return `${title} is waiting for approval.`;
    case "completed":
      return `${title} completed successfully.`;
    case "failed":
      return `${title} failed.`;
    case "skipped":
      return `${title} was skipped.`;
  }
}

function formatWorkflowTaskSupersededSummary(data: Record<string, unknown>): string {
  const title = asString(data.title) || asString(data.task_id) || "workflow task";
  const replacementWorkflowId = asString(data.replacement_workflow_id) || "replacement workflow";
  return `${title} was superseded by ${replacementWorkflowId}.`;
}

function buildWorkflowTaskMeta(data: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: asString(data.task_id),
    title: asString(data.title),
    kind: asString(data.kind),
    role: asString(data.role),
    depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
    output: asString(data.output),
  };
}

function mapWorkflowTaskAgent(role: unknown): UiEventAgent {
  switch (role) {
    case "verifier":
      return "verifier";
    case "synthesizer":
      return "synthesizer";
    case "planner_proxy":
      return "planner";
    case "worker":
    default:
      return "executor";
  }
}

function sanitizeArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return {};
  }

  const record = args as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      cleaned[key] = truncate(value, 160);
    } else if (typeof value === "number" || typeof value === "boolean") {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function summarizeArguments(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }

  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      parts.push(`${key}="${truncate(value, 48)}"`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(", ");
}

function mapPlannerStatus(value: unknown): UiEventStatus {
  switch (value) {
    case "final":
      return "completed";
    case "workflow":
      return "running";
    case "clarify":
      return "awaiting_approval";
    case "need_executor":
    default:
      return "running";
  }
}

function mapExecutorStatus(value: unknown): UiEventStatus {
  switch (value) {
    case "success":
      return "success";
    case "partial_success":
      return "partial_success";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return "running";
  }
}

function mapExecutorResultType(value: unknown): string {
  switch (value) {
    case "partial_success":
      return "executor.partial_success";
    case "failed":
      return "executor.failed";
    case "blocked":
      return "executor.blocked";
    case "success":
    default:
      return "executor.result";
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
