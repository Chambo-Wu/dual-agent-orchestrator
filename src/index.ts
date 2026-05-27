import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { compressJsonOutput, compressToolOutput } from "./compress.js";
import { createRunLogger } from "./logger.js";
import { PlannerUnavailableError, runOrchestrator, runTask, detectTaskType, getRoutePolicy } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { TOOL_DEFINITIONS, configureSearchTools } from "./tools.js";
import type { ApprovalRequest, Artifact, ExecutorOutput, Job, OrchestratorConfig, OrchestratorEvent, OrchestratorEventCallback, Plan, RoutePolicy, Task, TaskRun } from "./types.js";
import { buildRuntimeProfile } from "./runtime/profile.js";
import { runTeam, type TeamAgent } from "./team.js";
import { buildDashboardData, exportDashboardJson, exportDashboardHtml } from "./dashboard.js";
import { Tracer } from "./trace.js";
import { createModelVerifier, DEFAULT_VERIFIERS, runVerifiers, verificationPassed as verificationResultPassed, type VerificationContext } from "./verification.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT } from "./paths.js";
import { listStoredJobs, persistApprovalRequest, persistJobRecord, readJobRecord, resolveApprovalRequest, updateJobControlState, updateStoredJobRecord, type StoredJobRecord } from "./job-store.js";
import { cancelActiveJobSession, getActiveJobSession, registerActiveJobSession, resolvePendingApproval, setApprovalResolver, unregisterActiveJobSession } from "./job-runtime.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "./workflow-contract.js";
import { createUiEvent, normalizeWorkflowEvent, type InternalWorkflowEvent, type WorkflowUiEvent } from "./workflow-ui-events.js";
import { appendEvent, getEvents, subscribe, getNextSeq, loadEventsFromDisk } from "./job-event-bus.js";
import { renderTimelineHtml } from "./timeline.js";
import { buildWorkflowGraph } from "./workflow-graph.js";
import { describeJobState, mapJobStatusToLifecycleType, mapJobStatusToUiStatus, mapTaskRunStatusToUiStatus } from "./status-semantics.js";
import { classifyFailure, getFailureCategoryLabel, listFailureCategories } from "./failure-classification.js";
import { getExecutorDisplaySummary, getPlannerDecisionText, summarizeVerification } from "./output-contract.js";

const OPENAI_MODEL_ID = "dual-agent-orchestrator";
const DEFAULT_API_KEY = "dual-agent-local";
const PLANNER_FAILURE_THRESHOLD = 3;
const PLANNER_COOLDOWN_MS = 60_000;
const MAX_TOOL_RESULT_CHARS = 2000;
const MAX_TOOL_MODE_ROUNDS = 4;
const MAX_TOOL_CONTEXT_CHARS = 1200;

type PlannerCircuitState = {
  consecutiveFailures: number;
  openUntil: number;
  lastFailureAt: number;
  lastFailureMessage: string;
};

const plannerCircuit: PlannerCircuitState = {
  consecutiveFailures: 0,
  openUntil: 0,
  lastFailureAt: 0,
  lastFailureMessage: "",
};

class ServiceUnavailableError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "ServiceUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface OpenAIMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  include_workflow_events?: boolean;
  include_progress_updates?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  stream_options?: { include_usage?: boolean };
}

interface CreateJobRequest {
  goal?: string;
  mode?: "task" | "team";
  model_route?: string;
  policy?: {
    allow_network?: boolean;
    allow_shell?: boolean;
    approval_mode?: string;
    async?: boolean;
  };
}

interface ResponseInputItem {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface ResponsesRequest {
  model?: string;
  input?: string | ResponseInputItem[];
  instructions?: string;
  stream?: boolean;
  include_workflow_events?: boolean;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  stream?: boolean;
  include_workflow_events?: boolean;
  tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

interface ExposedModel {
  id: string;
  object: "model";
  owned_by: string;
  planner_model?: string;
  executor_model?: string;
  planner_base_url?: string;
  planner_api_key?: string;
  executor_base_url?: string;
  executor_api_key?: string;
  description?: string;
}

interface TaskExecutionPayload {
  content: string;
  logPath: string;
  resolvedModel: string;
  job: Job;
  plan: Plan;
  taskRuns: TaskRun[];
  artifacts: Artifact[];
}

interface TaskExecutionContext {
  jobId: string;
  planId: string;
  taskRunId: string;
  signal: AbortSignal;
  emitEvent?: OrchestratorEventCallback;
}

interface FixedTaskIds {
  jobId: string;
  planId: string;
  taskRunId: string;
}

interface JobExecutionOptions {
  requirePlannerCircuit?: boolean;
  fixedIds?: FixedTaskIds;
  approvalMode?: string;
}

let injectedTaskExecutor: ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null = null;
let injectedTeamExecutor: ((userGoal: string, model: string | undefined, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null = null;

function setTaskExecutorForTests(executor: ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null): void {
  injectedTaskExecutor = executor;
}

function setTeamExecutorForTests(executor: ((userGoal: string, model: string | undefined, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null): void {
  injectedTeamExecutor = executor;
}

function parseTeamAgentsEnv(value: string | undefined): TeamAgent[] {
  const raw = value?.trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof item.name === "string")
          .map((item) => ({ name: item.name as string, role: typeof item.role === "string" ? item.role : undefined }))
      : [];
  } catch {
    return [];
  }
}

function teamAgentsFromRegistry(config: OrchestratorConfig): TeamAgent[] {
  return Object.values(config.agents ?? {}).map((agent) => ({
    name: agent.id,
    role: agent.role,
  }));
}

function resolveRegisteredRoleAgent(config: OrchestratorConfig | undefined, roleName: string): { id: string; role: string; model: string } | undefined {
  if (!config?.agents) {
    return undefined;
  }
  const normalizedRole = roleName.toLowerCase();
  const agent = Object.values(config.agents).find((candidate) => {
    const id = candidate.id.toLowerCase();
    const role = candidate.role.toLowerCase();
    return id === normalizedRole || role === normalizedRole || role.includes(normalizedRole);
  });
  return agent ? { id: agent.id, role: agent.role, model: agent.model.model } : undefined;
}

function resolveTeamAgents(config: OrchestratorConfig, envValue = process.env.TEAM_AGENTS): TeamAgent[] {
  const envAgents = parseTeamAgentsEnv(envValue);
  if (envAgents.length > 0) {
    return envAgents;
  }
  const registeredAgents = teamAgentsFromRegistry(config);
  if (registeredAgents.length > 0) {
    return registeredAgents;
  }
  return [{ name: "planner", role: "planning and coordination" }, { name: "executor", role: "task execution" }];
}

function persistWorkflowPayload(payload: Pick<TaskExecutionPayload, "job" | "plan" | "taskRuns" | "artifacts">): string {
  return persistJobRecord({
    job: payload.job,
    plan: payload.plan,
    taskRuns: payload.taskRuns,
    artifacts: payload.artifacts,
    workflowGraph: payload.job.workflowGraph,
  });
}

async function verifyWorkflowPayload(
  payload: TaskExecutionPayload,
  input: {
    jobId: string;
    goal: string;
    config?: OrchestratorConfig;
    emitLifecycle: (
      type: string,
      title: string,
      summary: string,
      status: WorkflowUiEvent["status"],
      meta?: Record<string, unknown>,
      phase?: WorkflowUiEvent["phase"],
    ) => void;
  },
): Promise<Job> {
  const executorHistory = payload.taskRuns.flatMap((taskRun) => taskRun.executorHistory ?? []);
  const verificationContext: VerificationContext = {
    jobId: input.jobId,
    goal: input.goal,
    executorHistory,
    artifacts: payload.artifacts,
    taskRuns: payload.taskRuns,
    workspaceRoot: WORKSPACE_ROOT,
    runtimeRoot: RUNTIME_ROOT,
  };
  const verifierAgent = resolveRegisteredRoleAgent(input.config, "verifier");
  const verifierConfig = input.config?.agents?.[verifierAgent?.id ?? ""];
  const activeVerifiers = verifierConfig
    ? [...DEFAULT_VERIFIERS, createModelVerifier(verifierConfig.model)]
    : undefined;
  const verificationResult = await runVerifiers(verificationContext, activeVerifiers);
  const allPassed = verificationResultPassed(verificationResult);
  const verifiedJob = allPassed
    ? { ...payload.job, verificationResult }
    : { ...payload.job, verified: false, verificationResult };
  const verifierMeta = verifierAgent
    ? {
        verifier_agent_id: verifierAgent.id,
        verifier_agent_role: verifierAgent.role,
        verifier_model: verifierAgent.model,
      }
    : {};
  if (!allPassed) {
    input.emitLifecycle("system.verification_failed", "Verification reported issues", summarizeVerification(verificationResult), "blocked", {
      verifier_count: verificationResult.checks.length,
      verification_status: verificationResult.status,
      ...verifierMeta,
    });
  } else {
    input.emitLifecycle("system.verification_passed", "Verification passed", summarizeVerification(verificationResult), "success", {
      verifier_count: verificationResult.checks.length,
      verification_status: verificationResult.status,
      ...verifierMeta,
    });
  }
  return verifiedJob;
}

function createTeamApprovalGate(jobId: string): (tasks: readonly Task[]) => Promise<boolean> {
  return async (tasks) => {
    const taskIds = tasks.map((task) => task.id);
    const approvalRequest: ApprovalRequest = {
      id: `appr_${randomUUID().slice(0, 8)}`,
      jobId,
      taskIds,
      reason: `Approve team task execution for: ${tasks.map((task) => task.title).join(", ")}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    persistApprovalRequest(jobId, approvalRequest);

    return await new Promise<boolean>((resolve) => {
      const registered = setApprovalResolver(jobId, (decision) => {
        resolve(decision === "approved");
      });
      if (!registered) {
        resolve(false);
      }
    });
  };
}

function persistTeamApprovalSnapshot(jobId: string, event: OrchestratorEvent): void {
  if (event.type !== "workflow.task.awaiting_approval") {
    return;
  }
  const taskId = typeof event.data.task_id === "string" ? event.data.task_id : "";
  if (!taskId) {
    return;
  }
  const title = typeof event.data.title === "string" && event.data.title.trim()
    ? event.data.title.trim()
    : "Team task awaiting approval";
  const assignee = typeof event.data.assignee === "string"
    ? event.data.assignee
    : typeof event.data.role === "string"
      ? event.data.role
      : undefined;
  const dependsOn = Array.isArray(event.data.depends_on)
    ? event.data.depends_on.filter((item): item is string => typeof item === "string")
    : [];

  updateStoredJobRecord(jobId, (record) => {
    const awaitingTask = createTaskRunRecord({
      id: taskId,
      title,
      description: `Waiting for approval before running team task "${title}".`,
      status: "awaiting_approval",
      assignee,
      dependsOn,
      verified: false,
      output: "Waiting for approval.",
      attempts: 0,
      artifacts: [],
    });
    const taskRuns = record.taskRuns.some((taskRun) => taskRun.id === taskId)
      ? record.taskRuns.map((taskRun) => taskRun.id === taskId ? awaitingTask : taskRun)
      : [...record.taskRuns.filter((taskRun) => taskRun.id !== record.plan.taskRunIds[0]), awaitingTask];
    const taskRunIds = Array.from(new Set(taskRuns.map((taskRun) => taskRun.id)));
    const plan = {
      ...record.plan,
      taskRunIds,
    };
    const job = {
      ...record.job,
      status: "awaiting_approval" as const,
      verified: false,
      output: "Waiting for approval.",
      plan,
      taskRuns,
      workflowGraph: buildWorkflowGraph(plan.id, taskRuns, plan.summary),
    };
    return {
      ...record,
      savedAt: new Date().toISOString(),
      job,
      plan,
      taskRuns,
      workflowGraph: job.workflowGraph,
    };
  });
}

function getServerApiKey(): string {
  return process.env.DUAL_AGENT_API_KEY?.trim() || process.env.API_KEY?.trim() || DEFAULT_API_KEY;
}

function getDefaultExposedModel(config: OrchestratorConfig): ExposedModel {
  return {
    id: OPENAI_MODEL_ID,
    object: "model",
    owned_by: "dual-agent-orchestrator",
    planner_model: config.planner.model,
    executor_model: config.executor.model,
    description: "Default dual-agent planner/executor route.",
  };
}

function getExposedModels(config: OrchestratorConfig): ExposedModel[] {
  const raw = process.env.DUAL_AGENT_MODELS?.trim();
  if (!raw) {
    return [getDefaultExposedModel(config)];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [getDefaultExposedModel(config)];
    }

    const models = parsed.flatMap((item): ExposedModel[] => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      if (!id) {
        return [];
      }

      return [{
        id,
        object: "model",
        owned_by: typeof candidate.owned_by === "string" && candidate.owned_by.trim()
          ? candidate.owned_by
          : "dual-agent-orchestrator",
        planner_model: typeof candidate.planner_model === "string" ? candidate.planner_model : undefined,
        executor_model: typeof candidate.executor_model === "string" ? candidate.executor_model : undefined,
        planner_base_url: typeof candidate.planner_base_url === "string" ? candidate.planner_base_url : undefined,
        planner_api_key: typeof candidate.planner_api_key === "string" ? candidate.planner_api_key : undefined,
        executor_base_url: typeof candidate.executor_base_url === "string" ? candidate.executor_base_url : undefined,
        executor_api_key: typeof candidate.executor_api_key === "string" ? candidate.executor_api_key : undefined,
        description: typeof candidate.description === "string" ? candidate.description : undefined,
      }];
    });

    return models.length > 0 ? models : [getDefaultExposedModel(config)];
  } catch {
    return [getDefaultExposedModel(config)];
  }
}

function resolveRequestedModel(config: OrchestratorConfig, requestedModel: string | undefined): { exposed: ExposedModel; resolvedConfig: OrchestratorConfig } {
  const exposedModels = getExposedModels(config);
  const exposed = exposedModels.find((item) => item.id === requestedModel) || exposedModels[0];

  return {
    exposed,
    resolvedConfig: {
      planner: {
        ...config.planner,
        model: exposed.planner_model || config.planner.model,
        baseUrl: exposed.planner_base_url || config.planner.baseUrl,
        apiKey: exposed.planner_api_key || config.planner.apiKey,
      },
      executor: {
        ...config.executor,
        model: exposed.executor_model || config.executor.model,
        baseUrl: exposed.executor_base_url || config.executor.baseUrl,
        apiKey: exposed.executor_api_key || config.executor.apiKey,
      },
      policy: { ...config.policy },
    },
  };
}

function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (responseAlreadyStarted(res)) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function responseAlreadyStarted(res: ServerResponse): boolean {
  const state = res as ServerResponse & { headersSent?: boolean; writableEnded?: boolean };
  return state.headersSent === true || state.writableEnded === true;
}

function jsonErrorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  classification?: {
    status?: string;
    error?: string;
    summary?: string;
  },
  extras?: Record<string, unknown>,
): void {
  jsonResponse(res, statusCode, {
    error: {
      message,
      type,
      failure_category: classifyFailure({
        type,
        status: classification?.status,
        error: classification?.error ?? message,
        summary: classification?.summary ?? message,
      }),
      ...(extras ?? {}),
    },
  });
}

function secondsUntilCircuitHalfOpen(): number {
  return Math.max(1, Math.ceil((plannerCircuit.openUntil - Date.now()) / 1000));
}

function isPlannerCircuitOpen(): boolean {
  return plannerCircuit.openUntil > Date.now();
}

function assertPlannerCircuitClosed(): void {
  if (isPlannerCircuitOpen()) {
    throw new ServiceUnavailableError(
      "Planner is temporarily unavailable after repeated upstream failures.",
      secondsUntilCircuitHalfOpen()
    );
  }
}

function markPlannerSuccess(): void {
  plannerCircuit.consecutiveFailures = 0;
  plannerCircuit.openUntil = 0;
  plannerCircuit.lastFailureAt = 0;
  plannerCircuit.lastFailureMessage = "";
}

function markPlannerFailure(message: string): ServiceUnavailableError {
  plannerCircuit.consecutiveFailures += 1;
  plannerCircuit.lastFailureAt = Date.now();
  plannerCircuit.lastFailureMessage = message;

  if (plannerCircuit.consecutiveFailures >= PLANNER_FAILURE_THRESHOLD) {
    plannerCircuit.openUntil = Date.now() + PLANNER_COOLDOWN_MS;
  }

  return new ServiceUnavailableError(
    plannerCircuit.openUntil > Date.now()
      ? "Planner is temporarily unavailable after repeated upstream failures."
      : "Planner request failed. Please retry shortly.",
    plannerCircuit.openUntil > Date.now() ? secondsUntilCircuitHalfOpen() : 5
  );
}

function serviceUnavailableResponse(res: ServerResponse, message: string, retryAfterSeconds: number): void {
  if (responseAlreadyStarted(res)) {
    return;
  }
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.end(JSON.stringify({
    error: {
      message,
      type: "service_unavailable",
      failure_category: classifyFailure({
        type: "service_unavailable",
        status: "failed",
        error: message,
        summary: message,
      }),
      retry_after: retryAfterSeconds,
    },
  }));
}

function getHeaderValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? "";
  }
  return raw ?? "";
}

function isTruthyFlag(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function shouldIncludeWorkflowEvents(req: IncomingMessage, requested?: boolean): boolean {
  if (requested === true) {
    return true;
  }
  return isTruthyFlag(getHeaderValue(req, "x-dual-agent-workflow-events"))
    || isTruthyFlag(getHeaderValue(req, "x-workflow-events"));
}

function shouldMirrorProgressToContent(requested?: boolean): boolean {
  return requested !== false;
}

function isAuthorized(req: IncomingMessage): boolean {
  const expectedKey = getServerApiKey();
  const authHeader = getHeaderValue(req, "authorization");
  const xApiKey = getHeaderValue(req, "x-api-key");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  return bearer === expectedKey || xApiKey.trim() === expectedKey;
}

function unauthorizedResponse(res: ServerResponse): void {
  jsonResponse(res, 401, {
    error: {
      message: "Unauthorized. Provide Authorization: Bearer <api_key> or X-API-Key.",
      type: "authentication_error",
    },
  });
}

function getMessageText(message: OpenAIMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

function getAnthropicContentText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

function extractWorkingDirectoryHint(text: string): string {
  if (!text) {
    return "";
  }

  const patterns = [
    /\bcwd\s*[:=]\s*([^\r\n]+)/i,
    /\bworking directory\s*[:=]\s*([^\r\n]+)/i,
    /<cwd>\s*([^<]+)\s*<\/cwd>/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

function truncateToolResultContent(content: string): string {
  const normalized = content.trim();
  if (normalized.length <= MAX_TOOL_RESULT_CHARS) {
    return normalized;
  }

  const headLength = 1500;
  const tailLength = 300;
  const omitted = normalized.length - headLength - tailLength;
  const head = normalized.slice(0, headLength);
  const tail = normalized.slice(-tailLength);
  return `${head}\n... [truncated ${omitted} chars] ...\n${tail}`;
}

export function summarizeToolResultContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_TOOL_CONTEXT_CHARS) {
    return normalized;
  }
  return normalized.startsWith("{") || normalized.startsWith("[")
    ? compressJsonOutput(normalized, MAX_TOOL_CONTEXT_CHARS)
    : compressToolOutput(normalized, MAX_TOOL_CONTEXT_CHARS);
}

function normalizeChatMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.map((message) => ({
    role: message.role || "user",
    content: getMessageText(message),
  }));
}

function normalizeResponsesInput(input: string | ResponseInputItem[] | undefined, instructions?: string): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions.trim() });
  }
  if (typeof input === "string" && input.trim()) {
    messages.push({ role: "user", content: input.trim() });
    return messages;
  }
  if (Array.isArray(input)) {
    return messages.concat(input.map((item) => ({
      role: item.role || "user",
      content: typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .filter((part) => part && part.type === "text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
              .join("\n")
              .trim()
          : "",
    })));
  }
  return messages;
}

function normalizeAnthropicMessages(messages: AnthropicMessage[] | undefined, system?: string | AnthropicContentBlock[]): OpenAIMessage[] {
  const normalized: OpenAIMessage[] = [];
  const systemText = getAnthropicContentText(system);
  if (systemText) {
    normalized.push({ role: "system", content: systemText });
  }
  if (Array.isArray(messages)) {
    normalized.push(...messages.map((message) => ({
      role: message.role || "user",
      content: getAnthropicContentText(message.content),
    })));
  }
  return normalized;
}

function normalizeAnthropicToolMessages(messages: AnthropicMessage[] | undefined, system?: string | AnthropicContentBlock[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  const systemText = getAnthropicContentText(system);
  if (systemText) {
    normalized.push({ role: "system", content: systemText });
  }

  for (const message of messages || []) {
    const role = message.role || "user";
    const content = message.content;

    if (typeof content === "string") {
      normalized.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    if (role === "assistant") {
      const textParts = content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();

      const toolCalls = content
        .filter((part) => part?.type === "tool_use" && typeof part.name === "string")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input || {}),
          },
        }));

      normalized.push({
        role: "assistant",
        content: textParts,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    const toolResults = content.filter((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
    if (toolResults.length > 0) {
      for (const part of toolResults) {
        normalized.push({
          role: "tool",
          tool_call_id: part.tool_use_id,
          content: summarizeToolResultContent(typeof part.content === "string"
            ? part.content
            : typeof part.text === "string"
              ? part.text
              : JSON.stringify(part.content ?? "")),
        });
      }
      continue;
    }

    normalized.push({
      role,
      content: content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim(),
    });
  }

  return normalized;
}

function safeParseToolInput(argumentsText: string | undefined): Record<string, unknown> {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isSuccessfulNativeToolResult(content: string): boolean {
  return /"ok"\s*:\s*true/i.test(content) || /"summary"\s*:\s*"Wrote file/i.test(content) || /"summary"\s*:\s*"Read file/i.test(content);
}

function extractLatestOpenAIWriteToolCompletion(messages: OpenAIMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "tool" || previousMessage?.role !== "assistant" || !Array.isArray(previousMessage.tool_calls)) return false;
  const matchedTool = previousMessage.tool_calls.find((call) => call?.id === lastMessage.tool_call_id);
  if (matchedTool?.function?.name !== "write_file") return false;
  return isSuccessfulNativeToolResult(getMessageText(lastMessage));
}

function extractLatestAnthropicWriteToolCompletion(messages: AnthropicMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "user" || previousMessage?.role !== "assistant") return false;
  if (!Array.isArray(lastMessage.content) || !Array.isArray(previousMessage.content)) return false;
  const latestToolResult = [...lastMessage.content].reverse().find((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
  if (!latestToolResult) return false;
  const matchedToolUse = previousMessage.content.find((part) => part?.type === "tool_use" && part.id === latestToolResult.tool_use_id);
  if (matchedToolUse?.name !== "write_file") return false;
  const content = typeof latestToolResult.content === "string"
    ? latestToolResult.content
    : typeof latestToolResult.text === "string"
      ? latestToolResult.text
      : JSON.stringify(latestToolResult.content ?? "");
  return isSuccessfulNativeToolResult(content);
}

function extractLatestOpenAIResearchReadCompletion(messages: OpenAIMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "tool" || previousMessage?.role !== "assistant" || !Array.isArray(previousMessage.tool_calls)) return false;
  const matchedTool = previousMessage.tool_calls.find((call) => call?.id === lastMessage.tool_call_id);
  if (matchedTool?.function?.name !== "read_file") return false;
  return isSuccessfulNativeToolResult(getMessageText(lastMessage));
}

function extractLatestAnthropicResearchReadCompletion(messages: AnthropicMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "user" || previousMessage?.role !== "assistant") return false;
  if (!Array.isArray(lastMessage.content) || !Array.isArray(previousMessage.content)) return false;
  const latestToolResult = [...lastMessage.content].reverse().find((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
  if (!latestToolResult) return false;
  const matchedToolUse = previousMessage.content.find((part) => part?.type === "tool_use" && part.id === latestToolResult.tool_use_id);
  if (matchedToolUse?.name !== "read_file") return false;
  const content = typeof latestToolResult.content === "string"
    ? latestToolResult.content
    : typeof latestToolResult.text === "string"
      ? latestToolResult.text
      : JSON.stringify(latestToolResult.content ?? "");
  return isSuccessfulNativeToolResult(content);
}

function countToolModeRounds(messages: ChatMessage[]): number {
  return messages.filter((message) => message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0).length;
}

export function shouldForceTextResponseForToolMessage(message: ChatMessage | undefined): boolean {
  if (!message || message.role !== "tool") {
    return false;
  }
  const content = typeof message.content === "string" ? message.content : "";
  return content.includes("command-results")
    || content.includes("[...") 
    || content.includes("truncated")
    || content.length > MAX_TOOL_CONTEXT_CHARS;
}

function buildUserGoal(messages: OpenAIMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const systemContext = messages
    .filter((message) => message.role === "system")
    .map((message) => getMessageText(message))
    .filter(Boolean)
    .join("\n");
  const cwdHint = extractWorkingDirectoryHint(systemContext);

  if (lastUserMessage) {
    const goal = getMessageText(lastUserMessage);
    return cwdHint && !goal.includes(cwdHint)
      ? `${goal}\n\nCurrent working directory: ${cwdHint}`
      : goal;
  }

  return messages
    .map((message) => getMessageText(message))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isClaudeControlMessage(goal: string): boolean {
  const trimmed = goal.trim();
  return trimmed === "/init"
    || trimmed.startsWith("/init ")
    || /<command-name>\s*\/init\s*<\/command-name>/i.test(trimmed)
    || /<command-message>\s*init\s*<\/command-message>/i.test(trimmed)
    || /^\[SUGGESTION MODE:/i.test(trimmed);
}

function hasAnthropicToolHistory(messages: AnthropicMessage[] | undefined): boolean {
  for (const message of messages || []) {
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    if (content.some((part) => part?.type === "tool_use" || part?.type === "tool_result")) {
      return true;
    }
  }
  return false;
}

function buildClaudeControlResponse(goal: string): TaskExecutionPayload | null {
  const trimmed = goal.trim();
  if (!isClaudeControlMessage(trimmed)) {
    return null;
  }

  const isInitCommand = trimmed === "/init"
    || trimmed.startsWith("/init ")
    || /<command-name>\s*\/init\s*<\/command-name>/i.test(trimmed)
    || /<command-message>\s*init\s*<\/command-message>/i.test(trimmed);
  const output = isInitCommand
    ? "Dual Agent Orchestrator is ready. Existing CLAUDE.md is present, and I can inspect the repo, diagnose issues, make code changes, and run validation in this workspace."
    : "";
  const taskRun = createTaskRunRecord({
    id: "taskrun_control",
    title: "Claude control message",
    description: trimmed,
    status: "completed",
    verified: true,
    output,
    attempts: 0,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_control",
    goal: trimmed,
    mode: "task",
    taskRunIds: [taskRun.id],
    summary: "Short-circuited Claude control message.",
  });
  const job = createJobRecord({
    id: "job_control",
    goal: trimmed,
    mode: "task",
    status: "completed",
    verified: true,
    output,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  return {
    content: output,
    logPath: "",
    resolvedModel: "control",
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  };
}

function splitContentForStreaming(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  if (content.includes("\n")) {
    const lineChunks = content.match(/[^\r\n]+(?:\r?\n)*/g) ?? [];
    const meaningfulChunks = lineChunks.filter((chunk) => chunk.trim().length > 0);
    if (meaningfulChunks.length > 0) {
      return meaningfulChunks;
    }
  }

  const normalized = content.trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.map((word, index) => index === words.length - 1 ? word : `${word} `);
  }

  return [normalized];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let raw = "";
    let totalBytes = 0;
    const decoder = new TextDecoder();
    req.on("data", (chunk) => {
      const str = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      totalBytes += Buffer.byteLength(str);
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds maximum size of 10MB."));
        return;
      }
      raw += str;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(new Error("Invalid JSON in request body."));
      }
    });
    req.on("error", reject);
  });
}

function buildModelsResponse(config = loadConfig()): unknown {
  return {
    object: "list",
    data: getExposedModels(config).map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: model.owned_by,
      metadata: {
        planner_model: model.planner_model || config.planner.model,
        executor_model: model.executor_model || config.executor.model,
        description: model.description || "",
      },
    })),
  };
}

function buildHealthResponse(config = loadConfig()): { status: string; planner: Record<string, unknown>; executor: Record<string, unknown>; models: string[] } {
  const circuitOpen = isPlannerCircuitOpen();
  return {
    status: circuitOpen ? "degraded" : "ok",
    planner: {
      model: config.planner.model,
      base_url: config.planner.baseUrl,
      circuit_open: circuitOpen,
      consecutive_failures: plannerCircuit.consecutiveFailures,
      retry_after: circuitOpen ? secondsUntilCircuitHalfOpen() : 0,
      last_failure_at: plannerCircuit.lastFailureAt || null,
      last_failure_message: plannerCircuit.lastFailureMessage || null,
    },
    executor: {
      model: config.executor.model,
      base_url: config.executor.baseUrl,
    },
    models: getExposedModels(config).map((model) => model.id),
  };
}

function buildWorkflowPayload(payload: Pick<TaskExecutionPayload, "job" | "plan" | "taskRuns" | "artifacts">): unknown {
  return {
    job: payload.job,
    plan: payload.plan,
    taskRuns: payload.taskRuns,
    artifacts: payload.artifacts,
  };
}

function buildStepList(record: StoredJobRecord): unknown[] {
  const currentTask = getWorkflowCurrentTask(record);
  const awaitingApprovalTask = getWorkflowAwaitingApprovalTask(record);
  return record.taskRuns.map((taskRun) => {
    const executorHistory = taskRun.executorHistory ?? [];
    const latestExecutorOutput = executorHistory.at(-1);
    return {
      id: taskRun.id,
      job_id: record.job.id,
      plan_id: record.plan.id,
      title: taskRun.title,
      description: taskRun.description,
      status: taskRun.status,
      assignee: taskRun.assignee,
      depends_on: taskRun.dependsOn,
      verified: taskRun.verified,
      attempts: taskRun.attempts,
      output: taskRun.output,
      artifacts: taskRun.artifacts,
      executor_history: executorHistory,
      latest_executor_status: latestExecutorOutput?.status ?? null,
      latest_executor_summary: latestExecutorOutput ? getExecutorDisplaySummary(latestExecutorOutput) : null,
      is_current_task: currentTask?.id === taskRun.id,
      is_awaiting_approval_task: awaitingApprovalTask?.id === taskRun.id,
      workflow_position: {
        index: record.taskRuns.findIndex((item) => item.id === taskRun.id) + 1,
        total: record.taskRuns.length,
      },
    };
  });
}

function latestExecutorStatus(record: StoredJobRecord): ExecutorOutput["status"] | null {
  const history = record.taskRuns.flatMap((taskRun) => taskRun.executorHistory ?? []);
  return history.at(-1)?.status ?? null;
}

function createLifecycleEvent(input: {
  jobId: string;
  seq: number;
  time: string;
  type: string;
  title: string;
  summary: string;
  status: WorkflowUiEvent["status"];
  phase?: WorkflowUiEvent["phase"];
  step?: number;
  taskRunId?: string;
  meta?: Record<string, unknown>;
}): WorkflowUiEvent {
  return createUiEvent({
    jobId: input.jobId,
    seq: input.seq,
    time: input.time,
    agent: "system",
    phase: input.phase ?? "result",
    type: input.type,
    title: input.title,
    summary: input.summary,
    status: input.status,
    step: input.step,
    taskRunId: input.taskRunId,
    meta: input.meta ?? {},
  });
}

function attachFailureCategory(
  type: string,
  status: WorkflowUiEvent["status"],
  summary: string,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const existingCategory = typeof meta.failure_category === "string" ? meta.failure_category : null;
  const failureCategory = existingCategory ?? classifyFailure({
    type,
    status,
    summary,
    error: typeof meta.error === "string" ? meta.error : undefined,
    verificationStatus: typeof meta.verification_status === "string" ? meta.verification_status : undefined,
    recoveryReason: typeof meta.recovery_reason === "string" ? meta.recovery_reason : undefined,
  });
  if (!failureCategory) {
    return meta;
  }
  return {
    ...meta,
    failure_category: failureCategory,
    failure_category_label: getFailureCategoryLabel(failureCategory),
  };
}

function buildJobEvents(record: StoredJobRecord): WorkflowUiEvent[] {
  const events: WorkflowUiEvent[] = [];
  let seq = 1;
  const push = (event: WorkflowUiEvent) => {
    events.push(event);
    seq += 1;
  };

  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: "job.created",
    title: "Job created",
    summary: "A control-plane job record was created.",
    status: "running",
    meta: {
      mode: record.job.mode,
      goal: record.job.goal,
      plan_id: record.plan.id,
    },
  }));

  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: "plan.created",
    title: "Plan created",
    summary: record.plan.summary || "A plan was attached to the job.",
    status: "running",
    meta: {
      mode: record.plan.mode,
      task_run_ids: record.plan.taskRunIds,
    },
  }));

  for (const taskRun of record.taskRuns) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: `step.${taskRun.status}`,
      title: "Task step recorded",
      summary: `${taskRun.title} is currently ${taskRun.status}.`,
      status: mapTaskRunStatusToUiStatus(taskRun.status),
      taskRunId: taskRun.id,
      meta: {
        title: taskRun.title,
        verified: taskRun.verified,
        attempts: taskRun.attempts,
        artifact_count: taskRun.artifacts.length,
        failure_category: classifyFailure({
          type: `step.${taskRun.status}`,
          status: taskRun.status,
          summary: taskRun.output,
        }),
      },
    }));

    for (const [index, executorOutput] of (taskRun.executorHistory ?? []).entries()) {
      push(createLifecycleEvent({
        jobId: record.job.id,
        seq,
        time: record.savedAt,
        type: mapExecutorHistoryType(executorOutput.status),
        title: "Executor result recorded",
        summary: getExecutorDisplaySummary(executorOutput),
        status: mapExecutorHistoryStatus(executorOutput.status),
        taskRunId: taskRun.id,
        step: index + 1,
        meta: {
          source: executorOutput.source ?? null,
          error: executorOutput.error ?? null,
          artifact_count: executorOutput.artifacts.length,
          tool_call_count: executorOutput.tool_calls_made.length,
          failure_category: classifyFailure({
            type: mapExecutorHistoryType(executorOutput.status),
            status: executorOutput.status,
            summary: getExecutorDisplaySummary(executorOutput),
            error: executorOutput.error,
            tool: executorOutput.tool_calls_made[0]?.tool,
          }),
        },
      }));
    }
  }

  for (const artifact of record.artifacts) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: "artifact.created",
      title: "Artifact created",
      summary: artifact.path
        ? `Artifact saved to ${artifact.path}.`
        : `Artifact ${artifact.id} was created.`,
      status: "success",
      taskRunId: artifact.sourceTaskRunId,
      meta: {
        artifact_id: artifact.id,
        artifact_type: artifact.type,
        path: artifact.path ?? null,
        source: artifact.source,
        trust_level: artifact.trustLevel ?? null,
        related_task_run_id: artifact.relatedTaskRunId ?? artifact.sourceTaskRunId ?? null,
        related_step: artifact.relatedStep ?? null,
      },
    }));
  }

  if (record.control?.cancelledAt) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.control.cancelledAt,
      type: "job.cancelled",
      title: "Job cancelled",
      summary: "The job was cancelled.",
      status: "blocked",
      meta: {
        cancellation_requested_at: record.control.cancellationRequestedAt ?? null,
        failure_category: classifyFailure({
          type: "job.cancelled",
          status: "blocked",
          summary: "The job was cancelled.",
        }),
      },
    }));
  }

  if (record.control?.retriedAt) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.control.retriedAt,
      type: "job.retried",
      title: "Job retried",
      summary: `A retry job was created: ${record.control.retriedToJobId ?? "unknown"}.`,
      status: "success",
      meta: {
        retried_to_job_id: record.control.retriedToJobId ?? null,
      },
    }));
  }

  if (record.control?.retryOf) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: "job.retry_created",
      title: "Retry job created",
      summary: `This job is a retry of ${record.control.retryOf}.`,
      status: "running",
      meta: {
        retry_of: record.control.retryOf,
      },
    }));
  }

  const recoveryEvent = createRecoveryEvent(record, seq);
  if (recoveryEvent) {
    push(recoveryEvent);
  }

  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: mapJobStatusToLifecycleType(record.job.status),
    title: "Job state recorded",
    summary: describeJobState(record.job.status),
    status: mapJobStatusToUiStatus(record.job.status),
    meta: {
      verified: record.job.verified,
      output_preview: record.job.output.slice(0, 200),
    },
  }));

  return events;
}

function mapExecutorHistoryStatus(status: ExecutorOutput["status"]): WorkflowUiEvent["status"] {
  switch (status) {
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

function mapExecutorHistoryType(status: ExecutorOutput["status"]): string {
  switch (status) {
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

function getRecoveredTaskRunIds(record: StoredJobRecord): string[] {
  if (!record.control?.recoveredAt) {
    return [];
  }
  return record.taskRuns
    .filter((taskRun) => taskRun.status === "blocked" && /service restart/i.test(taskRun.output))
    .map((taskRun) => taskRun.id);
}

function createRecoveryEvent(record: StoredJobRecord, seq: number): WorkflowUiEvent | null {
  if (!record.control?.recoveredAt || record.control.recoveryReason !== "service_restart") {
    return null;
  }
  return createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.control.recoveredAt,
    type: "job.recovered",
    title: "Job recovered after restart",
    summary: "The previous in-memory run session was lost after a service restart. The job is now recoverable.",
    status: "blocked",
      meta: {
        recovery_reason: record.control.recoveryReason,
        recovered_at: record.control.recoveredAt,
        recoverable: true,
        job_status: record.job.status,
        affected_task_run_ids: getRecoveredTaskRunIds(record),
        failure_category: classifyFailure({
          type: "job.recovered",
          status: "blocked",
          summary: "The previous in-memory run session was lost after a service restart. The job is now recoverable.",
          recoveryReason: record.control.recoveryReason,
        }),
      },
    });
}

function buildEventSnapshot(record: StoredJobRecord, events: WorkflowUiEvent[]): Record<string, unknown> | null {
  if (events.length === 0) {
    return null;
  }

  const latestByAgent = (agent: WorkflowUiEvent["agent"]) => [...events].reverse().find((event) => event.agent === agent) ?? null;
  const failureSummary = buildFailureSummary(events);
  const recovery = record.control?.recoveredAt && record.control.recoveryReason
    ? {
        status: "recovered",
        reason: record.control.recoveryReason,
        recovered_at: record.control.recoveredAt,
        recoverable: true,
        affected_task_run_ids: getRecoveredTaskRunIds(record),
      }
    : null;
  return {
    job_id: record.job.id,
    job_status: record.job.status,
    seq: events.at(-1)?.seq ?? 0,
    event_count: events.length,
    replay: {
      next_seq: (events.at(-1)?.seq ?? 0) + 1,
      can_resume_from: Math.max(0, events.at(0)?.seq ?? 0),
    },
    failure_summary: failureSummary,
    recovery,
    latest_planner: latestByAgent("planner"),
    latest_executor: latestByAgent("executor"),
    latest_tool: latestByAgent("tool"),
    latest_system: latestByAgent("system"),
  };
}

function mergeJobEvents(record: StoredJobRecord, persistedEvents: WorkflowUiEvent[]): WorkflowUiEvent[] {
  if (persistedEvents.length === 0) {
    return buildJobEvents(record);
  }
  if (persistedEvents.some((event) => event.type === "job.created")) {
    if (!record.control?.recoveredAt || persistedEvents.some((event) => event.type === "job.recovered")) {
      return persistedEvents;
    }
    const recoveryEvent = createRecoveryEvent(record, Math.max(...persistedEvents.map((event) => event.seq), 0) + 1);
    return recoveryEvent ? [...persistedEvents, recoveryEvent] : persistedEvents;
  }

  const fallbackEvents = buildJobEvents(record);
  const seen = new Set(fallbackEvents.map((event) => `${event.type}|${event.taskRunId ?? ""}|${event.step ?? ""}`));
  const merged = [...fallbackEvents];
  for (const event of persistedEvents) {
    const key = `${event.type}|${event.taskRunId ?? ""}|${event.step ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    merged.push(event);
    seen.add(key);
  }

  return merged
    .sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq)
    .map((event, index) => ({ ...event, seq: index + 1 }));
}

function recoverInterruptedJobs(): string[] {
  const recoveredJobIds: string[] = [];
  for (const stored of listStoredJobs()) {
    if (stored.status !== "running") {
      continue;
    }

    const updated = updateStoredJobRecord(stored.id, (record) => {
      if (record.job.status !== "running") {
        return record;
      }

      const recoveredAt = new Date().toISOString();
      return {
        ...record,
        savedAt: recoveredAt,
        job: {
          ...record.job,
          status: "blocked",
          verified: false,
          output: "Execution was interrupted by a service restart. The job can be resumed from the control plane.",
        },
        taskRuns: record.taskRuns.map((taskRun) => (
          taskRun.status === "completed" || taskRun.status === "failed" || taskRun.status === "blocked" || taskRun.status === "skipped"
            ? taskRun
            : {
                ...taskRun,
                status: taskRun.status === "awaiting_approval" ? "awaiting_approval" : "blocked",
                output: taskRun.output || "Execution was interrupted by a service restart.",
              }
        )),
        control: {
          ...record.control,
          recoveredAt,
          recoveryReason: "service_restart",
        },
      };
    });

    if (!updated || updated.job.status !== "blocked") {
      continue;
    }

    const recoveryEvent = createRecoveryEvent(updated, getNextSeq(stored.id));
    if (recoveryEvent) {
      appendEvent(recoveryEvent);
    }
    recoveredJobIds.push(stored.id);
  }

  return recoveredJobIds;
}

function buildJobResponse(record: StoredJobRecord): unknown {
  const latestStep = record.taskRuns.at(-1);
  const workflowSummary = buildWorkflowSummary(record);
  return {
    saved_at: record.savedAt,
    job: record.job,
    plan: record.plan,
    taskRuns: record.taskRuns,
    artifacts: record.artifacts,
    step_count: record.taskRuns.length,
    artifact_count: record.artifacts.length,
    latest_step: latestStep
      ? {
          id: latestStep.id,
          status: latestStep.status,
          verified: latestStep.verified,
          attempts: latestStep.attempts,
          latest_executor_status: latestExecutorStatus(record),
        }
      : null,
    workflow_summary: workflowSummary,
    control: record.control ?? {},
  };
}

function buildWorkflowSummary(record: StoredJobRecord): Record<string, unknown> {
  const counts = {
    pending: 0,
    in_progress: 0,
    awaiting_approval: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };

  for (const taskRun of record.taskRuns) {
    switch (taskRun.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "in_progress":
        counts.in_progress += 1;
        break;
      case "awaiting_approval":
        counts.awaiting_approval += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
    }
  }

  const currentTask = getWorkflowCurrentTask(record);
  const awaitingApprovalTask = getWorkflowAwaitingApprovalTask(record);
  const workflowGraph = record.workflowGraph ?? record.job.workflowGraph ?? buildWorkflowGraph(record.plan.id, record.taskRuns, record.plan.summary);

  return {
    workflow_id: record.plan.id,
    task_counts: counts,
    current_task: currentTask
      ? {
          id: currentTask.id,
          title: currentTask.title,
          status: currentTask.status,
          assignee: currentTask.assignee ?? null,
          depends_on: currentTask.dependsOn,
          verified: currentTask.verified,
          attempts: currentTask.attempts,
        }
      : null,
    awaiting_approval_task: awaitingApprovalTask
      ? {
          id: awaitingApprovalTask.id,
          title: awaitingApprovalTask.title,
          status: awaitingApprovalTask.status,
          assignee: awaitingApprovalTask.assignee ?? null,
        }
      : null,
    workflow_graph: workflowGraph,
    dag: workflowGraph,
    replan_history: workflowGraph.replan_history,
  };
}

function buildFailureSummary(events: WorkflowUiEvent[]): {
  total: number;
  by_category: Record<string, number>;
  latest_category: string | null;
  latest_summary: string | null;
} {
  const failures = events
    .filter((event) => isObjectRecord(event.meta) && typeof event.meta.failure_category === "string" && event.meta.failure_category.trim().length > 0)
    .map((event) => ({
      category: event.meta.failure_category as string,
      summary: event.summary,
    }));

  const byCategory: Record<string, number> = {};
  for (const failure of failures) {
    byCategory[failure.category] = (byCategory[failure.category] ?? 0) + 1;
  }

  const latest = failures.at(-1) ?? null;
  return {
    total: failures.length,
    by_category: byCategory,
    latest_category: latest?.category ?? null,
    latest_summary: latest?.summary ?? null,
  };
}

function getWorkflowCurrentTask(record: StoredJobRecord): TaskRun | null {
  return record.taskRuns.find((taskRun) =>
    taskRun.status === "awaiting_approval"
    || taskRun.status === "in_progress"
    || taskRun.status === "pending",
  ) ?? null;
}

function getWorkflowAwaitingApprovalTask(record: StoredJobRecord): TaskRun | null {
  return record.taskRuns.find((taskRun) => taskRun.status === "awaiting_approval") ?? null;
}

function buildWorkflowEvent(type: string, workflow: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    workflow,
    ...extra,
  });
}

function buildChatCompletionResponse(model: string, content: string, workflow?: unknown): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    workflow,
  };
}

function buildToolChatCompletionResponse(model: string, toolCalls: Array<{ id: string; name: string; arguments: string }>): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildChatCompletionChunk(model: string, id: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  });
}

function buildToolChatCompletionChunk(model: string, id: string, toolCall: { id: string; name: string; arguments: string }, finishReason: string | null, toolIndex = 0): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: toolIndex,
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
  });
}

function formatProgressUpdate(event: OrchestratorEvent): string | null {
  switch (event.type) {
    case "workflow.step.start":
      return buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, "正在规划下一步。");
    case "workflow.planner.decision": {
      const summary = getPlannerDecisionText(event.data);
      return summary
        ? buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, humanizePlannerSummary(summary))
        : buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, "正在整理下一步策略。");
    }
    case "workflow.executor.start": {
      const instruction = typeof event.data.instruction === "string" ? event.data.instruction.trim() : "";
      return instruction
        ? buildProgressCard(`步骤 ${event.step ?? 1} · ${inferExecutorPhaseLabel(instruction)}`, humanizeExecutorInstruction(instruction))
        : buildProgressCard(`步骤 ${event.step ?? 1} · 执行中`, "正在处理当前任务。");
    }
    case "workflow.executor.result": {
      const summary = getExecutorDisplaySummary(event.data);
      return summary
        ? buildProgressCard(`步骤 ${event.step ?? 1} · ${inferExecutionSummaryPhaseLabel(summary)}`, humanizeExecutionSummary(summary))
        : null;
    }
    case "workflow.tool.start": {
      const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
      return buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, humanizeToolStart(tool));
    }
    case "workflow.tool.result": {
      const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
      const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
      return summary
        ? buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, humanizeToolSummary(tool, summary))
        : buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, "当前操作已完成。");
    }
    default:
      return null;
  }
}

function buildProgressCard(title: string, summary: string): string {
  return `\n\n[${title}]\n${summary}\n`;
}

function compactProgressText(text: string, maxLength: number): string {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, ": ")
    .trim();

  const firstSentence = normalized.match(/.*?[.!?](\s|$)/)?.[0]?.trim() ?? normalized;
  const preferred = firstSentence.length >= 24 ? firstSentence : normalized;
  return truncateToolResultContent(preferred).slice(0, maxLength).trim();
}

function phaseLabelForTool(tool: string): string {
  switch (tool) {
    case "web_search":
      return "检索中";
    case "url_fetch":
    case "read_file":
      return "取证中";
    case "write_file":
      return "写作中";
    default:
      return "处理中";
  }
}

function inferExecutorPhaseLabel(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  if (/search the web|web searches?|web_search/i.test(normalized)) {
    return "检索中";
  }
  if (/read the artifact|read_file|runtime\/command-results|extract/i.test(normalized)) {
    return "取证中";
  }
  if (/write|report|summary|markdown|final/i.test(normalized)) {
    return "写作中";
  }
  return "执行中";
}

function inferExecutionSummaryPhaseLabel(summary: string): string {
  const normalized = summary.trim();
  if (/Found \d+ results/i.test(normalized)) {
    return "筛选中";
  }
  if (/Fetch failed/i.test(normalized) || /Read file/i.test(normalized)) {
    return "取证中";
  }
  if (/Wrote file/i.test(normalized)) {
    return "写作中";
  }
  if (/Collected \d+ useful artifacts/i.test(normalized)) {
    return "归纳中";
  }
  return "执行中";
}

function humanizePlannerSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (/search|web|benchmark|evidence|comparison/i.test(normalized)) {
    return "正在确定检索重点，并准备补齐关键对比证据。";
  }
  if (/consolidate|summarize|final/i.test(normalized)) {
    return "正在收拢已有信息，准备形成阶段性结论。";
  }
  if (/fetch|read|artifact|extract/i.test(normalized)) {
    return "正在检查现有资料，并决定下一步证据路径。";
  }
  return compactProgressText(normalized, 120);
}

function humanizeExecutorInstruction(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  if (/search the web|web searches?|web_search/i.test(normalized)) {
    return "正在检索支撑资料和基准对比信息。";
  }
  if (/read the artifact|read_file|runtime\/command-results|extract/i.test(normalized)) {
    return "正在读取已收集资料，并提取可用证据。";
  }
  if (/write|report|summary|markdown|final/i.test(normalized)) {
    return "正在整理已有发现，准备输出总结。";
  }
  return compactProgressText(normalized, 120);
}

function humanizeExecutionSummary(summary: string): string {
  const normalized = summary.trim();
  if (/Found \d+ results/i.test(normalized)) {
    const count = normalized.match(/Found (\d+) results/i)?.[1] ?? "多条";
    return `已收集 ${count} 条候选资料，正在筛选高质量证据。`;
  }
  if (/Fetch failed/i.test(normalized)) {
    return "部分页面暂时无法访问，正在调整证据路径。";
  }
  if (/Collected \d+ useful artifacts/i.test(normalized)) {
    const count = normalized.match(/Collected (\d+) useful artifacts/i)?.[1] ?? "多份";
    return `已沉淀 ${count} 份有效资料，准备进入归纳阶段。`;
  }
  if (/Read file/i.test(normalized)) {
    return "已读取一份已保存资料，并提炼关键细节。";
  }
  if (/Search queries returned irrelevant results/i.test(normalized)) {
    return "本轮检索结果相关性不足，正在调整关键词和证据路径。";
  }
  if (/Fetched\s+(\S+)/i.test(normalized)) {
    return "已读取目标页面，正在提取其中的关键信息。";
  }
  if (/Wrote file\s+(.+)/i.test(normalized)) {
    const target = normalized.match(/Wrote file\s+(.+)/i)?.[1]?.trim() ?? "";
    const fileName = target.split(/[\\/]/).pop() || target;
    return target ? `报告已保存到本地文件：${fileName}` : "报告已保存到本地文件。";
  }
  return compactProgressText(normalized, 120);
}

function humanizeToolStart(tool: string): string {
  switch (tool) {
    case "web_search":
      return "正在搜索候选资料来源。";
    case "url_fetch":
      return "正在打开页面，提取更具体的证据。";
    case "read_file":
      return "正在读取已保存的过程资料。";
    default:
      return `正在执行 ${tool}。`;
  }
}

function humanizeToolSummary(tool: string, summary: string): string {
  const normalized = summary.trim();
  if (tool === "web_search") {
    const count = normalized.match(/Found (\d+) results/i)?.[1];
    if (count) {
      return `已找到 ${count} 条候选结果，正在筛选可信来源。`;
    }
    if (/returned no parsed results/i.test(normalized)) {
      return "这次搜索还没有拿到可用结果，正在尝试调整关键词。";
    }
  }

  if (tool === "url_fetch") {
    if (/Fetched\s+(\S+)/i.test(normalized)) {
      const url = normalized.match(/Fetched\s+(\S+)/i)?.[1] ?? "source";
      return `已抓取页面内容：${url}。`;
    }
    if (/Fetch failed/i.test(normalized)) {
      return "目标页面暂时无法读取，正在尝试其他来源。";
    }
  }

  if (tool === "read_file") {
    if (/Read file/i.test(normalized)) {
      return "已载入保存的过程资料，正在深入分析。";
    }
  }

  return compactProgressText(normalized, 120);
}

type ProgressAggregationState = {
  tool: string;
  step?: number;
  startCount: number;
  resultCount: number;
  successCount: number;
  failureCount: number;
  candidateResults: number;
  summaries: string[];
};

function shouldAggregateToolProgress(tool: string): boolean {
  return tool === "web_search" || tool === "url_fetch" || tool === "read_file";
}

function createProgressAggregationState(tool: string, step?: number): ProgressAggregationState {
  return {
    tool,
    step,
    startCount: 0,
    resultCount: 0,
    successCount: 0,
    failureCount: 0,
    candidateResults: 0,
    summaries: [],
  };
}

function buildAggregatedToolStart(tool: string): string {
  switch (tool) {
    case "web_search":
      return buildProgressCard("检索中", "正在扩展检索范围，补充更多候选资料。");
    case "url_fetch":
      return buildProgressCard("取证中", "正在打开候选页面，提取关键证据。");
    case "read_file":
      return buildProgressCard("取证中", "正在读取已保存资料，补充现有证据。");
    default:
      return buildProgressCard(phaseLabelForTool(tool), humanizeToolStart(tool));
  }
}

function buildAggregatedToolResult(state: ProgressAggregationState): string | null {
  if (state.resultCount === 0) {
    return null;
  }

  if (state.tool === "web_search") {
    if (state.resultCount <= 1) {
      const summary = state.summaries.at(-1);
      return summary ? buildProgressCard("检索中", summary) : null;
    }
    const total = state.candidateResults > 0 ? `累计找到 ${state.candidateResults} 条候选结果` : "已补充多轮候选结果";
    return buildProgressCard("检索中", `已完成 ${state.resultCount} 轮搜索，${total}，正在筛选可信来源。`);
  }

  if (state.tool === "url_fetch") {
    if (state.resultCount <= 1) {
      const summary = state.summaries.at(-1);
      return summary ? buildProgressCard("取证中", summary) : null;
    }
    if (state.failureCount > 0 && state.successCount > 0) {
      return buildProgressCard("取证中", `已读取 ${state.successCount} 个页面，另有 ${state.failureCount} 个页面暂时无法访问，正在切换其他来源。`);
    }
    if (state.failureCount > 0) {
      return buildProgressCard("取证中", `连续 ${state.failureCount} 个页面暂时无法读取，正在调整证据来源。`);
    }
    return buildProgressCard("取证中", `已读取 ${state.successCount} 个页面，正在整理其中的关键证据。`);
  }

  if (state.tool === "read_file") {
    if (state.resultCount <= 1) {
      const summary = state.summaries.at(-1);
      return summary ? buildProgressCard("取证中", summary) : null;
    }
    return buildProgressCard("取证中", `已读取 ${state.resultCount} 份过程资料，正在提炼其中的关键信息。`);
  }

  const summary = state.summaries.at(-1);
  return summary ? buildProgressCard(phaseLabelForTool(state.tool), summary) : null;
}

function accumulateToolProgressResult(state: ProgressAggregationState, event: OrchestratorEvent): void {
  const ok = event.data.ok === true;
  const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
  state.resultCount += 1;
  state.successCount += ok ? 1 : 0;
  state.failureCount += ok ? 0 : 1;

  if (summary) {
    state.summaries.push(humanizeToolSummary(state.tool, summary));
    if (state.tool === "web_search") {
      const count = summary.match(/Found (\d+) results/i)?.[1];
      if (count) {
        state.candidateResults += Number(count);
      }
    }
  }
}

function sseWrite(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`);
}

function sseWriteEvent(res: ServerResponse, eventName: string, payload: string, eventId?: number): void {
  if (typeof eventId === "number" && Number.isFinite(eventId)) {
    res.write(`id: ${eventId}\n`);
  }
  res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
}

function normalizeIncomingTools(tools: unknown): typeof TOOL_DEFINITIONS {
  if (!Array.isArray(tools) || tools.length === 0) {
    return TOOL_DEFINITIONS;
  }

  const requestedNames = tools.flatMap((tool) => {
    if (!isObjectRecord(tool)) {
      return [];
    }

    if (typeof tool.name === "string") {
      return [tool.name];
    }

    if (tool.type === "function" && isObjectRecord(tool.function) && typeof tool.function.name === "string") {
      return [tool.function.name];
    }

    return [];
  });

  const filtered = TOOL_DEFINITIONS.filter((tool) => requestedNames.includes(tool.name));
  return filtered.length > 0 ? filtered : TOOL_DEFINITIONS;
}

function normalizeOpenAIToolMessages(messages: OpenAIMessage[]): ChatMessage[] {
  return messages.flatMap<ChatMessage>((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }

    const asRecord = message as Record<string, unknown>;
    const role = typeof asRecord.role === "string" ? asRecord.role : "user";
    const content = getMessageText(message);

    if (role === "tool") {
      return [{
        role: "tool",
        content: truncateToolResultContent(content),
        tool_call_id: typeof asRecord.tool_call_id === "string" ? asRecord.tool_call_id : undefined,
        name: typeof asRecord.name === "string" ? asRecord.name : undefined,
      }];
    }

    const toolCalls = Array.isArray(asRecord.tool_calls)
      ? asRecord.tool_calls.flatMap((call) => {
          if (!isObjectRecord(call)) {
            return [];
          }
          const fn = isObjectRecord(call.function) ? call.function : {};
        return [{
          id: typeof call.id === "string" ? call.id : undefined,
          type: typeof call.type === "string" ? call.type : "function",
          function: {
            name: typeof fn.name === "string" ? fn.name : undefined,
            arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
          },
        }];
      })
      : undefined;

    return [{
      role,
      content,
      tool_calls: toolCalls,
    }];
  });
}

async function executeTaskGoal(
  userGoal: string,
  model: string | undefined,
  requirePlannerCircuit: boolean,
  onEvent?: OrchestratorEventCallback,
  fixedIds?: FixedTaskIds,
  onRegistered?: (jobId: string) => void,
): Promise<TaskExecutionPayload> {
  const jobId = fixedIds?.jobId ?? `job_${randomUUID()}`;
  const planId = fixedIds?.planId ?? `plan_${randomUUID()}`;
  const taskRunId = fixedIds?.taskRunId ?? `taskrun_${randomUUID()}`;
  const abortController = new AbortController();
  const emitUiEvent = (event: WorkflowUiEvent) => {
    appendEvent(event);
  };
  const emitLifecycle = (type: string, title: string, summary: string, status: WorkflowUiEvent["status"], meta: Record<string, unknown> = {}, phase: WorkflowUiEvent["phase"] = "result") => {
    emitUiEvent(createLifecycleEvent({
      jobId,
      seq: getNextSeq(jobId),
      time: new Date().toISOString(),
      type,
      title,
      summary,
      status,
      phase,
      taskRunId,
      meta: attachFailureCategory(type, status, summary, meta),
    }));
  };
  const forwardRuntimeEvent: OrchestratorEventCallback = (event) => {
    persistTeamApprovalSnapshot(jobId, event);
    emitUiEvent(normalizeWorkflowEvent(
      { type: event.type, step: event.step, data: event.data } as InternalWorkflowEvent,
      jobId,
      getNextSeq(jobId),
      new Date().toISOString(),
      taskRunId,
    ));
    onEvent?.(event);
  };

  registerActiveJobSession(jobId, userGoal, abortController);
  onRegistered?.(jobId);
  const pendingTaskRun = createTaskRunRecord({
    id: taskRunId,
    title: "Primary Task",
    description: userGoal,
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const pendingPlan = createPlanRecord({
    id: planId,
    goal: userGoal,
    mode: "task",
    taskRunIds: [taskRunId],
    summary: "Single-task orchestration run.",
  });
  const pendingJob = createJobRecord({
    id: jobId,
    goal: userGoal,
    mode: "task",
    status: "running",
    verified: false,
    output: "Running...",
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
  });
  persistWorkflowPayload({
    job: pendingJob,
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
  });
  emitLifecycle("job.created", "Job created", "A new job was created and queued for execution.", "running", {
    mode: pendingJob.mode,
    goal: pendingJob.goal,
    plan_id: pendingPlan.id,
  }, "start");
  emitLifecycle("job.started", "Job started", "Execution started for the requested goal.", "running", {
    plan_id: pendingPlan.id,
    task_run_id: pendingTaskRun.id,
  }, "start");
  try {
    if (abortController.signal.aborted) {
      throw new Error("Run cancelled before start.");
    }

    let payload: TaskExecutionPayload;
    let verificationConfig: OrchestratorConfig | undefined;
    if (injectedTaskExecutor) {
      payload = await injectedTaskExecutor(userGoal, model, requirePlannerCircuit, {
        jobId,
        planId,
        taskRunId,
        signal: abortController.signal,
        emitEvent: forwardRuntimeEvent,
      });
    } else {
      const baseConfig = loadConfig();
      const modelSelection = resolveRequestedModel(baseConfig, model);
      verificationConfig = modelSelection.resolvedConfig;
      if (requirePlannerCircuit) {
        assertPlannerCircuitClosed();
      }
      const logger = createRunLogger(userGoal);
      const routing = loadTaskRoutingConfig(modelSelection.resolvedConfig.taskRoutingPath);
      const taskType = detectTaskType(userGoal, routing);
      const routePolicy = getRoutePolicy(taskType, routing);
      let result;
      try {
        result = await runTask(modelSelection.resolvedConfig, userGoal, routePolicy, logger, undefined, {
          abortSignal: abortController.signal,
          jobId,
          planId,
          taskRunId,
          onEvent: forwardRuntimeEvent,
        });
        if (requirePlannerCircuit) {
          markPlannerSuccess();
        }
      } catch (error) {
        if (requirePlannerCircuit && error instanceof PlannerUnavailableError) {
          throw markPlannerFailure(error.message);
        }
        throw error;
      }

      payload = {
        content: result.output || "",
        logPath: logger.logPath,
        resolvedModel: modelSelection.exposed.id,
        job: result.job,
        plan: result.plan,
        taskRuns: result.taskRuns,
        artifacts: result.artifacts,
      };
    }

    const verifiedJob = await verifyWorkflowPayload(payload, {
      jobId,
      goal: userGoal,
      config: verificationConfig,
      emitLifecycle,
    });

    const jobRecordPath = persistWorkflowPayload({
      job: verifiedJob,
      plan: payload.plan,
      taskRuns: payload.taskRuns,
      artifacts: payload.artifacts,
    });
    emitLifecycle(mapJobStatusToLifecycleType(verifiedJob.status), "Job finished", `Job finished with status ${verifiedJob.status}.`, mapJobStatusToUiStatus(verifiedJob.status), {
      verified: verifiedJob.verified,
      output_preview: verifiedJob.output.slice(0, 200),
      log_path: payload.logPath,
      job_record_path: jobRecordPath,
    }, "final");

    console.error(`Run log: ${payload.logPath}`);
    console.error(`Job record: ${jobRecordPath}`);
    return {
      ...payload,
      job: verifiedJob,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelledRecord = readJobRecord(jobId);
    const wasCancelled = Boolean(cancelledRecord?.control?.cancelledAt);
    updateStoredJobRecord(jobId, (record) => ({
      ...record,
      savedAt: new Date().toISOString(),
      job: {
        ...record.job,
        status: record.control?.cancelledAt ? "cancelled" : "failed",
        verified: false,
        output: message,
      },
      taskRuns: record.taskRuns.map((taskRun) => ({
        ...taskRun,
        status: record.control?.cancelledAt ? "blocked" : "failed",
        output: taskRun.output || message,
      })),
    }));
    emitLifecycle(
      wasCancelled ? "job.cancelled" : "job.failed",
      wasCancelled ? "Job cancelled" : "Job failed",
      truncateToolResultContent(message || (wasCancelled ? "Job cancelled." : "Job failed.")),
      wasCancelled ? "blocked" : "failed",
      { error: message },
      "final",
    );
    throw error;
  } finally {
    unregisterActiveJobSession(jobId);
  }
}

async function executeTeamGoal(
  userGoal: string,
  model: string | undefined,
  fixedIds?: FixedTaskIds,
  approvalMode?: string,
): Promise<TaskExecutionPayload> {
  const jobId = fixedIds?.jobId ?? `job_${randomUUID()}`;
  const planId = fixedIds?.planId ?? `plan_${randomUUID()}`;
  const taskRunId = fixedIds?.taskRunId ?? `taskrun_${randomUUID()}`;
  const abortController = new AbortController();
  const emitUiEvent = (event: WorkflowUiEvent) => {
    appendEvent(event);
  };
  const emitLifecycle = (type: string, title: string, summary: string, status: WorkflowUiEvent["status"], meta: Record<string, unknown> = {}, phase: WorkflowUiEvent["phase"] = "result") => {
    emitUiEvent(createLifecycleEvent({
      jobId,
      seq: getNextSeq(jobId),
      time: new Date().toISOString(),
      type,
      title,
      summary,
      status,
      phase,
      taskRunId,
      meta: attachFailureCategory(type, status, summary, meta),
    }));
  };
  const forwardRuntimeEvent: OrchestratorEventCallback = (event) => {
    emitUiEvent(normalizeWorkflowEvent(
      { type: event.type, step: event.step, data: event.data } as InternalWorkflowEvent,
      jobId,
      getNextSeq(jobId),
      new Date().toISOString(),
      taskRunId,
    ));
  };

  registerActiveJobSession(jobId, userGoal, abortController);
  const pendingTaskRun = createTaskRunRecord({
    id: taskRunId,
    title: "Team Root Task",
    description: userGoal,
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const pendingPlan = createPlanRecord({
    id: planId,
    goal: userGoal,
    mode: "team",
    taskRunIds: [taskRunId],
    summary: "Team orchestration run.",
  });
  const pendingJob = createJobRecord({
    id: jobId,
    goal: userGoal,
    mode: "team",
    status: "running",
    verified: false,
    output: "Running...",
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
  });
  persistWorkflowPayload({
    job: pendingJob,
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
  });
  emitLifecycle("job.created", "Job created", "A new team job was created and queued for execution.", "running", {
    mode: pendingJob.mode,
    goal: pendingJob.goal,
    plan_id: pendingPlan.id,
  }, "start");
  emitLifecycle("job.started", "Job started", "Execution started for the requested team goal.", "running", {
    plan_id: pendingPlan.id,
    task_run_id: pendingTaskRun.id,
  }, "start");

  try {
    let payload: TaskExecutionPayload;
    let verificationConfig: OrchestratorConfig | undefined;
    if (injectedTeamExecutor) {
      payload = await injectedTeamExecutor(userGoal, model, {
        jobId,
        planId,
        taskRunId,
        signal: abortController.signal,
        emitEvent: forwardRuntimeEvent,
      });
    } else {
      const config = loadConfig();
      verificationConfig = config;
      configureSearchTools(config.search);
      const logger = createRunLogger(userGoal);
      const teamAgents = resolveTeamAgents(config);
      const tracer = new Tracer(logger);
      const teamConfig = approvalMode === "always"
        ? { onApproval: createTeamApprovalGate(jobId) }
        : undefined;
      const result = await runTeam(config, userGoal, teamAgents, logger, tracer, teamConfig, undefined, {
        abortSignal: abortController.signal,
        jobId,
        planId,
        taskRunId,
        onEvent: forwardRuntimeEvent,
      });
      payload = {
        content: result.finalAnswer,
        logPath: logger.logPath,
        resolvedModel: OPENAI_MODEL_ID,
        job: {
          ...result.job,
          id: jobId,
          plan: { ...result.plan, id: planId },
        },
        plan: { ...result.plan, id: planId },
        taskRuns: result.taskRuns,
        artifacts: result.artifacts,
      };
    }

    const verifiedJob = await verifyWorkflowPayload(payload, {
      jobId,
      goal: userGoal,
      config: verificationConfig,
      emitLifecycle,
    });

    const jobRecordPath = persistWorkflowPayload({
      job: verifiedJob,
      plan: payload.plan,
      taskRuns: payload.taskRuns,
      artifacts: payload.artifacts,
    });
    emitLifecycle(mapJobStatusToLifecycleType(verifiedJob.status), "Job finished", `Job finished with status ${verifiedJob.status}.`, mapJobStatusToUiStatus(verifiedJob.status), {
      verified: verifiedJob.verified,
      output_preview: verifiedJob.output.slice(0, 200),
      log_path: payload.logPath,
      job_record_path: jobRecordPath,
    }, "final");
    return {
      ...payload,
      job: verifiedJob,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelledRecord = readJobRecord(jobId);
    const wasCancelled = Boolean(cancelledRecord?.control?.cancelledAt);
    updateStoredJobRecord(jobId, (record) => ({
      ...record,
      savedAt: new Date().toISOString(),
      job: {
        ...record.job,
        status: record.control?.cancelledAt ? "cancelled" : "failed",
        verified: false,
        output: message,
      },
      taskRuns: record.taskRuns.map((taskRun) => ({
        ...taskRun,
        status: record.control?.cancelledAt ? "blocked" : "failed",
        output: taskRun.output || message,
      })),
    }));
    emitLifecycle(
      wasCancelled ? "job.cancelled" : "job.failed",
      wasCancelled ? "Job cancelled" : "Job failed",
      truncateToolResultContent(message || (wasCancelled ? "Job cancelled." : "Job failed.")),
      wasCancelled ? "blocked" : "failed",
      { error: message },
      "final",
    );
    throw error;
  } finally {
    unregisterActiveJobSession(jobId);
  }
}

async function executeJobByMode(
  mode: Job["mode"],
  goal: string,
  model: string | undefined,
  options?: JobExecutionOptions,
): Promise<TaskExecutionPayload> {
  if (mode === "team") {
    return executeTeamGoal(goal, model, options?.fixedIds, options?.approvalMode);
  }
  return executeTaskGoal(goal, model, options?.requirePlannerCircuit ?? true, undefined, options?.fixedIds);
}

async function runTaskFromRequest(body: ChatCompletionRequest): Promise<TaskExecutionPayload> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(body.messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const controlResponse = buildClaudeControlResponse(userGoal);
  if (controlResponse) {
    return controlResponse;
  }

  return executeTaskGoal(userGoal, body.model, false);
}

async function runTaskFromMessages(messages: OpenAIMessage[], model: string | undefined, onEvent?: OrchestratorEventCallback): Promise<TaskExecutionPayload> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const controlResponse = buildClaudeControlResponse(userGoal);
  if (controlResponse) {
    return controlResponse;
  }

  return executeTaskGoal(userGoal, model, true, onEvent);
}

async function runTaskFromMessagesWithRegistration(
  messages: OpenAIMessage[],
  model: string | undefined,
  onEvent?: OrchestratorEventCallback,
  onRegistered?: (jobId: string) => void,
): Promise<TaskExecutionPayload> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const controlResponse = buildClaudeControlResponse(userGoal);
  if (controlResponse) {
    return controlResponse;
  }

  return executeTaskGoal(userGoal, model, true, onEvent, undefined, onRegistered);
}

function attachRequestAbortCancellation(
  res: ServerResponse,
  lookupJobId: () => string | null,
): () => void {
  let detached = false;
  let settled = false;

  const handleDisconnect = () => {
    if (detached || settled) {
      return;
    }
    const jobId = lookupJobId();
    if (!jobId) {
      return;
    }
    cancelActiveJobSession(jobId, `Client disconnected before response completed for job ${jobId}.`);
  };

  res.on("close", handleDisconnect);

  return () => {
    detached = true;
    settled = true;
  };
}

async function runToolMode(messages: ChatMessage[], model: string | undefined, tools: unknown, requestOverrides?: import("./providers/openai-compatible.js").CompletionOverrides): Promise<{
  resolvedModel: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  content: string;
}> {
  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, model);
  const allowedTools = normalizeIncomingTools(tools);
  const toolRoundCount = countToolModeRounds(messages);
  const lastMessage = messages[messages.length - 1];
  const forceTextResponse = toolRoundCount >= MAX_TOOL_MODE_ROUNDS
    || shouldForceTextResponseForToolMessage(lastMessage);
  const effectiveTools = forceTextResponse ? undefined : allowedTools;

  const response = await runChatCompletionDetailed(modelSelection.resolvedConfig.executor, messages, effectiveTools, undefined, requestOverrides);

  return {
    resolvedModel: modelSelection.exposed.id,
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id || `call_${Date.now()}`,
      name: call.name,
      arguments: call.arguments,
    })),
    content: response.content || "",
  };
}

async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, buildModelsResponse());
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = buildHealthResponse();
  jsonResponse(res, payload.status === "ok" ? 200 : 503, payload);
}

async function handleListJobs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: listStoredJobs(),
  });
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<CreateJobRequest>(req);
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
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

async function handleGetJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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
  jsonResponse(res, 200, buildJobResponse(record));
}

async function handleGetJobArtifacts(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleGetJobSteps(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleGetJobRuntimeProfile(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleGetJobEvents(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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
  const limitRaw = url.searchParams.get("limit");
  const sinceSeq = sinceSeqRaw ? Number.parseInt(sinceSeqRaw, 10) : undefined;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  let events = mergeJobEvents(record, loadEventsFromDisk(jobId));
  if (Number.isFinite(sinceSeq)) {
    events = events.filter((event) => event.seq > (sinceSeq as number));
  }
  if (Number.isFinite(limit) && (limit as number) >= 0) {
    events = events.slice(0, limit as number);
  }
  jsonResponse(res, 200, {
    job_id: jobId,
    count: events.length,
    snapshot: buildEventSnapshot(record, events),
    events,
  });
}

async function handleJobStream(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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
  const lastEventIdRaw = getHeaderValue(_req, "last-event-id");
  const requestedSinceSeq = sinceSeqRaw ? Number.parseInt(sinceSeqRaw, 10) : undefined;
  const requestedLastEventId = lastEventIdRaw ? Number.parseInt(lastEventIdRaw, 10) : undefined;
  const replayCursor = Number.isFinite(requestedSinceSeq)
    ? requestedSinceSeq as number
    : Number.isFinite(requestedLastEventId)
      ? requestedLastEventId as number
      : undefined;

  // Load existing events from disk
  const existingEvents = mergeJobEvents(record, loadEventsFromDisk(jobId));
  const replayEvents = replayCursor !== undefined
    ? existingEvents.filter((event) => event.seq > replayCursor)
    : (existingEvents.length > 0 ? existingEvents : getEvents(jobId));

  // Set SSE headers
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Send initial snapshot
  const snapshot = buildEventSnapshot(record, existingEvents);
  if (snapshot) {
    sseWriteEvent(res, "job.snapshot", JSON.stringify({
      ...snapshot,
      replay: {
        ...(isObjectRecord(snapshot.replay) ? snapshot.replay : {}),
        resumed_from_seq: replayCursor ?? null,
        replayed_count: replayEvents.length,
      },
    }));
  }

  // Send replay events
  for (const event of replayEvents) {
    sseWriteEvent(res, "job.event", JSON.stringify(event), event.seq);
  }

  // Subscribe to new events
  const unsubscribe = subscribe(jobId, (event) => {
    try {
      sseWriteEvent(res, "job.event", JSON.stringify(event), event.seq);
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

async function handleCancelJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleRetryJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleJobTimeline(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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
  );

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleApproveJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleResumeJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
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

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ChatCompletionRequest>(req);
  const toolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  const mirrorProgressToContent = body.stream && !toolMode && shouldMirrorProgressToContent(body.include_progress_updates);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);

  if (toolMode) {
    if (extractLatestOpenAIWriteToolCompletion(body.messages)) {
      jsonResponse(res, 200, buildChatCompletionResponse(body.model || OPENAI_MODEL_ID, "File written successfully."));
      return;
    }
    if (extractLatestOpenAIResearchReadCompletion(body.messages)) {
      jsonResponse(res, 200, buildChatCompletionResponse(body.model || OPENAI_MODEL_ID, "Research evidence read successfully. Please summarize and finish without further tool calls."));
      return;
    }

    const overrides: import("./providers/openai-compatible.js").CompletionOverrides = {};
    if (body.temperature !== undefined) overrides.temperature = body.temperature;
    if (body.max_tokens !== undefined) overrides.maxTokens = body.max_tokens;
    if (body.top_p !== undefined) overrides.topP = body.top_p;
    if (body.stop !== undefined) overrides.stop = body.stop;
    if (body.tool_choice !== undefined) overrides.toolChoice = body.tool_choice;
    const toolResult = await runToolMode(normalizeOpenAIToolMessages(body.messages || []), body.model, body.tools, overrides);

    if (!body.stream) {
      if (toolResult.toolCalls.length > 0) {
        jsonResponse(res, 200, buildToolChatCompletionResponse(toolResult.resolvedModel, toolResult.toolCalls));
      } else {
        jsonResponse(res, 200, buildChatCompletionResponse(toolResult.resolvedModel, summarizeToolResultContent(toolResult.content) || toolResult.content));
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const streamId = `chatcmpl-${Date.now()}`;
    sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, { role: "assistant", content: "" }, null));
    if (toolResult.toolCalls.length > 0) {
      for (let i = 0; i < toolResult.toolCalls.length; i++) {
        sseWrite(res, buildToolChatCompletionChunk(toolResult.resolvedModel, streamId, toolResult.toolCalls[i], null, i));
      }
      sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, {}, "tool_calls"));
    } else {
      const finalText = summarizeToolResultContent(toolResult.content) || toolResult.content;
      for (const chunk of splitContentForStreaming(finalText)) {
        sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, { content: chunk }, null));
      }
      sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, {}, "stop"));
    }
    if (includeWorkflowEvents) {
      sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", {
        job: null,
        plan: null,
        taskRuns: [],
        artifacts: [],
      }, {
        mode: "tool",
        model: toolResult.resolvedModel,
        toolCalls: toolResult.toolCalls,
        content: toolResult.content,
      }));
    }
    res.end("data: [DONE]\n\n");
    return;
  }

  // For streaming, set up SSE headers first so events can be sent in real-time
  if (body.stream) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const streamId = `chatcmpl-${Date.now()}`;
    sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { role: "assistant", content: "" }, null));

    const onEvent: OrchestratorEventCallback | undefined = includeWorkflowEvents
      ? (event) => {
          try {
            sseWriteEvent(res, event.type, JSON.stringify({
              type: event.type,
              step: event.step,
              ...event.data,
            }));
          } catch {
            // Ignore write errors (client may have disconnected)
          }
        }
      : undefined;
    let emittedProgressChunks = false;
    let pendingToolAggregation: ProgressAggregationState | null = null;
    const writeProgressText = (progressText: string) => {
      emittedProgressChunks = true;
      for (const chunk of splitContentForStreaming(progressText)) {
        sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { content: chunk }, null));
      }
    };
    const flushPendingToolAggregation = () => {
      if (!pendingToolAggregation) {
        return;
      }
      const progressText = buildAggregatedToolResult(pendingToolAggregation);
      pendingToolAggregation = null;
      if (!progressText) {
        return;
      }
      writeProgressText(progressText);
    };
    const emitProgressChunk = (event: OrchestratorEvent) => {
      if (!mirrorProgressToContent) {
        return;
      }

      if (event.type === "workflow.tool.start") {
        const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
        if (!shouldAggregateToolProgress(tool)) {
          flushPendingToolAggregation();
          const progressText = formatProgressUpdate(event);
          if (progressText) {
            writeProgressText(progressText);
          }
          return;
        }

        if (!pendingToolAggregation || pendingToolAggregation.tool !== tool || pendingToolAggregation.step !== event.step) {
          flushPendingToolAggregation();
          pendingToolAggregation = createProgressAggregationState(tool, event.step);
          pendingToolAggregation.startCount = 1;
          writeProgressText(buildAggregatedToolStart(tool));
          return;
        }

        pendingToolAggregation.startCount += 1;
        return;
      }

      if (event.type === "workflow.tool.result") {
        const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
        if (!shouldAggregateToolProgress(tool)) {
          flushPendingToolAggregation();
          const progressText = formatProgressUpdate(event);
          if (progressText) {
            writeProgressText(progressText);
          }
          return;
        }

        if (!pendingToolAggregation || pendingToolAggregation.tool !== tool || pendingToolAggregation.step !== event.step) {
          flushPendingToolAggregation();
          pendingToolAggregation = createProgressAggregationState(tool, event.step);
        }
        accumulateToolProgressResult(pendingToolAggregation, event);
        return;
      }

      flushPendingToolAggregation();
      const progressText = formatProgressUpdate(event);
      if (!progressText) {
        return;
      }
      writeProgressText(progressText);
    };
    const combinedOnEvent: OrchestratorEventCallback | undefined = (event) => {
      emitProgressChunk(event);
      onEvent?.(event);
    };

    try {
      const resultForModel = await runTaskFromMessagesWithRegistration(
        normalizeChatMessages(body.messages || []),
        body.model,
        combinedOnEvent,
        (jobId) => { requestJobId = jobId; },
      );
      const requestedModel = resultForModel.resolvedModel;
      const workflow = buildWorkflowPayload(resultForModel);
      flushPendingToolAggregation();

      if (mirrorProgressToContent && emittedProgressChunks) {
        sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: "\n[最终结论]\n" }, null));
      }
      const chunks = splitContentForStreaming(resultForModel.content);
      for (const chunk of chunks) {
        sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: chunk }, null));
      }

      sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, {}, "stop"));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
          mode: "task",
          model: requestedModel,
          status: resultForModel.job.status,
        }));
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { content: `Error: ${message}` }, "stop"));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.failed", buildWorkflowEvent("workflow.failed", {}, {
          mode: "task",
          error: message,
        }));
      }
      res.end("data: [DONE]\n\n");
    } finally {
      detachRequestAbort();
    }
    return;
  }

  // Non-streaming path
  try {
    const resultForModel = await runTaskFromMessagesWithRegistration(
      normalizeChatMessages(body.messages || []),
      body.model,
      undefined,
      (jobId) => { requestJobId = jobId; },
    ).catch((error) => { throw error; });
    const requestedModel = resultForModel.resolvedModel;
    const workflow = buildWorkflowPayload(resultForModel);
    jsonResponse(res, 200, buildChatCompletionResponse(requestedModel, resultForModel.content, workflow));
  } finally {
    detachRequestAbort();
  }
}

function buildResponsesOutput(content: string): unknown[] {
  return [
    {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: content,
          annotations: [],
        },
      ],
    },
  ];
}

function buildResponsesResponse(model: string, content: string, workflow?: unknown): unknown {
  return {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: buildResponsesOutput(content),
    output_text: content,
    error: null,
    workflow,
  };
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ResponsesRequest>(req);
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  const messages = normalizeResponsesInput(body.input, body.instructions);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);
  const result = await runTaskFromMessagesWithRegistration(messages, body.model, undefined, (jobId) => {
    requestJobId = jobId;
  });
  const workflow = buildWorkflowPayload(result);

  if (!body.stream) {
    try {
      jsonResponse(res, 200, buildResponsesResponse(result.resolvedModel, result.content, workflow));
    } finally {
      detachRequestAbort();
    }
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const responseId = `resp_${Date.now()}`;
  sseWrite(res, JSON.stringify({ type: "response.created", response: { id: responseId, model: result.resolvedModel, status: "in_progress" } }));
  for (const chunk of splitContentForStreaming(result.content)) {
    sseWrite(res, JSON.stringify({ type: "response.output_text.delta", delta: chunk }));
  }
  sseWrite(res, JSON.stringify({ type: "response.completed", response: { id: responseId, model: result.resolvedModel, status: "completed" } }));
  if (includeWorkflowEvents) {
    sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
      mode: "task",
      model: result.resolvedModel,
      status: result.job.status,
    }));
  }
  try {
    res.end("data: [DONE]\n\n");
  } finally {
    detachRequestAbort();
  }
}

function buildAnthropicMessageResponse(model: string, content: string, workflow?: unknown): unknown {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "text",
        text: content,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
    workflow,
  };
}

async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<AnthropicMessagesRequest>(req);
  const messages = normalizeAnthropicMessages(body.messages, body.system);
  const requestedToolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolHistory = hasAnthropicToolHistory(body.messages);
  const toolMode = requestedToolMode && hasToolHistory;
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);

  if (requestedToolMode && !hasToolHistory) {
    const result = await runTaskFromMessagesWithRegistration(messages, body.model, undefined, (jobId) => {
      requestJobId = jobId;
    });
    const workflow = buildWorkflowPayload(result);

    if (!body.stream) {
      try {
        jsonResponse(res, 200, buildAnthropicMessageResponse(result.resolvedModel, summarizeToolResultContent(result.content) || result.content, workflow));
      } finally {
        detachRequestAbort();
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const messageId = `msg_${Date.now()}`;
    res.write(`event: message_start\n`);
    sseWrite(res, JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: result.resolvedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
    res.write(`event: content_block_start\n`);
    sseWrite(res, JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }));
    for (const chunk of splitContentForStreaming(summarizeToolResultContent(result.content) || result.content)) {
      res.write(`event: content_block_delta\n`);
      sseWrite(res, JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      }));
    }
    res.write(`event: content_block_stop\n`);
    sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
    res.write(`event: message_delta\n`);
    sseWrite(res, JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }));
    if (includeWorkflowEvents) {
      sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
        mode: "task",
        model: result.resolvedModel,
        status: result.job.status,
      }));
    }
    try {
      res.write(`event: message_stop\n`);
      sseWrite(res, JSON.stringify({ type: "message_stop" }));
      res.end();
    } finally {
      detachRequestAbort();
    }
    return;
  }

  detachRequestAbort();

  if (toolMode) {
    if (extractLatestAnthropicWriteToolCompletion(body.messages)) {
      jsonResponse(res, 200, buildAnthropicMessageResponse(body.model || OPENAI_MODEL_ID, "File written successfully."));
      return;
    }
    if (extractLatestAnthropicResearchReadCompletion(body.messages)) {
      jsonResponse(res, 200, buildAnthropicMessageResponse(body.model || OPENAI_MODEL_ID, "Research evidence read successfully. Please summarize and finish without further tool calls."));
      return;
    }

    const anthropicTools = body.tools ?? [];
    const convertedTools = anthropicTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name || "",
        description: tool.description || "",
        parameters: tool.input_schema || {},
      },
    }));
    const toolResult = await runToolMode(normalizeAnthropicToolMessages(body.messages, body.system), body.model, convertedTools);

    if (!body.stream) {
      if (toolResult.toolCalls.length > 0) {
        jsonResponse(res, 200, {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: toolResult.resolvedModel,
          content: toolResult.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: safeParseToolInput(call.arguments),
          })),
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        });
      } else {
        const finalText = summarizeToolResultContent(toolResult.content) || "Tool work completed. Please summarize and finish without further tool calls.";
        jsonResponse(res, 200, buildAnthropicMessageResponse(toolResult.resolvedModel, finalText));
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const messageId = `msg_${Date.now()}`;
    res.write(`event: message_start\n`);
    sseWrite(res, JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: toolResult.resolvedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));

    if (toolResult.toolCalls.length > 0) {
      for (const call of toolResult.toolCalls) {
        res.write(`event: content_block_start\n`);
        sseWrite(res, JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: {},
          },
        }));
        res.write(`event: content_block_delta\n`);
        sseWrite(res, JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: call.arguments,
          },
        }));
        res.write(`event: content_block_stop\n`);
        sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
      }

      res.write(`event: message_delta\n`);
      sseWrite(res, JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", {
          job: null,
          plan: null,
          taskRuns: [],
          artifacts: [],
        }, {
          mode: "tool",
          model: toolResult.resolvedModel,
          toolCalls: toolResult.toolCalls,
          content: toolResult.content,
        }));
      }
    } else {
      const result = await runTaskFromMessages(messages, body.model);
      const workflow = buildWorkflowPayload(result);
      res.write(`event: content_block_start\n`);
      sseWrite(res, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));
      const finalText = summarizeToolResultContent(result.content) || result.content || summarizeToolResultContent(toolResult.content) || "Tool work completed. Please summarize and finish without further tool calls.";
      for (const chunk of splitContentForStreaming(finalText)) {
        res.write(`event: content_block_delta\n`);
        sseWrite(res, JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: chunk,
          },
        }));
      }
      res.write(`event: content_block_stop\n`);
      sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
      res.write(`event: message_delta\n`);
      sseWrite(res, JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
          mode: "task",
          model: result.resolvedModel,
          status: result.job.status,
        }));
      }
    }
    res.write(`event: message_stop\n`);
    sseWrite(res, JSON.stringify({ type: "message_stop" }));
    res.end();
    return;
  }

  const result = await runTaskFromMessages(messages, body.model);
  const workflow = buildWorkflowPayload(result);

  if (!body.stream) {
    jsonResponse(res, 200, buildAnthropicMessageResponse(result.resolvedModel, summarizeToolResultContent(result.content) || result.content, workflow));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const messageId = `msg_${Date.now()}`;
  res.write(`event: message_start\n`);
  sseWrite(res, JSON.stringify({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: result.resolvedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));
  res.write(`event: content_block_start\n`);
  sseWrite(res, JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }));
  for (const chunk of splitContentForStreaming(summarizeToolResultContent(result.content) || result.content)) {
    res.write(`event: content_block_delta\n`);
    sseWrite(res, JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    }));
  }
  res.write(`event: content_block_stop\n`);
  sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
  res.write(`event: message_delta\n`);
  sseWrite(res, JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
    workflow,
  }));
  res.write(`event: message_stop\n`);
  sseWrite(res, JSON.stringify({ type: "message_stop" }));
  if (includeWorkflowEvents) {
    sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
      mode: "task",
      model: result.resolvedModel,
      status: result.job.status,
    }));
  }
  res.end();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  try {
    if (url.pathname.startsWith("/v1/") && !isAuthorized(req)) {
      unauthorizedResponse(res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/models") {
      await handleModels(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      await handleHealth(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/jobs") {
      await handleListJobs(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/jobs") {
      await handleCreateJob(req, res);
      return;
    }

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (method === "GET" && jobMatch) {
      await handleGetJob(req, res, decodeURIComponent(jobMatch[1]!));
      return;
    }

    const jobStepsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/steps$/);
    if (method === "GET" && jobStepsMatch) {
      await handleGetJobSteps(req, res, decodeURIComponent(jobStepsMatch[1]!));
      return;
    }

    const jobArtifactsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts$/);
    if (method === "GET" && jobArtifactsMatch) {
      await handleGetJobArtifacts(req, res, decodeURIComponent(jobArtifactsMatch[1]!));
      return;
    }

    const jobRuntimeProfileMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/runtime-profile$/);
    if (method === "GET" && jobRuntimeProfileMatch) {
      await handleGetJobRuntimeProfile(req, res, decodeURIComponent(jobRuntimeProfileMatch[1]!));
      return;
    }

    const jobEventsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
    if (method === "GET" && jobEventsMatch) {
      await handleGetJobEvents(req, res, decodeURIComponent(jobEventsMatch[1]!));
      return;
    }

    const jobStreamMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/stream$/);
    if (method === "GET" && jobStreamMatch) {
      await handleJobStream(req, res, decodeURIComponent(jobStreamMatch[1]!));
      return;
    }

    const jobTimelineMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/timeline$/);
    if (method === "GET" && jobTimelineMatch) {
      await handleJobTimeline(req, res, decodeURIComponent(jobTimelineMatch[1]!));
      return;
    }

    const jobCancelMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (method === "POST" && jobCancelMatch) {
      await handleCancelJob(req, res, decodeURIComponent(jobCancelMatch[1]!));
      return;
    }

    const jobRetryMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/retry$/);
    if (method === "POST" && jobRetryMatch) {
      await handleRetryJob(req, res, decodeURIComponent(jobRetryMatch[1]!));
      return;
    }

    const jobApproveMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/approve$/);
    if (method === "POST" && jobApproveMatch) {
      await handleApproveJob(req, res, decodeURIComponent(jobApproveMatch[1]!));
      return;
    }

    const jobResumeMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/resume$/);
    if (method === "POST" && jobResumeMatch) {
      await handleResumeJob(req, res, decodeURIComponent(jobResumeMatch[1]!));
      return;
    }

    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/messages") {
      await handleAnthropicMessages(req, res);
      return;
    }

    jsonErrorResponse(res, 404, `Route not found: ${method} ${url.pathname}`, "not_found_error", {
      status: "failed",
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      serviceUnavailableResponse(res, error.message, error.retryAfterSeconds);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const isBadRequest = message.includes("must be a non-empty array")
      || message.includes("Unable to derive")
      || message.includes("Invalid JSON")
      || message.includes("exceeds maximum size");

    if (responseAlreadyStarted(res)) {
      console.error("Request failed after response started:", message);
      if (!(res as ServerResponse & { writableEnded?: boolean }).writableEnded) {
        try {
          res.end();
        } catch {
          // Best effort: the original response has already started.
        }
      }
      return;
    }

    jsonErrorResponse(res, isBadRequest ? 400 : 500, message, isBadRequest ? "invalid_request_error" : "server_error", {
      status: isBadRequest ? "failed" : "blocked",
    });
  }
}

function getPort(args: string[]): number {
  const explicitPort = args[1] ? Number(args[1]) : Number(process.env.PORT ?? "9898");
  return Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : 9898;
}

function parseTeamCliArgs(args: string[]): { goal: string; planOnly: boolean } {
  const planOnly = args[0] === "plan" || args.includes("--plan-only");
  const goalArgs = args
    .filter((arg, index) => !(index === 0 && arg === "plan") && arg !== "--plan-only" && arg !== "--");
  return {
    goal: goalArgs.join(" ").trim(),
    planOnly,
  };
}

function runConfigValidation(configPath?: string): void {
  const resolvedPath = configPath?.trim() || "config/config.yml";
  const config = loadConfig(resolvedPath);
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);

  console.log(JSON.stringify({
    ok: true,
    config_path: resolvedPath,
    planner_model: config.planner.model,
    executor_model: config.executor.model,
    task_routing_path: config.taskRoutingPath,
    route_types: routing.map((route) => route.type),
  }, null, 2));
}

type DoctorCheck = {
  name: string;
  ok: boolean;
  summary: string;
  detail?: unknown;
};

type DoctorRecommendation = {
  category:
    | "configuration"
    | "routing"
    | "network"
    | "filesystem"
    | "search"
    | "runtime";
  severity: "info" | "warning";
  message: string;
  suggested_action: string;
  related_checks: string[];
};

function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return `${value.slice(0, 1)}***`;
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function buildModelConfigCheck(
  name: "planner_model_config" | "executor_model_config",
  label: "planner" | "executor",
  config: OrchestratorConfig["planner"] | OrchestratorConfig["executor"],
): DoctorCheck {
  const urlLooksLocal = /^(https?:\/\/)(127\.0\.0\.1|localhost)/i.test(config.baseUrl);
  return {
    name,
    ok: Boolean(config.baseUrl && config.apiKey && config.model),
    summary: `${label} model config is ready${urlLooksLocal ? " (local endpoint)." : "."}`,
    detail: {
      base_url: config.baseUrl,
      api_key_present: Boolean(config.apiKey),
      api_key_preview: config.apiKey ? maskSecret(config.apiKey) : "",
      model: config.model,
      timeout_ms: config.timeoutMs,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      endpoint_scope: urlLooksLocal ? "local" : "remote",
    },
  };
}

function buildTaskRoutingCheck(taskRoutingPath: string | undefined, routing: RoutePolicy[]): DoctorCheck {
  const routesWithPreferredTools = routing.filter((route) => route.preferredTools.length > 0).length;
  const routesRequiringEvidence = routing.filter((route) => route.requireEvidenceBeforeFinal).length;
  return {
    name: "task_routing_summary",
    ok: routing.length > 0,
    summary: `Task routing loaded ${routing.length} route types.`,
    detail: {
      task_routing_path: taskRoutingPath ?? "config/task-routing.yml",
      route_count: routing.length,
      route_types: routing.map((route) => route.type),
      routes_with_preferred_tools: routesWithPreferredTools,
      routes_requiring_evidence: routesRequiringEvidence,
    },
  };
}

function buildSearchProviderCheck(config: OrchestratorConfig): DoctorCheck {
  if (!config.search) {
    return {
      name: "search_provider_readiness",
      ok: false,
      summary: "Search provider is not configured.",
      detail: {
        provider: null,
        fallback_enabled: false,
      },
    };
  }

  const providerConfig = config.search.providers[config.search.provider];
  const providerKindsRequiringApiKey = new Set(["serpapi", "bing_api", "google_cse"]);
  const providerKindsRequiringSection = new Set(["bing_html", "searxng", "serpapi", "bing_api", "google_cse", "mcp"]);
  const sectionPresent = config.search.provider === "url_template" || providerKindsRequiringSection.has(config.search.provider)
    ? Boolean(providerConfig)
    : true;
  const apiKeyRequired = providerKindsRequiringApiKey.has(config.search.provider);
  const apiKeyPresent = !apiKeyRequired || Boolean(config.search.apiKey);
  const ok = sectionPresent && apiKeyPresent;

  return {
    name: "search_provider_readiness",
    ok,
    summary: ok
      ? `Search provider "${config.search.provider}" is ready.`
      : `Search provider "${config.search.provider}" is only partially configured.`,
    detail: {
      provider: config.search.provider,
      provider_section_present: sectionPresent,
      api_key_required: apiKeyRequired,
      api_key_present: Boolean(config.search.apiKey),
      api_key_preview: config.search.apiKey ? maskSecret(config.search.apiKey) : "",
      fallback_enabled: config.search.fallbackEnabled,
      timeout_ms: config.search.timeoutMs,
      provider_config_keys: providerConfig ? Object.keys(providerConfig) : [],
    },
  };
}

function buildDoctorRecommendations(checks: DoctorCheck[]): DoctorRecommendation[] {
  const recommendations: DoctorRecommendation[] = [];
  const find = (name: string) => checks.find((check) => check.name === name);

  const configLoad = find("config_load");
  if (configLoad && !configLoad.ok) {
    recommendations.push({
      category: "configuration",
      severity: "warning",
      message: "Configuration failed to load.",
      suggested_action: "Fix the reported config schema errors, then rerun `npm run doctor` or `npm run config:validate`.",
      related_checks: ["config_load"],
    });
    return recommendations;
  }

  if ((find("planner_model_config") && !find("planner_model_config")!.ok) || (find("executor_model_config") && !find("executor_model_config")!.ok)) {
    recommendations.push({
      category: "configuration",
      severity: "warning",
      message: "Planner or executor model configuration is incomplete.",
      suggested_action: "Verify base URLs, model names, and API key env vars for both planner and executor.",
      related_checks: ["planner_model_config", "executor_model_config"],
    });
  }

  if (find("task_routing_load") && !find("task_routing_load")!.ok) {
    recommendations.push({
      category: "routing",
      severity: "warning",
      message: "Task routing config could not be loaded.",
      suggested_action: "Fix the task-routing YAML or fall back to the default `config/task-routing.yml` layout.",
      related_checks: ["task_routing_load", "task_routing_summary"],
    });
  }

  if (find("proxy_health") && !find("proxy_health")!.ok) {
    recommendations.push({
      category: "network",
      severity: "warning",
      message: "Proxy configuration looks degraded.",
      suggested_action: "Check `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, especially local placeholders or dead ports.",
      related_checks: ["proxy_health", "runtime_profile"],
    });
  }

  if ((find("workspace_writable") && !find("workspace_writable")!.ok) || (find("runtime_writable") && !find("runtime_writable")!.ok)) {
    recommendations.push({
      category: "filesystem",
      severity: "warning",
      message: "One or more writable roots are not writable.",
      suggested_action: "Check directory permissions and confirm the workspace/runtime roots are writable by this process.",
      related_checks: ["workspace_writable", "runtime_writable"],
    });
  }

  if (find("search_provider_readiness") && !find("search_provider_readiness")!.ok) {
    recommendations.push({
      category: "search",
      severity: "warning",
      message: "Search provider is only partially configured.",
      suggested_action: "Add the active provider section and required API key, or switch to a provider that is already configured.",
      related_checks: ["search_provider_readiness"],
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      category: "runtime",
      severity: "info",
      message: "No critical doctor issues were detected.",
      suggested_action: "Use `/v1/jobs/:id/runtime-profile`, `/events`, and `/timeline` when you need job-specific diagnostics.",
      related_checks: checks.filter((check) => check.ok).map((check) => check.name),
    });
  }

  return recommendations;
}

function runWritableCheck(targetDir: string, label: string): DoctorCheck {
  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const probePath = join(targetDir, `.doctor-write-check-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(probePath, "ok", "utf8");
    unlinkSync(probePath);
    return {
      name: `${label}_writable`,
      ok: true,
      summary: `${label} is writable.`,
      detail: { path: targetDir },
    };
  } catch (error) {
    return {
      name: `${label}_writable`,
      ok: false,
      summary: `${label} is not writable.`,
      detail: {
        path: targetDir,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function buildDoctorReport(configPath?: string): Record<string, unknown> {
  const resolvedPath = configPath?.trim() || "config/config.yml";
  const checks: DoctorCheck[] = [];

  try {
    const config = loadConfig(resolvedPath);
    checks.push({
      name: "config_load",
      ok: true,
      summary: "Configuration loaded successfully.",
      detail: {
        planner_model: config.planner.model,
        executor_model: config.executor.model,
      },
    });
    checks.push(buildModelConfigCheck("planner_model_config", "planner", config.planner));
    checks.push(buildModelConfigCheck("executor_model_config", "executor", config.executor));

    const routing = loadTaskRoutingConfig(config.taskRoutingPath);
    checks.push({
      name: "task_routing_load",
      ok: true,
      summary: "Task routing config loaded successfully.",
      detail: {
        task_routing_path: config.taskRoutingPath,
        route_types: routing.map((route) => route.type),
      },
    });
    checks.push(buildTaskRoutingCheck(config.taskRoutingPath, routing));

    const runtimeProfile = buildRuntimeProfile(config);
    checks.push({
      name: "runtime_profile",
      ok: true,
      summary: "Runtime profile generated successfully.",
      detail: runtimeProfile,
    });

    checks.push({
      name: "proxy_health",
      ok: runtimeProfile.network.proxyHealth === "ok",
      summary: runtimeProfile.network.proxyHealth === "ok"
        ? "Proxy health looks normal."
        : "Proxy configuration looks degraded.",
      detail: runtimeProfile.network,
    });

    checks.push(runWritableCheck(WORKSPACE_ROOT, "workspace"));
    checks.push(runWritableCheck(RUNTIME_ROOT, "runtime"));

    checks.push(buildSearchProviderCheck(config));

    return {
      ok: checks.every((check) => check.ok),
      generated_at: new Date().toISOString(),
      config_path: resolvedPath,
      diagnostic_taxonomy: {
        failure_categories: listFailureCategories(),
      },
      summary: {
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).length,
        total: checks.length,
      },
      recommendations: buildDoctorRecommendations(checks),
      checks,
    };
  } catch (error) {
    checks.push({
      name: "config_load",
      ok: false,
      summary: "Configuration failed to load.",
      detail: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      ok: false,
      generated_at: new Date().toISOString(),
      config_path: resolvedPath,
      diagnostic_taxonomy: {
        failure_categories: listFailureCategories(),
      },
      summary: {
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).length,
        total: checks.length,
      },
      recommendations: buildDoctorRecommendations(checks),
      checks,
    };
  }
}

function runDoctor(configPath?: string): void {
  console.log(JSON.stringify(buildDoctorReport(configPath), null, 2));
}

async function runCliTask(task: string): Promise<void> {
  const logger = createRunLogger(task);
  const baseConfig = loadConfig();
  configureSearchTools(baseConfig.search);
  const routing = loadTaskRoutingConfig(baseConfig.taskRoutingPath);
  const taskType = detectTaskType(task, routing);
  const routePolicy = getRoutePolicy(taskType, routing);
  const result = await runTask(baseConfig, task, routePolicy, logger);
  console.error(`Run log: ${logger.logPath}`);
  console.log(JSON.stringify({
    status: result.status,
    output: result.output,
    verified: result.verified,
    executorHistory: result.executorHistory,
    job: result.job,
    plan: result.plan,
    taskRuns: result.taskRuns,
    artifacts: result.artifacts,
  }, null, 2));
}

async function runCliTeam(goal: string, options: { planOnly?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  configureSearchTools(config.search);
  const logger = createRunLogger(goal);
  const tracer = new Tracer(logger);
  const startedAt = new Date().toISOString();

  const teamAgents = resolveTeamAgents(config);

  const result = await runTeam(config, goal, teamAgents, logger, tracer, { planOnly: options.planOnly });

  // Export dashboard
  const dashData = buildDashboardData(logger.runId, goal, result.tasks, tracer.getEvents(), startedAt);
  const jsonPath = exportDashboardJson(dashData);
  const htmlPath = exportDashboardHtml(dashData);
  console.error(`Run log: ${logger.logPath}`);
  console.error(`Dashboard JSON: ${jsonPath}`);
  console.error(`Dashboard HTML: ${htmlPath}`);

  console.log(JSON.stringify({
    goal: result.goal,
    finalAnswer: result.finalAnswer,
    taskResults: Object.fromEntries(result.taskResults),
    memorySummary: result.memorySummary,
    job: result.job,
    plan: result.plan,
    taskRuns: result.taskRuns,
    artifacts: result.artifacts,
    traceSummary: tracer.getSummary(),
  }, null, 2));
}

function runServer(port: number): void {
  const config = loadConfig();
  configureSearchTools(config.search);
  const recoveredJobIds = recoverInterruptedJobs();
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dual Agent Orchestrator API listening on http://127.0.0.1:${port}`);
    console.log(`API key: ${getServerApiKey()}`);
    console.log(`Models: ${getExposedModels(config).map((model) => model.id).join(", ")}`);
    if (recoveredJobIds.length > 0) {
      console.log(`Recovered interrupted jobs after restart: ${recoveredJobIds.join(", ")}`);
    }
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "config" && args[1] === "validate") {
    runConfigValidation(args[2]);
    return;
  }

  if (args[0] === "doctor") {
    runDoctor(args[1]);
    return;
  }

  if (args[0] === "serve") {
    runServer(getPort(args));
    return;
  }

  if (args[0] === "team") {
    const { goal, planOnly } = parseTeamCliArgs(args.slice(1));
    if (!goal) {
      throw new Error("Usage: node dist/index.js team [plan|--plan-only] \"your multi-agent goal here\"");
    }
    await runCliTeam(goal, { planOnly });
    return;
  }

  const userGoal = args.join(" ").trim();
  if (!userGoal) {
    throw new Error("Usage: node dist/index.js \"your task here\" OR node dist/index.js serve [port] OR node dist/index.js team [plan|--plan-only] \"goal\" OR node dist/index.js config validate [path] OR node dist/index.js doctor [path]");
  }

  await runCliTask(userGoal);
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
  });
}

export const __testables = {
  handleRequest,
  parseTeamCliArgs,
  buildJobResponse,
  buildStepList,
  buildJobEvents,
  buildClaudeControlResponse,
  isClaudeControlMessage,
  setTaskExecutorForTests,
  setTeamExecutorForTests,
  resolveTeamAgents,
  resolveRegisteredRoleAgent,
  createTeamApprovalGate,
  persistTeamApprovalSnapshot,
  getActiveJobSession,
  recoverInterruptedJobs,
  buildDoctorReport,
};
