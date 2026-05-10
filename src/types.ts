export interface ModelConfig {
  provider: "openai_compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export interface OrchestratorConfig {
  planner: ModelConfig;
  executor: ModelConfig;
  policy: {
    maxSteps: number;
    maxReplans: number;
    maxToolRetries: number;
    plannerHistoryMaxEntries: number;
    plannerHistoryPreviewChars: number;
    maxRepeatedExecutorRequests: number;
  };
  taskRoutingPath?: string;
}

export type TaskType = "research" | "web_search" | "code" | "data_analysis" | "file_ops" | "shell_ops" | "general";

export interface RoutePolicy {
  type: TaskType;
  matchers: string[];
  plannerInstruction: string;
  enableRanking: boolean;
  requireEvidenceBeforeFinal: boolean;
  preferredTools: string[];
  artifactPriority: string[];
  completionChecklist: string[];
  fallbackRule: string;
}

export interface PlannerExecutorRequest {
  instruction: string;
  allowed_tools: string[];
  expected_output: string;
}

export interface PlannerOutput {
  goal: string;
  status: "need_executor" | "final" | "clarify";
  reasoning_summary: string;
  next_step: string;
  audit: {
    verdict: "not_applicable" | "approved" | "retry" | "blocked";
    notes: string;
  };
  executor_request?: PlannerExecutorRequest;
  final_answer?: string;
  clarification_question?: string;
}

export interface ExecutorToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ExecutorArtifact {
  type: "file" | "text" | "json";
  path?: string;
  content_preview: string;
}

export interface ExecutorOutput {
  status: "success" | "failed" | "blocked";
  summary: string;
  tool_calls_made: ExecutorToolCall[];
  artifacts: ExecutorArtifact[];
  raw_result: string;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  artifact?: ExecutorArtifact;
  rawResult: string;
  error?: string;
}

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelResponse {
  content: string;
  reasoning: string;
  toolCalls: NativeToolCall[];
  raw: unknown;
}
