import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { compressJsonOutput, compressToolOutput } from "./compress.js";
import { createRunLogger } from "./logger.js";
import { PlannerUnavailableError, runOrchestrator, runTask, detectTaskType, getRoutePolicy } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { TOOL_DEFINITIONS, configureSearchTools } from "./tools.js";
import type { Artifact, ExecutorOutput, Job, OrchestratorConfig, OrchestratorEvent, OrchestratorEventCallback, Plan, TaskRun } from "./types.js";
import { buildRuntimeProfile } from "./runtime/profile.js";
import { runTeam, type TeamAgent } from "./team.js";
import { buildDashboardData, exportDashboardJson, exportDashboardHtml } from "./dashboard.js";
import { Tracer } from "./trace.js";
import { runVerifiers, verificationPassed, type VerificationContext } from "./verification.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT } from "./paths.js";
import { listStoredJobs, persistApprovalRequest, persistJobRecord, readJobRecord, resolveApprovalRequest, updateJobControlState, updateStoredJobRecord, type StoredJobRecord } from "./job-store.js";
import { cancelActiveJobSession, getActiveJobSession, registerActiveJobSession, resolvePendingApproval, unregisterActiveJobSession } from "./job-runtime.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "./workflow-contract.js";
import { createUiEvent, normalizeWorkflowEvent, type InternalWorkflowEvent, type WorkflowUiEvent } from "./workflow-ui-events.js";
import { appendEvent, getEvents, getLatestSnapshot, subscribe, getNextSeq, loadEventsFromDisk } from "./job-event-bus.js";
import { renderTimelineHtml } from "./timeline.js";

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

let injectedTaskExecutor: ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null = null;

function setTaskExecutorForTests(executor: ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null): void {
  injectedTaskExecutor = executor;
}

function persistWorkflowPayload(payload: Pick<TaskExecutionPayload, "job" | "plan" | "taskRuns" | "artifacts">): string {
  return persistJobRecord({
    job: payload.job,
    plan: payload.plan,
    taskRuns: payload.taskRuns,
    artifacts: payload.artifacts,
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
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.end(JSON.stringify({
    error: {
      message,
      type: "service_unavailable",
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
  if (lastUserMessage) {
    return getMessageText(lastUserMessage);
  }

  return messages
    .map((message) => getMessageText(message))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function splitContentForStreaming(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return lines;
  }

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
      latest_executor_summary: latestExecutorOutput?.summary ?? null,
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
      status: mapTaskRunStatus(taskRun.status),
      taskRunId: taskRun.id,
      meta: {
        title: taskRun.title,
        verified: taskRun.verified,
        attempts: taskRun.attempts,
        artifact_count: taskRun.artifacts.length,
      },
    }));

    for (const [index, executorOutput] of (taskRun.executorHistory ?? []).entries()) {
      push(createLifecycleEvent({
        jobId: record.job.id,
        seq,
        time: record.savedAt,
        type: mapExecutorHistoryType(executorOutput.status),
        title: "Executor result recorded",
        summary: executorOutput.summary,
        status: mapExecutorHistoryStatus(executorOutput.status),
        taskRunId: taskRun.id,
        step: index + 1,
        meta: {
          source: executorOutput.source ?? null,
          error: executorOutput.error ?? null,
          artifact_count: executorOutput.artifacts.length,
          tool_call_count: executorOutput.tool_calls_made.length,
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

  const stateSummary = record.job.status === "running"
    ? "Job is currently running."
    : record.job.status === "queued"
      ? "Job is queued."
      : record.job.status === "awaiting_approval"
        ? "Job is waiting for approval."
        : record.job.status === "cancelled"
          ? "Job was cancelled."
          : `Job finished with status ${record.job.status}.`;
  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: mapJobFinalType(record.job.status),
    title: "Job state recorded",
    summary: stateSummary,
    status: mapJobStatus(record.job.status),
    meta: {
      verified: record.job.verified,
      output_preview: record.job.output.slice(0, 200),
    },
  }));

  return events;
}

function mapTaskRunStatus(status: TaskRun["status"]): WorkflowUiEvent["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "in_progress":
    case "pending":
    case "skipped":
    default:
      return "running";
  }
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

function mapJobStatus(status: Job["status"]): WorkflowUiEvent["status"] {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "awaiting_approval":
      return "awaiting_approval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "blocked";
    case "blocked":
    default:
      return "blocked";
  }
}

function mapJobFinalType(status: Job["status"]): string {
  switch (status) {
    case "queued":
      return "job.queued";
    case "running":
      return "job.started";
    case "awaiting_approval":
      return "job.awaiting_approval";
    case "completed":
      return "job.completed";
    case "failed":
      return "job.failed";
    case "cancelled":
      return "job.cancelled";
    case "blocked":
    default:
      return "job.blocked";
  }
}

function buildEventSnapshot(jobId: string, events: WorkflowUiEvent[]): Record<string, unknown> | null {
  if (events.length === 0) {
    return null;
  }

  const latestByAgent = (agent: WorkflowUiEvent["agent"]) => [...events].reverse().find((event) => event.agent === agent) ?? null;
  return {
    job_id: jobId,
    seq: events.at(-1)?.seq ?? 0,
    event_count: events.length,
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
    return persistedEvents;
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

function buildJobResponse(record: StoredJobRecord): unknown {
  const latestStep = record.taskRuns.at(-1);
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
    control: record.control ?? {},
  };
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
      return `\n[Progress] Planner started step ${event.step ?? 1}.\n`;
    case "workflow.planner.decision": {
      const summary = typeof event.data.reasoning_summary === "string" && event.data.reasoning_summary.trim()
        ? event.data.reasoning_summary.trim()
        : typeof event.data.next_step === "string"
          ? event.data.next_step.trim()
          : "";
      return summary ? `\n[Progress] Planner: ${summary}\n` : null;
    }
    case "workflow.executor.start": {
      const instruction = typeof event.data.instruction === "string" ? event.data.instruction.trim() : "";
      return instruction ? `\n[Progress] Executor: ${truncateToolResultContent(instruction)}\n` : "\n[Progress] Executor started working.\n";
    }
    case "workflow.executor.result": {
      const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
      return summary ? `\n[Progress] Executor result: ${summary}\n` : null;
    }
    case "workflow.tool.start": {
      const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
      return `\n[Progress] Calling ${tool}.\n`;
    }
    case "workflow.tool.result": {
      const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
      const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
      return summary
        ? `\n[Progress] ${tool}: ${summary}\n`
        : `\n[Progress] ${tool} returned.\n`;
    }
    default:
      return null;
  }
}

function sseWrite(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`);
}

function sseWriteEvent(res: ServerResponse, eventName: string, payload: string): void {
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
      meta,
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
    onEvent?.(event);
  };

  registerActiveJobSession(jobId, userGoal, abortController);
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

    const executorHistory = payload.taskRuns.flatMap((taskRun) => taskRun.executorHistory ?? []);
    const verificationContext: VerificationContext = {
      jobId,
      goal: userGoal,
      executorHistory,
      artifacts: payload.artifacts,
      taskRuns: payload.taskRuns,
      workspaceRoot: WORKSPACE_ROOT,
      runtimeRoot: RUNTIME_ROOT,
    };
    const verificationResults = await runVerifiers(verificationContext);
    const allPassed = verificationPassed(verificationResults);
    const verifiedJob = allPassed ? payload.job : { ...payload.job, verified: false };
    if (!allPassed) {
      emitLifecycle("system.verification_failed", "Verification reported issues", "Verification completed with one or more issues.", "blocked", {
        verifier_count: verificationResults.length,
      });
    } else {
      emitLifecycle("system.verification_passed", "Verification passed", "Verification completed successfully.", "success", {
        verifier_count: verificationResults.length,
      });
    }

    const jobRecordPath = persistWorkflowPayload({
      job: verifiedJob,
      plan: payload.plan,
      taskRuns: payload.taskRuns,
      artifacts: payload.artifacts,
    });
    emitLifecycle(mapJobFinalType(verifiedJob.status), "Job finished", `Job finished with status ${verifiedJob.status}.`, mapJobStatus(verifiedJob.status), {
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

async function runTaskFromRequest(body: ChatCompletionRequest): Promise<TaskExecutionPayload> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(body.messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
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

  return executeTaskGoal(userGoal, model, true, onEvent);
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

  if (body.mode !== undefined && body.mode !== "task") {
    jsonResponse(res, 400, {
      error: {
        message: "`POST /v1/jobs` currently supports mode \"task\". Team mode will use the same control-plane contract in a later milestone.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const modelRoute = typeof body.model_route === "string" && body.model_route.trim()
    ? body.model_route.trim()
    : undefined;
  if (body.policy?.async === true) {
    const fixedIds: FixedTaskIds = {
      jobId: `job_${randomUUID()}`,
      planId: `plan_${randomUUID()}`,
      taskRunId: `taskrun_${randomUUID()}`,
    };
    void executeTaskGoal(goal, modelRoute, true, undefined, fixedIds).catch(() => {
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
          mode: "task",
          status: "running",
          verified: false,
          output: "Running...",
        },
      }),
    });
    return;
  }

  const result = await executeTaskGoal(goal, modelRoute, true);
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
  jsonResponse(res, 200, {
    job_id: jobId,
    generated_at: new Date().toISOString(),
    runtime_profile: buildRuntimeProfile(config),
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
    snapshot: getLatestSnapshot(jobId) ?? buildEventSnapshot(jobId, events),
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

  // Load existing events from disk
  const existingEvents = mergeJobEvents(record, loadEventsFromDisk(jobId));

  // Set SSE headers
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Send initial snapshot
  const snapshot = getLatestSnapshot(jobId) ?? buildEventSnapshot(jobId, existingEvents);
  if (snapshot) {
    sseWriteEvent(res, "job.snapshot", JSON.stringify(snapshot));
  }

  // Send existing events
  const replayEvents = existingEvents.length > 0 ? existingEvents : getEvents(jobId);
  for (const event of replayEvents) {
    sseWriteEvent(res, "job.event", JSON.stringify(event));
  }

  // Subscribe to new events
  const unsubscribe = subscribe(jobId, (event) => {
    try {
      sseWriteEvent(res, "job.event", JSON.stringify(event));
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
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const retryResult = await executeTaskGoal(record.job.goal, undefined, false);
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
  );

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleApproveJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const body = await readJsonBody<{ approval_id?: string; decision?: string; note?: string }>(req);
  if (!body.approval_id || !body.decision) {
    jsonResponse(res, 400, {
      error: {
        message: "approval_id and decision are required.",
        type: "invalid_request_error",
      },
    });
    return;
  }
  if (body.decision !== "approved" && body.decision !== "denied") {
    jsonResponse(res, 400, {
      error: {
        message: 'decision must be "approved" or "denied".',
        type: "invalid_request_error",
      },
    });
    return;
  }

  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: { message: `Job not found: ${jobId}`, type: "not_found_error" },
    });
    return;
  }

  const updated = resolveApprovalRequest(jobId, body.approval_id, body.decision, body.note);
  if (!updated) {
    jsonResponse(res, 400, {
      error: { message: `Approval not found: ${body.approval_id}`, type: "invalid_request_error" },
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
    jsonResponse(res, 404, {
      error: { message: `Job not found: ${jobId}`, type: "not_found_error" },
    });
    return;
  }

  if (record.job.status === "completed") {
    jsonResponse(res, 400, {
      error: { message: "Cannot resume a completed job.", type: "invalid_request_error" },
    });
    return;
  }

  const active = getActiveJobSession(jobId);
  if (active) {
    jsonResponse(res, 409, {
      error: { message: "Job is currently running.", type: "conflict_error" },
    });
    return;
  }

  const resumeResult = await executeTaskGoal(record.job.goal, undefined, false);
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
    const emitProgressChunk = (event: OrchestratorEvent) => {
      if (!mirrorProgressToContent) {
        return;
      }
      const progressText = formatProgressUpdate(event);
      if (!progressText) {
        return;
      }
      emittedProgressChunks = true;
      for (const chunk of splitContentForStreaming(progressText)) {
        sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { content: chunk }, null));
      }
    };
    const combinedOnEvent: OrchestratorEventCallback | undefined = (event) => {
      emitProgressChunk(event);
      onEvent?.(event);
    };

    try {
      const resultForModel = await runTaskFromMessages(normalizeChatMessages(body.messages || []), body.model, combinedOnEvent);
      const requestedModel = resultForModel.resolvedModel;
      const workflow = buildWorkflowPayload(resultForModel);

      if (mirrorProgressToContent && emittedProgressChunks) {
        sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: "\n[Final Answer]\n" }, null));
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
    }
    return;
  }

  // Non-streaming path
  const resultForModel = await runTaskFromMessages(normalizeChatMessages(body.messages || []), body.model).catch((error) => { throw error; });
  const requestedModel = resultForModel.resolvedModel;
  const workflow = buildWorkflowPayload(resultForModel);
  jsonResponse(res, 200, buildChatCompletionResponse(requestedModel, resultForModel.content, workflow));
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
  const result = await runTaskFromMessages(messages, body.model);
  const workflow = buildWorkflowPayload(result);

  if (!body.stream) {
    jsonResponse(res, 200, buildResponsesResponse(result.resolvedModel, result.content, workflow));
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
  res.end("data: [DONE]\n\n");
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
  const toolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);

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
      const finalText = summarizeToolResultContent(toolResult.content) || "Tool work completed. Please summarize and finish without further tool calls.";
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

    jsonResponse(res, 404, {
      error: {
        message: `Route not found: ${method} ${url.pathname}`,
        type: "not_found_error",
      },
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

    jsonResponse(res, isBadRequest ? 400 : 500, {
      error: {
        message,
        type: isBadRequest ? "invalid_request_error" : "server_error",
      },
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
  const resolvedPath = configPath?.trim() || "config/example.config.yml";
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

  // Parse agents from env or use defaults
  const agentsRaw = process.env.TEAM_AGENTS?.trim();
  let teamAgents: TeamAgent[];
  if (agentsRaw) {
    try {
      const parsed = JSON.parse(agentsRaw) as unknown;
      if (Array.isArray(parsed)) {
        teamAgents = parsed
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as Record<string, unknown>).name === "string")
          .map((a) => ({ name: a.name as string, role: typeof a.role === "string" ? a.role : undefined }));
      } else {
        teamAgents = [{ name: "planner", role: "planning and coordination" }, { name: "executor", role: "task execution" }];
      }
    } catch {
      teamAgents = [{ name: "planner", role: "planning and coordination" }, { name: "executor", role: "task execution" }];
    }
  } else {
    teamAgents = [{ name: "planner", role: "planning and coordination" }, { name: "executor", role: "task execution" }];
  }

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
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dual Agent Orchestrator API listening on http://127.0.0.1:${port}`);
    console.log(`API key: ${getServerApiKey()}`);
    console.log(`Models: ${getExposedModels(config).map((model) => model.id).join(", ")}`);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "config" && args[1] === "validate") {
    runConfigValidation(args[2]);
    return;
  }

  if (args[0] === "doctor") {
    runConfigValidation(args[1]);
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
  setTaskExecutorForTests,
  getActiveJobSession,
};
