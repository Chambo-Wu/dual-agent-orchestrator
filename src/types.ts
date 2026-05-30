export interface ModelConfig {
  provider: "openai_compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export type ModelRole = "planner" | "executor";

export interface RegisteredModel {
  id: string;
  role: ModelRole;
  enabled: boolean;
  model: ModelConfig;
}

export interface ModelRoutingConfig {
  plannerCandidates: string[];
  executorCandidates: string[];
}

export interface AgentToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface AgentLimits {
  max_concurrency?: number;
}

export interface RegisteredAgent {
  id: string;
  role: string;
  model: ModelConfig;
  tools?: AgentToolPolicy;
  limits?: AgentLimits;
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

export interface SkillsConfig {
  enabled: boolean;
  autoInstall: boolean;
  builtinDir: string;
  installDir: string;
  allowSources: Array<"builtin" | "local_dir" | "git" | "package">;
}

export interface SkillEvolutionConfig {
  enabled: boolean;
  autoReflect: boolean;
  autoPropose: boolean;
  autoAudit: boolean;
  autoValidate: boolean;
  autoAccept: boolean;
  runtimeReplayInAutoPipeline: boolean;
  candidateDir: string;
  riskTiering: {
    enabled: boolean;
    defaultTier: "low" | "medium" | "high";
    automationCeilings: {
      low: "auto_accept" | "auto_validate" | "auto_audit" | "auto_propose" | "auto_reflect";
      medium: "auto_accept" | "auto_validate" | "auto_audit" | "auto_propose" | "auto_reflect";
      high: "auto_accept" | "auto_validate" | "auto_audit" | "auto_propose" | "auto_reflect";
    };
  };
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
  modelRegistry: Record<string, RegisteredModel>;
  modelRouting: ModelRoutingConfig;
  executorToolPolicy?: AgentToolPolicy;
  agents?: Record<string, RegisteredAgent>;
  defaultExecutorAgent?: string;
  search?: SearchConfig;
  skills: SkillsConfig;
  skillEvolution: SkillEvolutionConfig;
  policy: {
    maxSteps: number;
    maxReplans: number;
    maxToolRetries: number;
    plannerHistoryMaxEntries: number;
    plannerHistoryPreviewChars: number;
    maxRepeatedExecutorRequests: number;
    autoResumeConcurrency: number;
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
    configuredProxyUrls?: string[];
  };
  diagnostics: {
    configPath: string;
    taskRoutingPath: string;
    searchProvider: string | null;
    autoResumeConcurrency: number;
    dependencyChecks: Array<{
      name: string;
      status: "ok" | "warning";
      summary: string;
      detail?: Record<string, unknown>;
    }>;
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

export type TaskType = "fact_research" | "research" | "web_search" | "code" | "data_analysis" | "file_ops" | "shell_ops" | "general";
export type ExecutionMode = "direct" | "orchestrated";
export type IntentRouteKind = "direct_answer" | "research" | "goal" | "coding";

export interface IntentRouteMetadata {
  kind: IntentRouteKind;
  reason: string;
  source: "heuristic" | "planner";
}

export interface TaskComplexityAssessment {
  mode: ExecutionMode;
  score: number;
  reasons: string[];
}

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

export interface PlannerSkillDecision {
  skill_id?: string;
  skill_action?: "use_installed" | "install_then_use" | "skip_skill";
  skill_reason?: string;
}

export interface SelectedSkillSummary {
  skill_id?: string;
  skill_action?: "use_installed" | "install_then_use" | "skip_skill";
  skill_reason?: string;
  skill_install_status?: "installed" | "install_required" | "skipped" | "unavailable";
}

export interface CandidateSkillSummary {
  skillId: string;
  score: number;
  reasons: string[];
  source: "rule" | "planner";
}

export interface IntentExecutionPlan {
  intent: IntentRouteMetadata;
  candidateSkills: CandidateSkillSummary[];
  selectedSkill?: SelectedSkillSummary;
}

export type WorkflowTaskKind =
  | "search"
  | "fetch"
  | "read"
  | "extract"
  | "transform"
  | "write"
  | "verify"
  | "synthesize"
  | "approval"
  | "delegate";

export type WorkflowRole = "worker" | "verifier" | "synthesizer" | "planner_proxy";

export interface WorkflowTaskRetryPolicy {
  max_attempts: number;
  on_failure: "replan" | "fail" | "skip" | "fallback";
  fallback_task_id?: string;
}

export interface WorkflowTaskOutputs {
  artifacts?: string[];
  memory_key?: string;
}

export interface WorkflowTaskInput {
  from_memory?: string[];
  from_artifacts?: string[];
}

export interface WorkflowTaskConstraints {
  max_tool_rounds?: number;
  max_runtime_seconds?: number;
  require_structured_output?: boolean;
  verifier_profile?: "system" | "system_and_model" | "artifact" | "file" | "json";
  verifier_agent_id?: string;
  minimum_artifact_count?: number;
  required_artifact_type?: ExecutorArtifact["type"];
  required_schema?: "json";
}

export interface WorkflowTaskSpec {
  id: string;
  title: string;
  kind: WorkflowTaskKind;
  role: WorkflowRole;
  instruction: string;
  allowed_tools: string[];
  depends_on: string[];
  required: boolean;
  input?: WorkflowTaskInput;
  constraints?: WorkflowTaskConstraints;
  retry_policy?: WorkflowTaskRetryPolicy;
  outputs?: WorkflowTaskOutputs;
}

export interface WorkflowFinishCondition {
  mode: "all_required_tasks_completed" | "any_of" | "first_success" | "manual_approval_resolved";
  task_ids?: string[];
}

export interface WorkflowReplanPolicy {
  allow_runtime_replan: boolean;
  max_replans: number;
}

export interface WorkflowPlan {
  id: string;
  strategy: string;
  summary: string;
  tasks: WorkflowTaskSpec[];
  finish_when: WorkflowFinishCondition;
  replan_policy?: WorkflowReplanPolicy;
}

export interface PlannerOutput {
  goal: string;
  status: "need_executor" | "workflow" | "final" | "clarify";
  reasoning_summary: string;
  next_step: string;
  audit: {
    verdict: "not_applicable" | "approved" | "retry" | "blocked";
    notes: string;
  };
  skill?: PlannerSkillDecision;
  workflow_plan?: WorkflowPlan;
  executor_request?: PlannerExecutorRequest;
  final_answer?: string;
  clarification_question?: string;
  decision_text?: string;
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
  display_summary?: string;
}

export type JobMode = "task" | "team";
export type JobStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "blocked" | "cancelled";
export type TaskRunStatus = "pending" | "in_progress" | "awaiting_approval" | "completed" | "failed" | "blocked" | "skipped";

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
  trustLevel?: "high" | "medium" | "low";
  sourceTaskRunId?: string;
  relatedTaskRunId?: string;
  relatedStep?: number;
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
  verificationResult?: VerificationResult;
}

export interface Plan {
  id: string;
  goal: string;
  mode: JobMode;
  taskRunIds: readonly string[];
  summary?: string;
  intentRoute?: IntentRouteMetadata;
  candidateSkills?: CandidateSkillSummary[];
  selectedSkill?: SelectedSkillSummary;
}

export interface WorkflowGraphTaskNode {
  id: string;
  task_id: string;
  title: string;
  status: TaskRunStatus;
  assignee: string | null;
  depends_on: readonly string[];
  verified: boolean;
  attempts: number;
  superseded: boolean;
  superseded_by: string | null;
}

export interface WorkflowGraphLane {
  workflow_id: string;
  status: "active" | "superseded";
  superseded_by?: string;
  task_count: number;
  completed_count: number;
  tasks: WorkflowGraphTaskNode[];
}

export interface WorkflowReplanHistoryEntry {
  index: number;
  superseded_workflow_id?: string;
  replacement_workflow_id?: string;
  failed_task_id?: string;
  summary?: string;
}

export interface WorkflowGraph {
  workflow_id: string;
  workflow_count: number;
  edge_count: number;
  workflows: WorkflowGraphLane[];
  replan_history: WorkflowReplanHistoryEntry[];
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
  workflowGraph?: WorkflowGraph;
  verificationResult?: VerificationResult;
  intentRoute?: IntentRouteMetadata;
  candidateSkills?: CandidateSkillSummary[];
  selectedSkill?: SelectedSkillSummary;
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

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
  status?: "passed" | "failed" | "insufficient";
  relatedArtifactIds?: string[];
}

export interface VerificationResult {
  status: "verified" | "insufficient" | "failed";
  summary: string;
  checks: VerificationCheck[];
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
  intentExecutionPlan?: IntentExecutionPlan;
  executorSelectionState?: {
    selectedCandidateIds?: string[];
    searchWarmupCompleted?: boolean;
  };
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

export type TaskStatus = "pending" | "in_progress" | "awaiting_approval" | "completed" | "failed" | "blocked" | "skipped";

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
