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
        },
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

function formatToolStartSummary(data: Record<string, unknown>): string {
  const tool = asString(data.tool);
  if (!tool) {
    return "Calling a tool.";
  }
  const argSummary = summarizeArguments(data.arguments);
  return argSummary ? `${tool}(${argSummary})` : tool;
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
