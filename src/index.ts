import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as process from "node:process";
import { loadConfig } from "./config.js";
import { createRunLogger } from "./logger.js";
import { PlannerUnavailableError, runOrchestrator } from "./orchestrator.js";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { OrchestratorConfig } from "./types.js";

const OPENAI_MODEL_ID = "dual-agent-orchestrator";
const DEFAULT_API_KEY = "dual-agent-local";
const PLANNER_FAILURE_THRESHOLD = 3;
const PLANNER_COOLDOWN_MS = 60_000;

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
  tools?: unknown[];
  tool_choice?: unknown;
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
  tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>;
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
          content: typeof part.content === "string"
            ? part.content
            : typeof part.text === "string"
              ? part.text
              : JSON.stringify(part.content ?? ""),
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

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let raw = "";
    const decoder = new TextDecoder();
    req.on("data", (chunk) => {
      raw += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(error);
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

function buildChatCompletionResponse(model: string, content: string): unknown {
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

function buildToolChatCompletionChunk(model: string, id: string, toolCall: { id: string; name: string; arguments: string }, finishReason: string | null): string {
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
              index: 0,
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

function sseWrite(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`);
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
        content,
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

async function runTaskFromRequest(body: ChatCompletionRequest): Promise<{ content: string; logPath: string }> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(body.messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, body.model);
  const logger = createRunLogger(userGoal);
  const result = await runOrchestrator(modelSelection.resolvedConfig, userGoal, logger);
  const content = result.final_answer || result.clarification_question || result.reasoning_summary || "";

  console.error(`Run log: ${logger.logPath}`);
  return { content, logPath: logger.logPath };
}

async function runTaskFromMessages(messages: OpenAIMessage[], model: string | undefined): Promise<{ content: string; logPath: string; resolvedModel: string }> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, model);
  assertPlannerCircuitClosed();
  const logger = createRunLogger(userGoal);
  let result;
  try {
    result = await runOrchestrator(modelSelection.resolvedConfig, userGoal, logger);
    markPlannerSuccess();
  } catch (error) {
    if (error instanceof PlannerUnavailableError) {
      throw markPlannerFailure(error.message);
    }
    throw error;
  }
  const content = result.final_answer || result.clarification_question || result.reasoning_summary || "";

  console.error(`Run log: ${logger.logPath}`);
  return { content, logPath: logger.logPath, resolvedModel: modelSelection.exposed.id };
}

async function runToolMode(messages: ChatMessage[], model: string | undefined, tools: unknown): Promise<{
  resolvedModel: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  content: string;
}> {
  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, model);
  const allowedTools = normalizeIncomingTools(tools);
  const response = await runChatCompletionDetailed(modelSelection.resolvedConfig.executor, messages, allowedTools);

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

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ChatCompletionRequest>(req);
  const toolMode = Array.isArray(body.tools) && body.tools.length > 0;

  if (toolMode) {
    const toolResult = await runToolMode(normalizeOpenAIToolMessages(body.messages || []), body.model, body.tools);

    if (!body.stream) {
      if (toolResult.toolCalls.length > 0) {
        jsonResponse(res, 200, buildToolChatCompletionResponse(toolResult.resolvedModel, toolResult.toolCalls));
      } else {
        jsonResponse(res, 200, buildChatCompletionResponse(toolResult.resolvedModel, toolResult.content));
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
      for (const toolCall of toolResult.toolCalls) {
        sseWrite(res, buildToolChatCompletionChunk(toolResult.resolvedModel, streamId, toolCall, null));
      }
      sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, {}, "tool_calls"));
    } else {
      for (const chunk of splitContentForStreaming(toolResult.content)) {
        sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, { content: chunk }, null));
      }
      sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, {}, "stop"));
    }
    res.end("data: [DONE]\n\n");
    return;
  }

  const resultForModel = await runTaskFromMessages(normalizeChatMessages(body.messages || []), body.model).catch((error) => { throw error; });
  const requestedModel = resultForModel.resolvedModel;

  if (!body.stream) {
    jsonResponse(res, 200, buildChatCompletionResponse(requestedModel, resultForModel.content));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const streamId = `chatcmpl-${Date.now()}`;
  sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { role: "assistant", content: "" }, null));

  try {
    const chunks = splitContentForStreaming(resultForModel.content);

    for (const chunk of chunks) {
      sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: chunk }, null));
    }

    sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, {}, "stop"));
    res.end("data: [DONE]\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: `Error: ${message}` }, "stop"));
    res.end("data: [DONE]\n\n");
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

function buildResponsesResponse(model: string, content: string): unknown {
  return {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: buildResponsesOutput(content),
    output_text: content,
    error: null,
  };
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ResponsesRequest>(req);
  const messages = normalizeResponsesInput(body.input, body.instructions);
  const result = await runTaskFromMessages(messages, body.model);

  if (!body.stream) {
    jsonResponse(res, 200, buildResponsesResponse(result.resolvedModel, result.content));
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
  res.end("data: [DONE]\n\n");
}

function buildAnthropicMessageResponse(model: string, content: string): unknown {
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
  };
}

async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<AnthropicMessagesRequest>(req);
  const messages = normalizeAnthropicMessages(body.messages, body.system);
  const toolMode = Array.isArray(body.tools) && body.tools.length > 0;

  if (toolMode) {
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
            input: JSON.parse(call.arguments || "{}"),
          })),
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        });
      } else {
        jsonResponse(res, 200, buildAnthropicMessageResponse(toolResult.resolvedModel, toolResult.content));
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
    } else {
      res.write(`event: content_block_start\n`);
      sseWrite(res, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));
      for (const chunk of splitContentForStreaming(toolResult.content)) {
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
    }
    res.write(`event: message_stop\n`);
    sseWrite(res, JSON.stringify({ type: "message_stop" }));
    res.end();
    return;
  }

  const result = await runTaskFromMessages(messages, body.model);

  if (!body.stream) {
    jsonResponse(res, 200, buildAnthropicMessageResponse(result.resolvedModel, result.content));
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
  for (const chunk of splitContentForStreaming(result.content)) {
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
  res.write(`event: message_stop\n`);
  sseWrite(res, JSON.stringify({ type: "message_stop" }));
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

    jsonResponse(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "server_error",
      },
    });
  }
}

function getPort(args: string[]): number {
  const explicitPort = args[1] ? Number(args[1]) : Number(process.env.PORT ?? "8787");
  return Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : 8787;
}

async function runCliTask(task: string): Promise<void> {
  const config = loadConfig();
  const logger = createRunLogger(task);
  const result = await runOrchestrator(config, task, logger);
  console.error(`Run log: ${logger.logPath}`);
  console.log(JSON.stringify(result, null, 2));
}

function runServer(port: number): void {
  const config = loadConfig();
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
  if (args[0] === "serve") {
    runServer(getPort(args));
    return;
  }

  const userGoal = args.join(" ").trim();
  if (!userGoal) {
    throw new Error("Usage: node dist/index.js \"your task here\" OR node dist/index.js serve [port]");
  }

  await runCliTask(userGoal);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
});
