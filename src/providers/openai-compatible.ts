import type { ModelConfig, ModelResponse, RunOptions, ToolDefinition } from "../types.js";

export interface ChatMessage {
  role: string;
  content: string;
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

const DEFAULT_MAX_ATTEMPTS = 3;

export class UpstreamServiceError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number;

  constructor(message: string, statusCode: number, retryable = false, retryAfterMs = 0) {
    super(message);
    this.name = "UpstreamServiceError";
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled."));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeModelResponse(data: any): ModelResponse {
  const message = data?.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((call: any) => {
        const id = typeof call?.id === "string" ? call.id : "";
        const name = typeof call?.function?.name === "string" ? call.function.name : "";
        const args = typeof call?.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call?.function?.arguments ?? {});
        if (!name) return [];
        return [{ id, name, arguments: args }];
      })
    : [];

  return {
    content,
    reasoning,
    toolCalls,
    raw: data,
  };
}

export interface CompletionOverrides {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string | string[];
  toolChoice?: unknown;
}

export async function runChatCompletionDetailed(
  config: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: RunOptions,
  overrides?: CompletionOverrides
): Promise<ModelResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    temperature: overrides?.temperature ?? config.temperature,
    max_tokens: overrides?.maxTokens ?? config.maxTokens,
  };
  if (overrides?.topP !== undefined) body.top_p = overrides.topP;
  if (overrides?.stop !== undefined) body.stop = overrides.stop;
  if (tools && tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = overrides?.toolChoice ?? "auto";
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    if (options?.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error ? options.abortSignal.reason : new Error("Operation cancelled.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const onAbort = () => controller.abort(options?.abortSignal?.reason);
    options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? (parseInt(retryAfterHeader, 10) || 0) * 1000 : 0;
        throw new UpstreamServiceError(
          `Model request failed: ${response.status} ${response.statusText}`,
          response.status,
          response.status >= 500 || response.status === 429,
          retryAfterMs
        );
      }

      const data = await response.json() as any;
      return normalizeModelResponse(data);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = error instanceof UpstreamServiceError
        ? error.retryable
        : /500|502|503|504|abort/i.test(lastError.message);
      if (!retryable || attempt === DEFAULT_MAX_ATTEMPTS) {
        throw lastError;
      }
      const backoffMs = lastError instanceof UpstreamServiceError && lastError.retryAfterMs > 0
        ? lastError.retryAfterMs
        : 300 * attempt;
      await sleep(backoffMs, options?.abortSignal);
    } finally {
      clearTimeout(timeout);
      options?.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError ?? new Error("Model request failed");
}

export async function runChatCompletion(config: ModelConfig, messages: ChatMessage[]): Promise<string> {
  const result = await runChatCompletionDetailed(config, messages);
  return result.content || result.reasoning || "";
}
