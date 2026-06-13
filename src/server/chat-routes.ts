import { type IncomingMessage, type ServerResponse } from "node:http";
import { getRuntimeConfig, jsonResponse, jsonErrorResponse, readJsonBody, responseAlreadyStarted } from "./shared.js";
import type { OrchestratorEvent, OrchestratorEventCallback } from "../types.js";
import type { CompletionOverrides } from "../providers/openai-compatible.js";
import {
  runTaskFromMessages,
  runTaskFromMessagesWithRegistration,
  runToolMode,
  formatProgressUpdate,
  normalizeChatMessages,
  normalizeAnthropicMessages,
  normalizeAnthropicToolMessages,
  normalizeResponsesInput,
  normalizeOpenAIToolMessages,
  shouldIncludeWorkflowEvents,
  shouldMirrorProgressToContent,
  splitContentForStreaming,
  attachRequestAbortCancellation,
  sseWrite,
  sseWriteEvent,
  buildWorkflowPayload,
  buildWorkflowEvent,
  summarizeToolResultContent,
  safeParseToolInput,
  buildAggregatedToolResult,
  shouldAggregateToolProgress,
  createProgressAggregationState,
  buildAggregatedToolStart,
  accumulateToolProgressResult,
  extractLatestOpenAIWriteToolCompletion,
  extractLatestOpenAIResearchReadCompletion,
  extractLatestAnthropicWriteToolCompletion,
  extractLatestAnthropicResearchReadCompletion,
  hasAnthropicToolHistory,
} from "../index.js";

interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: string | unknown[]; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>;
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

interface ResponseInputItem { role?: string; content?: string | Array<{ type?: string; text?: string }>; }
interface ResponsesRequest { model?: string; input?: string | ResponseInputItem[]; instructions?: string; stream?: boolean; include_workflow_events?: boolean; }
interface AnthropicContentBlock { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string; }
interface AnthropicMessage { role?: string; content?: string | AnthropicContentBlock[]; }
interface AnthropicMessagesRequest { model?: string; system?: string | AnthropicContentBlock[]; messages?: AnthropicMessage[]; stream?: boolean; include_workflow_events?: boolean; tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>; tool_choice?: unknown; max_tokens?: number; temperature?: number; top_p?: number; top_k?: number; stop_sequences?: string[]; }

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

const OPENAI_MODEL_ID = "dual-agent-orchestrator";

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

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ChatCompletionRequest>(req);
  const toolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  const mirrorProgressToContent = body.stream && !toolMode && shouldMirrorProgressToContent(body.include_progress_updates);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);

  if (toolMode) {
    if (extractLatestOpenAIWriteToolCompletion(body.messages as any)) {
      jsonResponse(res, 200, buildChatCompletionResponse(body.model || OPENAI_MODEL_ID, "File written successfully."));
      return;
    }
    if (extractLatestOpenAIResearchReadCompletion(body.messages as any)) {
      jsonResponse(res, 200, buildChatCompletionResponse(body.model || OPENAI_MODEL_ID, "Research evidence read successfully. Please summarize and finish without further tool calls."));
      return;
    }

    const overrides: CompletionOverrides = {};
    if (body.temperature !== undefined) overrides.temperature = body.temperature;
    if (body.max_tokens !== undefined) overrides.maxTokens = body.max_tokens;
    if (body.top_p !== undefined) overrides.topP = body.top_p;
    if (body.stop !== undefined) overrides.stop = body.stop;
    if (body.tool_choice !== undefined) overrides.toolChoice = body.tool_choice;
    const toolResult = await runToolMode(normalizeOpenAIToolMessages((body.messages || []) as any), body.model, body.tools, overrides);

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
        normalizeChatMessages((body.messages || []) as any),
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
      normalizeChatMessages((body.messages || []) as any),
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
  const messages = normalizeAnthropicMessages(body.messages as any, body.system);
  const requestedToolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolHistory = hasAnthropicToolHistory(body.messages as any);
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
    if (extractLatestAnthropicWriteToolCompletion(body.messages as any)) {
      jsonResponse(res, 200, buildAnthropicMessageResponse(body.model || OPENAI_MODEL_ID, "File written successfully."));
      return;
    }
    if (extractLatestAnthropicResearchReadCompletion(body.messages as any)) {
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
    const toolResult = await runToolMode(normalizeAnthropicToolMessages(body.messages as any, body.system), body.model, convertedTools);

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

export {
  handleChatCompletions,
  handleResponses,
  handleAnthropicMessages,
  buildChatCompletionResponse,
  buildToolChatCompletionResponse,
  buildChatCompletionChunk,
  buildToolChatCompletionChunk,
  buildResponsesOutput,
  buildResponsesResponse,
  buildAnthropicMessageResponse,
};
