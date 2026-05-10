import type { ModelConfig, ModelResponse, ToolDefinition } from "../types.js";

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

  constructor(message: string, statusCode: number, retryable = false) {
    super(message);
    this.name = "UpstreamServiceError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function runChatCompletionDetailed(
  config: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolDefinition[]
): Promise<ModelResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
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
        throw new UpstreamServiceError(
          `Model request failed: ${response.status} ${response.statusText}`,
          response.status,
          response.status >= 500
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
      await sleep(300 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Model request failed");
}

export async function runChatCompletion(config: ModelConfig, messages: ChatMessage[]): Promise<string> {
  const result = await runChatCompletionDetailed(config, messages);
  return result.content || result.reasoning || "";
}
