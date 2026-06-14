import type { AnthropicContentBlock, AnthropicMessage, OpenAIMessage, ResponseInputItem } from "./chat-message-utils.js";

export interface ChatCompletionRequest {
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

export interface ResponsesRequest {
  model?: string;
  input?: string | ResponseInputItem[];
  instructions?: string;
  stream?: boolean;
  include_workflow_events?: boolean;
}

export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  stream?: boolean;
  include_workflow_events?: boolean;
  tools?: Array<{
    name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}
