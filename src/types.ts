export interface ModelConfig {
  provider: "openai_compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

// ---------------------------------------------------------------------------
// Search Provider
// ---------------------------------------------------------------------------

export type SearchProviderType = "bing_html" | "searxng" | "serpapi" | "bing_api" | "google_cse" | "url_template" | "mcp";

export interface SearchConfig {
  provider: SearchProviderType;
  fallbackEnabled: boolean;
  apiKey: string;
  timeoutMs: number;
  providers: Record<string, Record<string, unknown>>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRequest {
  url: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Orchestrator Config
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  planner: ModelConfig;
  executor: ModelConfig;
  search?: SearchConfig;
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

export interface RuntimeProfile {
  platform: {
    os: "windows" | "macos" | "linux" | "unknown";
    shell: "powershell" | "cmd" | "bash" | "zsh" | "sh" | "unknown";
    pathSeparator: "\\" | "/" | "";
    defaultEncoding: "utf-8";
  };
  filesystem: {
    workspaceRoot: string;
    runtimeRoot: string;
    writableRoots: string[];
  };
  network: {
    enabled: boolean;
    proxyMode: "direct" | "env";
    proxyHealth: "ok" | "degraded";
  };
  executor: {
    supportsNativeToolCalling: boolean;
    supportsStructuredJson: boolean;
    maxToolRounds: number;
  };
  tools: Array<{
    name: string;
    kind: "file" | "network" | "code" | "system";
    safe: boolean;
    fallbackOnly?: boolean;
  }>;
}

export type TaskType = "research" | "web_search" | "code" | "data_analysis" | "file_ops" | "shell_ops" | "general";

export interface RoutePolicy {
  type: TaskType;
  matchers: string[];
  plannerInstruction: string;
  enableRanking: boolean;
  requireEvidenceBeforeFinal: boolean;
  minGroundedCandidates: number;
  requireArtifactReadback: boolean;
  requireNonEmptyArtifact: boolean;
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

export type OrchestratorStepState = "pending" | "planning" | "executing" | "completed" | "failed" | "blocked" | "finalized";

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
  status: "success" | "partial_success" | "failed" | "blocked";
  summary: string;
  tool_calls_made: ExecutorToolCall[];
  artifacts: ExecutorArtifact[];
  raw_result: string;
  error?: string;
  source?: "native_tool" | "model_text";
}

export type JobMode = "task" | "team";
export type JobStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "blocked" | "cancelled";
export type TaskRunStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked" | "skipped";

export interface ApprovalRequest {
  id: string;
  jobId: string;
  taskIds: string[];
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  respondedAt?: string;
  responseNote?: string;
}

export interface Artifact {
  id: string;
  type: ExecutorArtifact["type"] | "summary";
  path?: string;
  contentPreview: string;
  source: "executor" | "task_run" | "synthesis";
  sourceTaskRunId?: string;
}

export interface TaskRun {
  id: string;
  title: string;
  description: string;
  status: TaskRunStatus;
  assignee?: string;
  dependsOn: readonly string[];
  verified: boolean;
  output: string;
  artifacts: Artifact[];
  attempts: number;
  executorHistory?: readonly ExecutorOutput[];
}

export interface Plan {
  id: string;
  goal: string;
  mode: JobMode;
  taskRunIds: readonly string[];
  summary?: string;
}

export interface Job {
  id: string;
  goal: string;
  mode: JobMode;
  status: JobStatus;
  verified: boolean;
  output: string;
  plan: Plan;
  taskRuns: readonly TaskRun[];
  artifacts: readonly Artifact[];
  memorySummary?: string;
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

export interface OrchestratorEvent {
  type: string;
  step?: number;
  data: Record<string, unknown>;
}

export type OrchestratorEventCallback = (event: OrchestratorEvent) => void;

export interface RunOptions {
  abortSignal?: AbortSignal;
  jobId?: string;
  planId?: string;
  taskRunId?: string;
  onEvent?: OrchestratorEventCallback;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  readonly key: string;
  readonly value: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly expiresAtTurn?: number;
}

export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | null>;
  set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void>;
  setWithExpiry?(key: string, value: string, expiresAtTurn: number, metadata?: Record<string, unknown>): Promise<void>;
  list(): Promise<MemoryEntry[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked" | "skipped";

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  status: TaskStatus;
  assignee?: string;
  dependsOn?: readonly string[];
  readonly memoryScope?: "dependencies" | "all";
  result?: string;
  verified?: boolean;
  readonly createdAt: Date;
  updatedAt: Date;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly retryBackoff?: number;
}

export interface TaskSpec {
  title: string;
  description: string;
  assignee?: string;
  dependsOn?: string[];
  memoryScope?: "dependencies" | "all";
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoff?: number;
}

export interface TeamConfig {
  maxConcurrency?: number;
  maxToolOutputChars?: number;
  onApproval?: (tasks: readonly Task[]) => Promise<boolean>;
  maxRounds?: number;
  planOnly?: boolean;
}

export interface RunTaskResult {
  status: "completed" | "failed" | "blocked";
  output: string;
  verified: boolean;
  executorHistory: ExecutorOutput[];
  job: Job;
  plan: Plan;
  taskRuns: TaskRun[];
  artifacts: Artifact[];
}
