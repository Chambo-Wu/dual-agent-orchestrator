import { EXECUTOR_PROMPT, PLANNER_PROMPT } from "./prompts.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { parseModelJson } from "./json.js";
import { parseExecutorOutput } from "./executor-adapter.js";
import type { RunLogger } from "./logger.js";
import { executeTool, TOOL_DEFINITIONS } from "./tools.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT } from "./paths.js";
import type { AgentToolPolicy, ExecutionMode, ExecutorOutput, OrchestratorConfig, OrchestratorStepState, PlannerExecutorRequest, PlannerOutput, RoutePolicy, RunOptions, RunTaskResult, TaskComplexityAssessment, TaskType } from "./types.js";
import { Tracer } from "./trace.js";
import { LoopDetector } from "./loop-detector.js";
import { compressJsonOutput } from "./compress.js";
import { buildSingleTaskContract } from "./workflow-contract.js";
import { mergeRuntimeDeps, type RuntimeDeps } from "./runtime/deps.js";
import { buildRuntimeProfile } from "./runtime/profile.js";
import { buildWorkflowFallbackExecutorRequest, parseWorkflowPlan, validateWorkflowPlan, assessWorkflowExecutionSupport } from "./workflow-plan.js";
import { runWorkflowPlan } from "./workflow-runtime.js";
import { getExecutorDecisionText, getExecutorDisplaySummary, getPlannerDecisionText } from "./output-contract.js";

export class PlannerUnavailableError extends Error {
  readonly causeError?: Error;

  constructor(message: string, causeError?: Error) {
    super(message);
    this.name = "PlannerUnavailableError";
    this.causeError = causeError;
  }
}

export class RunCancelledError extends Error {
  constructor(message = "Run cancelled.") {
    super(message);
    this.name = "RunCancelledError";
  }
}

function assertNotCancelled(options?: RunOptions): void {
  if (!options?.abortSignal?.aborted) return;
  const reason = options.abortSignal.reason;
  throw reason instanceof Error ? reason : new RunCancelledError(typeof reason === "string" ? reason : undefined);
}

type RepoCandidate = {
  name: string;
  full_name?: string;
  html_url: string;
  description: string;
  stargazers_count: number;
  language?: string;
  updated_at?: string;
  topics: string[];
  score: number;
  label: "recommended" | "consider" | "exclude";
  reasons: string[];
  concerns: string[];
  source: string;
};

function toolListText(): string {
  return TOOL_DEFINITIONS.map((tool) => {
    return `- ${tool.name}: ${tool.description}`;
  }).join("\n");
}

function runtimeProfileText(config: OrchestratorConfig): string {
  return JSON.stringify(buildRuntimeProfile(config), null, 2);
}

function previewText(input: string, limit = 400): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function safeReadTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeWriteTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePathForComparison(value: string): string {
  return value.replace(/[\\/]+/g, "/").toLowerCase();
}

function extractRequestedOutputPath(goal: string): string | undefined {
  const absoluteMatch = goal.match(/[A-Za-z]:\\[^\r\n"“”]+?\.(md|markdown|txt|json|csv)/i);
  if (absoluteMatch?.[0]) {
    return resolve(absoluteMatch[0]);
  }

  const quotedMatch = goal.match(/[“"]([^"”]+?\.(md|markdown|txt|json|csv))[”"]/i);
  if (quotedMatch?.[1]) {
    return resolve(WORKSPACE_ROOT, quotedMatch[1]);
  }

  const bareNameMatch = goal.match(/\b([^\s\\/]+?\.(md|markdown|txt|json|csv))\b/i);
  if (bareNameMatch?.[1] && /(写入本地|write\s+to\s+local|save\s+to\s+local|写入文件|write.*file)/i.test(goal)) {
    return resolve(WORKSPACE_ROOT, bareNameMatch[1]);
  }

  return undefined;
}

function parsePlannerExecutorRequest(value: unknown): PlannerExecutorRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isNonEmptyString(value.instruction) || !isNonEmptyString(value.expected_output) || !Array.isArray(value.allowed_tools)) {
    return undefined;
  }

  const allowedTools = value.allowed_tools.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (allowedTools.length === 0) {
    return undefined;
  }

  return {
    instruction: value.instruction,
    allowed_tools: allowedTools,
    expected_output: value.expected_output,
  };
}

function parsePlannerStatus(value: unknown): PlannerOutput["status"] {
  return value === "need_executor" || value === "workflow" || value === "final" || value === "clarify"
    ? value
    : "clarify";
}

function parsePlannerAudit(
  value: unknown,
  hasExecutorHistory: boolean,
): PlannerOutput["audit"] {
  if (!isRecord(value)) {
    return {
      verdict: hasExecutorHistory ? "approved" : "not_applicable",
      notes: "",
    };
  }

  return {
    verdict: value.verdict === "approved"
      || value.verdict === "retry"
      || value.verdict === "blocked"
      || value.verdict === "not_applicable"
      ? value.verdict
      : "not_applicable",
    notes: typeof value.notes === "string" ? value.notes : "",
  };
}

function parsePlannerOutputRecord(
  userGoal: string,
  parsed: Record<string, unknown>,
  hasExecutorHistory: boolean,
): PlannerOutput {
  const normalized: PlannerOutput = {
    goal: userGoal,
    status: parsePlannerStatus(parsed.status),
    reasoning_summary: typeof parsed.step === "string" ? parsed.step : "",
    next_step: typeof parsed.step === "string" ? parsed.step : "",
    audit: parsePlannerAudit(parsed.audit, hasExecutorHistory),
    workflow_plan: parseWorkflowPlan(parsed.workflow_plan),
    executor_request: parsePlannerExecutorRequest(parsed.executor_request),
    final_answer: typeof parsed.answer === "string" ? parsed.answer : undefined,
    clarification_question: typeof parsed.question === "string" ? parsed.question : undefined,
  };
  return {
    ...normalized,
    decision_text: getPlannerDecisionText(normalized),
  };
}

function applyWorkflowMilestoneAFallback(
  planner: PlannerOutput,
  stepNumber: number,
  logger?: RunLogger,
  options?: RunOptions,
): PlannerOutput {
  if (planner.status !== "workflow") {
    return planner;
  }

  if (!planner.workflow_plan) {
    logger?.log("planner.protocol_violation", {
      step: stepNumber,
      reason: "workflow_without_valid_workflow_plan",
      parsed: planner,
    });
    return {
      ...planner,
      status: "clarify",
      audit: {
        verdict: "blocked",
        notes: planner.audit.notes
          ? `${planner.audit.notes} Protocol corrected: workflow status requires a valid workflow_plan.`
          : "Protocol corrected: workflow status requires a valid workflow_plan.",
      },
    };
  }

  const validation = validateWorkflowPlan(planner.workflow_plan, TOOL_DEFINITIONS);
  emitWorkflowPlanEvents(planner.workflow_plan, validation, stepNumber, logger, options);

  const fallbackRequest = buildWorkflowFallbackExecutorRequest(planner.workflow_plan);
  if (!validation.valid || !fallbackRequest) {
    const validationNotes = validation.issues.length > 0
      ? validation.issues.join("; ")
      : "Workflow plan could not be materialized into a fallback executor request.";
    return {
      ...planner,
      status: "clarify",
      audit: {
        verdict: "blocked",
        notes: planner.audit.notes
          ? `${planner.audit.notes} ${validationNotes}`
          : validationNotes,
      },
      executor_request: undefined,
    };
  }

  logger?.log("workflow.plan.degraded", {
    step: stepNumber,
    workflow_id: planner.workflow_plan.id,
    fallback_executor_request: fallbackRequest,
  });

  return {
    ...planner,
    status: "need_executor",
    audit: {
      verdict: planner.audit.verdict === "blocked" ? "blocked" : "approved",
      notes: planner.audit.notes
        ? `${planner.audit.notes} Runtime fallback applied: the workflow plan was recorded and degraded to a single executor step.`
        : "Runtime fallback applied: the workflow plan was recorded and degraded to a single executor step.",
    },
    executor_request: fallbackRequest,
  };
}

function shouldExecuteWorkflowPlan(plan: import("./types.js").WorkflowPlan): boolean {
  return assessWorkflowExecutionSupport(plan).supported;
}

function emitWorkflowPlanEvents(
  plan: import("./types.js").WorkflowPlan,
  validation: import("./workflow-plan.js").WorkflowPlanValidationResult,
  stepNumber: number,
  logger?: RunLogger,
  options?: RunOptions,
): void {
  logger?.log("workflow.plan.created", {
    step: stepNumber,
    workflow_plan: plan,
  });
  options?.onEvent?.({
    type: "workflow.plan.created",
    step: stepNumber,
    data: {
      workflow_id: plan.id,
      strategy: plan.strategy,
      summary: plan.summary,
      task_count: plan.tasks.length,
      finish_mode: plan.finish_when.mode,
    },
  });

  if (validation.valid) {
    logger?.log("workflow.plan.validated", {
      step: stepNumber,
      workflow_id: plan.id,
      task_count: plan.tasks.length,
    });
    options?.onEvent?.({
      type: "workflow.plan.validated",
      step: stepNumber,
      data: {
        workflow_id: plan.id,
        task_count: plan.tasks.length,
      },
    });
  } else {
    logger?.log("workflow.plan.rejected", {
      step: stepNumber,
      workflow_id: plan.id,
      issues: validation.issues,
    });
    options?.onEvent?.({
      type: "workflow.plan.rejected",
      step: stepNumber,
      data: {
        workflow_id: plan.id,
        issues: validation.issues,
      },
    });
  }
}

function normalizeRequestKey(request: PlannerExecutorRequest | undefined): string {
  if (!request) {
    return "";
  }
  return JSON.stringify({
    instruction: request.instruction.replace(/\s+/g, " ").trim(),
    allowed_tools: [...request.allowed_tools].sort(),
    expected_output: request.expected_output.replace(/\s+/g, " ").trim(),
  });
}

function applyToolPolicy(tools: string[], policy?: AgentToolPolicy): string[] {
  let effectiveTools = [...tools];
  if (policy?.allow && policy.allow.length > 0) {
    const allowed = new Set(policy.allow);
    effectiveTools = effectiveTools.filter((tool) => allowed.has(tool));
  }
  if (policy?.deny && policy.deny.length > 0) {
    const denied = new Set(policy.deny);
    effectiveTools = effectiveTools.filter((tool) => !denied.has(tool));
  }
  return Array.from(new Set(effectiveTools));
}

function applyExecutorToolPolicy(
  request: PlannerExecutorRequest,
  policy?: AgentToolPolicy,
): PlannerExecutorRequest {
  if (!policy) {
    return request;
  }
  return {
    ...request,
    allowed_tools: applyToolPolicy(request.allowed_tools, policy),
  };
}

function summarizeRecentArtifacts(executorHistory: ExecutorOutput[]): string {
  const artifacts = executorHistory
    .flatMap((item) => item.artifacts)
    .filter((artifact) => artifact.path)
    .slice(-6)
    .map((artifact) => `${artifact.type}:${artifact.path}`);
  return artifacts.length > 0 ? artifacts.join("; ") : "none";
}

function hasSubstantiveDirectAnswer(executorResult: ExecutorOutput): boolean {
  if (executorResult.status !== "success" && executorResult.status !== "partial_success") {
    return false;
  }

  if (executorResult.tool_calls_made.some((call) => call.tool === "write_file")) {
    return true;
  }

  if (executorResult.tool_calls_made.some((call) => call.tool === "read_file" || call.tool === "url_fetch" || call.tool === "parse_json")) {
    return true;
  }

  if (/^Found \d+ results/i.test(executorResult.summary) || /\(legacy\)/i.test(executorResult.summary)) {
    return false;
  }

  return executorResult.raw_result.trim().length >= 80 || executorResult.summary.trim().length >= 80;
}

function hasUsefulExecutorProgress(conversation: {
  executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  artifacts: ExecutorOutput["artifacts"];
  lastSummary: string;
  lastRawResult: string;
  ok: boolean;
}): boolean {
  if (!conversation.ok) {
    return false;
  }
  if (conversation.artifacts.length > 0) {
    return true;
  }
  if (conversation.lastRawResult.trim()) {
    return true;
  }
  if (conversation.executedCalls.length > 0 && conversation.lastSummary.trim()) {
    return true;
  }
  return false;
}

function matchesGoal(goal: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(goal);
}

export function detectTaskType(userGoal: string, routing: RoutePolicy[]): TaskType {
  const goal = userGoal.toLowerCase();
  for (const route of routing) {
    if (route.matchers.some((matcher) => matchesGoal(goal, matcher))) {
      return route.type;
    }
  }
  return "general";
}

export function getRoutePolicy(taskType: TaskType, routing: RoutePolicy[]): RoutePolicy {
  return routing.find((route) => route.type === taskType) || routing[routing.length - 1];
}

function buildDirectExecutorRequest(goal: string, routePolicy: RoutePolicy, requestedOutputPath?: string): PlannerExecutorRequest {
  const normalizedGoal = goal.toLowerCase();

  if (/\b(weather|forecast|temperature|humidity|wind)\b|天气|气温|预报/.test(normalizedGoal)) {
    return {
      instruction: requestedOutputPath
        ? `Use weather_lookup first to get the requested forecast directly. If that succeeds, write the final answer to ${requestedOutputPath}. Only fall back to web_search or url_fetch if the direct lookup fails.`
        : "Use weather_lookup first to get the requested forecast directly. Only fall back to web_search or url_fetch if the direct lookup fails.",
      allowed_tools: ["weather_lookup", "web_search", "url_fetch", "read_file", "write_file"],
      expected_output: requestedOutputPath
        ? `A concise weather forecast summary written to ${requestedOutputPath}.`
        : "A concise weather forecast summary with daily details.",
    };
  }

  if (/\b(time|timezone|utc|clock)\b|时间|时区/.test(normalizedGoal)) {
    return {
      instruction: requestedOutputPath
        ? `Use time_lookup first to determine the requested time or timezone information, then write the result to ${requestedOutputPath}.`
        : "Use time_lookup first to determine the requested time or timezone information and return the result directly.",
      allowed_tools: ["time_lookup", "write_file"],
      expected_output: requestedOutputPath
        ? `A short time answer written to ${requestedOutputPath}.`
        : "A short direct answer about time or timezone.",
    };
  }

  if (/\b(stock|stocks|ticker|quote|price|market cap|crypto|btc|eth|usd|cny|exchange rate)\b|股价|股票|币价|汇率|行情|价格/.test(normalizedGoal)) {
    return {
      instruction: requestedOutputPath
        ? `Use finance_lookup first to get the requested market quote or exchange-related data, then write the concise answer to ${requestedOutputPath}.`
        : "Use finance_lookup first to get the requested market quote or exchange-related data and return the answer directly.",
      allowed_tools: ["finance_lookup", "write_file", "web_search"],
      expected_output: requestedOutputPath
        ? `A concise finance answer written to ${requestedOutputPath}.`
        : "A concise finance answer with the key quote values.",
    };
  }

  if (/\b(score|scores|schedule|standings|match|game|fixture|nba|nfl|mlb|nhl|epl)\b|比分|赛程|排名|比赛/.test(normalizedGoal)) {
    return {
      instruction: requestedOutputPath
        ? `Use sports_lookup first to get the requested schedule or scoreboard information, then write the concise result to ${requestedOutputPath}.`
        : "Use sports_lookup first to get the requested schedule or scoreboard information and return the result directly.",
      allowed_tools: ["sports_lookup", "write_file", "web_search"],
      expected_output: requestedOutputPath
        ? `A concise sports answer written to ${requestedOutputPath}.`
        : "A concise sports answer with the requested games or standings.",
    };
  }

  if (routePolicy.type === "file_ops") {
    return {
      instruction: requestedOutputPath
        ? `Complete this file task directly with the narrowest possible read/write operations. If the task asks for local output, write the result to ${requestedOutputPath}. Avoid broad exploration. Goal: ${goal}`
        : `Complete this file task directly with the narrowest possible read/write operations. Avoid broad exploration. Goal: ${goal}`,
      allowed_tools: ["list_files", "read_file", "write_file", "parse_json"],
      expected_output: requestedOutputPath
        ? `Requested file task completed and local output written to ${requestedOutputPath} when applicable.`
        : "Requested file task completed directly.",
    };
  }

  return {
    instruction: requestedOutputPath
      ? `Complete this simple task using the fewest steps possible. Prefer one direct lookup or one direct file operation. If the user requested a local output file, write the result to ${requestedOutputPath}. Goal: ${goal}`
      : `Complete this simple task using the fewest steps possible. Prefer one direct lookup or one direct file operation. Goal: ${goal}`,
    allowed_tools: [...new Set([...routePolicy.preferredTools, "web_search", "url_fetch", "read_file", "write_file", "parse_json"])],
    expected_output: requestedOutputPath
      ? `A concise result written to ${requestedOutputPath} when requested.`
      : "A concise direct answer.",
  };
}

export function assessTaskComplexity(userGoal: string, taskType: TaskType, routePolicy: RoutePolicy): TaskComplexityAssessment {
  const goal = userGoal.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (taskType === "research" || taskType === "code" || taskType === "data_analysis") {
    score -= 5;
    reasons.push(`task type ${taskType} defaults to orchestration`);
  }

  if (/\b(compare|comparison|research|survey|rank|ranking|evaluate|analysis|analyze|investigate|debug|fix|refactor)\b|对比|比较|调研|研究|分析|评测|修复|重构/.test(goal)) {
    score -= 4;
    reasons.push("goal implies multi-step analysis or comparison");
  }

  if (/\b(weather|forecast|temperature|humidity|wind|time|timezone|utc|clock|price|quote|score|schedule|standings)\b|天气|气温|预报|时间|时区|汇率|价格|比分|赛程/.test(goal)) {
    score += 4;
    reasons.push("goal looks like a direct factual lookup");
  }

  if (/\b(summarize|summary|extract|list|show|what is|when is|today|tomorrow|this week)\b|总结|提取|列出|是什么|什么时候|今天|明天|本周/.test(goal)) {
    score += 2;
    reasons.push("requested output is short-form or extractive");
  }

  if (routePolicy.type === "file_ops") {
    score += 3;
    reasons.push("file ops usually support direct execution");
  }

  if (routePolicy.type === "general" || routePolicy.type === "web_search") {
    score += 1;
    reasons.push(`route type ${routePolicy.type} can often be satisfied with a direct path`);
  }

  if (/\b(write|save|create)\b.+\.(md|markdown|txt|json|csv)\b|写入本地|保存到本地|生成.*\.md/.test(goal)) {
    score -= 1;
    reasons.push("local file output adds a small amount of execution overhead");
  }

  if (/\b(report|document|proposal|plan|design)\b|报告|文档|方案|设计/.test(goal)) {
    score -= 3;
    reasons.push("long-form output usually needs orchestration");
  }

  const mode: ExecutionMode = score >= 4 ? "direct" : "orchestrated";
  reasons.push(mode === "direct" ? "direct path chosen" : "full orchestration required");
  return { mode, score, reasons };
}

async function runDirectTask(
  config: OrchestratorConfig,
  taskPrompt: string,
  routePolicy: RoutePolicy,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<RunTaskResult> {
  const runtimeDeps = mergeRuntimeDeps(deps);
  const requestedOutputPath = extractRequestedOutputPath(taskPrompt);
  const directRequest = buildDirectExecutorRequest(taskPrompt, routePolicy, requestedOutputPath);
  const executorHistory: ExecutorOutput[] = [];

  logger?.log("orchestrator.direct.request", {
    request: directRequest,
    requested_output_path: requestedOutputPath,
    route_policy: routePolicy.type,
  });
  options?.onEvent?.({
    type: "workflow.complexity.assessed",
    data: {
      execution_mode: "direct",
      route_type: routePolicy.type,
      requested_output_path: requestedOutputPath ?? "",
    },
  });

  const planner: PlannerOutput = {
    goal: taskPrompt,
    status: "need_executor",
    reasoning_summary: "Direct mode: attempting the simplest viable execution path first.",
    next_step: "direct_executor",
    audit: {
      verdict: "not_applicable",
      notes: "Simple task fast path selected before full orchestration.",
    },
    executor_request: directRequest,
  };

  const executorResult = await runtimeDeps.runExecutorStep(config, planner, 1, logger, runtimeDeps, options);
  executorHistory.push(executorResult);

  const goalCheck = requestedOutputPath
    ? {
        achieved: hasSuccessfulWriteToPath(executorHistory, requestedOutputPath),
        answer: executorHistory.at(-1)?.summary || `File written successfully to ${requestedOutputPath}.`,
      }
    : checkGoalAchieved(executorHistory, routePolicy);

  if (goalCheck.achieved) {
    logger?.log("orchestrator.direct.completed", {
      output: goalCheck.answer ?? "",
      requested_output_path: requestedOutputPath,
    });
    return finalizeRunTaskResult({
      goal: taskPrompt,
      status: "completed",
      output: goalCheck.answer ?? "",
      verified: true,
      executorHistory,
      options,
    });
  }

  if (hasSubstantiveDirectAnswer(executorResult)) {
    const output = getExecutorDecisionText(executorResult);
    logger?.log("orchestrator.direct.completed", {
      output,
      requested_output_path: requestedOutputPath,
    });
    return finalizeRunTaskResult({
      goal: taskPrompt,
      status: "completed",
      output,
      verified: executorResult.status === "success",
      executorHistory,
      options,
    });
  }

  logger?.log("orchestrator.direct.escalate", {
    reason: getExecutorDecisionText(executorResult),
    status: executorResult.status,
  });

  return finalizeRunTaskResult({
    goal: taskPrompt,
    status: "failed",
    output: getExecutorDecisionText(executorResult) || "Direct execution could not complete the task.",
    verified: false,
    executorHistory,
    options,
  });
}

function isRepoRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.html_url);
}

function normalizeRepoRecord(record: Record<string, unknown>, source: string): RepoCandidate | null {
  if (!isRepoRecord(record)) {
    return null;
  }

  const name = record.name;
  const htmlUrl = record.html_url;
  if (typeof name !== "string" || typeof htmlUrl !== "string") {
    return null;
  }
  const description = typeof record.description === "string" ? record.description : "";
  const topics = Array.isArray(record.topics)
    ? record.topics.filter((item): item is string => typeof item === "string")
    : [];
  const repo: RepoCandidate = {
    name,
    full_name: typeof record.full_name === "string" ? record.full_name : undefined,
    html_url: htmlUrl,
    description,
    stargazers_count: typeof record.stargazers_count === "number" ? record.stargazers_count : 0,
    language: typeof record.language === "string" ? record.language : undefined,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : undefined,
    topics,
    score: 0,
    label: "consider",
    reasons: [],
    concerns: [],
    source,
  };

  return scoreRepoCandidate(repo);
}

function scoreRepoCandidate(repo: RepoCandidate): RepoCandidate {
  const haystack = `${repo.name} ${repo.full_name ?? ""} ${repo.description} ${repo.topics.join(" ")}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  const concerns: string[] = [];

  const positiveSignals: Array<[RegExp, number, string]> = [
    [/\bdual\b|\btwo-agent\b|\bdual-agent\b/, 4, "mentions dual-agent pattern"],
    [/\bhierarch/i, 4, "mentions hierarchical orchestration"],
    [/\borchestr/i, 3, "mentions orchestration"],
    [/\blocal\b|\bollama\b|\bedge\b|\bprivacy\b/, 3, "mentions local or privacy-first execution"],
    [/\btoken\b|\bcost\b|\befficien/i, 3, "mentions token or cost optimization"],
    [/\bmanager\b|\bplanner\b|\bexecutor\b|\bworker\b|\brouter\b/, 2, "mentions manager-worker style roles"],
    [/\bmulti-agent\b|\bagent\b/, 1, "mentions agent workflow"],
  ];

  for (const [pattern, weight, reason] of positiveSignals) {
    if (pattern.test(haystack)) {
      score += weight;
      reasons.push(reason);
    }
  }

  const negativeSignals: Array<[RegExp, number, string]> = [
    [/\bcyber warfare\b|\bred team\b|\bblack team\b/, -4, "domain is far from general orchestration"],
    [/\bbrowser automation\b|\bscreenshot\b/, -2, "specialized browser automation focus"],
    [/\bcamera\b|\bmultimodal\b/, -2, "specialized multimodal hardware focus"],
  ];

  for (const [pattern, weight, reason] of negativeSignals) {
    if (pattern.test(haystack)) {
      score += weight;
      concerns.push(reason);
    }
  }

  if (repo.stargazers_count >= 500) {
    score += 4;
    reasons.push("strong community traction");
  } else if (repo.stargazers_count >= 100) {
    score += 3;
    reasons.push("good community traction");
  } else if (repo.stargazers_count >= 20) {
    score += 2;
    reasons.push("some community traction");
  } else if (repo.stargazers_count >= 5) {
    score += 1;
    reasons.push("early but visible traction");
  } else {
    concerns.push("very limited community traction");
  }

  if (!/\blocal\b|\bollama\b|\bprivacy\b|\btoken\b|\bcost\b|\bhierarch/i.test(haystack)) {
    concerns.push("weak explicit signal for local/token-saving manager-worker goal");
  }

  let label: RepoCandidate["label"] = "consider";
  if (score >= 9) {
    label = "recommended";
  } else if (score <= 2) {
    label = "exclude";
  }

  return {
    ...repo,
    score,
    label,
    reasons: Array.from(new Set(reasons)).slice(0, 4),
    concerns: Array.from(new Set(concerns)).slice(0, 3),
  };
}

function parseRepoCandidatesFromText(text: string, source: string): RepoCandidate[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const directArray = (() => {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  if (directArray) {
    return normalizeRepoCandidatesFromArray(directArray, source);
  }

  try {
    const parsed = parseModelJson<unknown>(trimmed);
    if (Array.isArray(parsed)) {
      return normalizeRepoCandidatesFromArray(parsed, source);
    }
    if (isRecord(parsed)) {
      if (Array.isArray(parsed.items)) {
        return normalizeRepoCandidatesFromArray(parsed.items, source);
      }
      const repo = normalizeRepoRecord(parsed, source);
      return repo ? [repo] : [];
    }
  } catch {
    // ignore
  }

  return [];
}

function normalizeRepoCandidatesFromArray(items: unknown[], source: string): RepoCandidate[] {
  const candidates: RepoCandidate[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }

    const normalized = normalizeRepoRecord(item, source);
    if (normalized) {
      candidates.push(normalized);
      continue;
    }

    const fullName = typeof item.full_name === "string" ? item.full_name.trim() : "";
    const htmlUrl = typeof item.html_url === "string" ? item.html_url.trim() : "";
    if (!fullName || !htmlUrl) {
      continue;
    }

    const description = typeof item.description === "string" ? item.description : "";
    const topics = Array.isArray(item.topics)
      ? item.topics.filter((topic): topic is string => typeof topic === "string")
      : [];

    candidates.push(scoreRepoCandidate({
      name: fullName.includes("/") ? fullName.split("/").pop() || fullName : fullName,
      full_name: fullName,
      html_url: htmlUrl,
      description,
      stargazers_count: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
      language: typeof item.language === "string" ? item.language : undefined,
      updated_at: typeof item.updated_at === "string" ? item.updated_at : undefined,
      topics,
      score: 0,
      label: "consider",
      reasons: [],
      concerns: [],
      source,
    }));
  }

  return candidates;
}

function extractScoredCandidates(executorHistory: ExecutorOutput[]): RepoCandidate[] {
  const candidates: RepoCandidate[] = [];
  const seen = new Set<string>();

  for (const item of executorHistory) {
    for (const artifact of item.artifacts) {
      if (!artifact.path) {
        continue;
      }
      const text = safeReadTextFile(artifact.path);
      const repos = parseRepoCandidatesFromText(text, artifact.path);
      for (const repo of repos) {
        const key = repo.html_url;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push(repo);
      }
    }

    for (const repo of parseRepoCandidatesFromText(item.raw_result, "raw_result")) {
      const key = repo.html_url;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push(repo);
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || b.stargazers_count - a.stargazers_count)
    .slice(0, 8);
}

function getGroundedCandidateCount(executorHistory: ExecutorOutput[]): number {
  return extractScoredCandidates(executorHistory).length;
}

function hasSufficientEvidenceForRoute(executorHistory: ExecutorOutput[], routePolicy: RoutePolicy): boolean {
  if (routePolicy.requireArtifactReadback && !hasUsefulArtifactRead(executorHistory)) {
    return false;
  }
  if (routePolicy.requireNonEmptyArtifact && !hasNonEmptyCommandArtifact(executorHistory)) {
    return false;
  }
  if (routePolicy.minGroundedCandidates > 0 && getGroundedCandidateCount(executorHistory) < routePolicy.minGroundedCandidates) {
    return false;
  }
  return true;
}

function isFetchAccessError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return /\b(401|403|429)\b|forbidden|unauthorized|rate limit/i.test(message);
}

function hasRecentFetchAccessFailures(executorHistory: ExecutorOutput[]): boolean {
  const recent = executorHistory.slice(-3);
  if (recent.length === 0) {
    return false;
  }
  let fetchFailureCount = 0;
  for (const item of recent) {
    const lastTool = item.tool_calls_made.at(-1)?.tool;
    if (lastTool === "url_fetch" && isFetchAccessError(item.error)) {
      fetchFailureCount++;
    }
  }
  return fetchFailureCount >= 2;
}

function hasUsableResearchArtifacts(executorHistory: ExecutorOutput[]): boolean {
  return executorHistory.some((item) =>
    item.artifacts.some((artifact) =>
      Boolean(artifact.path)
      && artifact.content_preview.trim().length > 0
      && (artifact.type === "file" || artifact.type === "json")
    )
  );
}

function hasReadableFetchedEvidence(executorHistory: ExecutorOutput[]): boolean {
  return executorHistory.some((item) =>
    item.source === "native_tool"
    && item.artifacts.some((artifact) =>
      typeof artifact.path === "string"
      && artifact.path.includes("command-results")
      && artifact.content_preview.trim().length > 0
      && artifact.content_preview !== "(no output)"
    )
  );
}

async function runExecutorConversation(
  config: OrchestratorConfig,
  request: PlannerOutput["executor_request"],
  allowedTools: typeof TOOL_DEFINITIONS,
  stepNumber: number,
  logger?: RunLogger,
  options?: RunOptions,
): Promise<{ response: Awaited<ReturnType<typeof runChatCompletionDetailed>>; executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }>; artifacts: ExecutorOutput["artifacts"]; lastSummary: string; lastRawResult: string; lastError?: string; ok: boolean }> {
  const messages = buildExecutorMessages(config, request);
  const artifacts: ExecutorOutput["artifacts"] = [];
  const executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const executedCallKeys = new Set<string>();
  let lastSummary = "";
  let lastRawResult = "";
  let lastError: string | undefined;
  let ok = true;

  for (let toolRound = 0; toolRound <= config.policy.maxToolRetries; toolRound++) {
    assertNotCancelled(options);
    const executorResponse = await runChatCompletionDetailed(config.executor, messages, allowedTools, options);
    emitReasoningTrace("executor", stepNumber, executorResponse.reasoning, logger);
    logger?.log("executor.response.raw", {
      step: stepNumber,
      tool_round: toolRound,
      content: executorResponse.content,
      reasoning: executorResponse.reasoning,
      tool_calls: executorResponse.toolCalls,
      raw: executorResponse.raw,
    });

    if (executorResponse.toolCalls.length === 0) {
      const parsed = parseExecutorOutput(executorResponse.content || executorResponse.reasoning || "");
      const declaredCalls = parsed.tool_calls_made
        .filter((call) => isNonEmptyString(call.tool))
        .map((call) => ({
          tool: call.tool,
          arguments: isRecord(call.arguments) ? call.arguments : {},
        }))
        .filter((call) => !executedCallKeys.has(`${call.tool}:${JSON.stringify(call.arguments)}`));

      if (declaredCalls.length > 0) {
        logger?.log("executor.declared_tool_calls_fallback", {
          step: stepNumber,
          tool_round: toolRound,
          count: declaredCalls.length,
          tools: declaredCalls.map((call) => call.tool),
        });
        const fallbackResult = await executeDeclaredToolCallsFallback(
          declaredCalls,
          request,
          stepNumber,
          logger,
          options,
        );
        return {
          response: executorResponse,
          executedCalls: fallbackResult.executedCalls,
          artifacts: fallbackResult.artifacts,
          lastSummary: fallbackResult.lastSummary,
          lastRawResult: fallbackResult.lastRawResult,
          lastError: fallbackResult.lastError,
          ok: fallbackResult.ok,
        };
      }

      return {
        response: executorResponse,
        executedCalls,
        artifacts,
        lastSummary,
        lastRawResult,
        lastError,
        ok,
      };
    }

    messages.push({
      role: "assistant",
      content: executorResponse.content || "",
      tool_calls: executorResponse.toolCalls.map((call) => ({
        id: call.id || call.name,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    });

    for (const nativeCall of executorResponse.toolCalls) {
      const argumentsObject = tryParseToolArguments(nativeCall.arguments);

      const call = { tool: nativeCall.name, arguments: argumentsObject };
      executedCalls.push(call);
      executedCallKeys.add(`${call.tool}:${JSON.stringify(call.arguments)}`);

      if (!request?.allowed_tools.includes(call.tool)) {
        logger?.log("tool.blocked", {
          step: stepNumber,
          tool: call.tool,
          arguments: call.arguments,
          reason: "Tool not allowed for this step",
        });
        return {
          response: executorResponse,
          executedCalls,
          artifacts,
          lastSummary: `Executor requested disallowed tool ${call.tool}`,
          lastRawResult,
          lastError: `Tool ${call.tool} is not allowed for this step`,
          ok: false,
        };
      }

      logger?.log("tool.execution.started", {
        step: stepNumber,
        tool: call.tool,
        arguments: call.arguments,
      });
      options?.onEvent?.({
        type: "workflow.tool.start",
        step: stepNumber,
        data: { tool: call.tool, arguments: call.arguments },
      });
      const result = await executeTool(call.tool, call.arguments);
      logger?.log("tool.execution.finished", {
        step: stepNumber,
        tool: call.tool,
        ok: result.ok,
        summary: result.summary,
        error: result.error,
        artifact: result.artifact,
        raw_result_preview: result.rawResult.slice(0, 500),
      });
      options?.onEvent?.({
        type: "workflow.tool.result",
        step: stepNumber,
        data: { tool: call.tool, ok: result.ok, summary: result.summary },
      });

      if (result.artifact) {
        artifacts.push(result.artifact);
      }
      lastSummary = result.summary;
      lastRawResult = result.rawResult;
      if (!result.ok) {
        ok = false;
        lastError = result.error;
      }

      messages.push({
        role: "tool",
        name: call.tool,
        tool_call_id: nativeCall.id || call.tool,
        content: JSON.stringify({
          ok: result.ok,
          summary: result.summary,
          raw_result: result.rawResult,
          artifact: result.artifact,
          error: result.error,
        }),
      });
    }

    if (!ok) {
      return {
        response: executorResponse,
        executedCalls,
        artifacts,
        lastSummary,
        lastRawResult,
        lastError,
        ok,
      };
    }
  }

  return {
    response: {
      content: "",
      reasoning: "",
      toolCalls: [],
      raw: {},
    },
    executedCalls,
    artifacts,
    lastSummary: lastSummary || "Executor reached tool round limit with partial progress.",
    lastRawResult,
    lastError: hasUsefulExecutorProgress({ executedCalls, artifacts, lastSummary, lastRawResult, ok })
      ? undefined
      : (lastError || "Executor exceeded tool round limit"),
    ok: hasUsefulExecutorProgress({ executedCalls, artifacts, lastSummary, lastRawResult, ok }),
  };
}

function finalizeExecutorResult(
  executorResponse: Awaited<ReturnType<typeof runChatCompletionDetailed>>,
  conversation: {
    executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }>;
    artifacts: ExecutorOutput["artifacts"];
    lastSummary: string;
    lastRawResult: string;
    lastError?: string;
    ok: boolean;
  },
): ExecutorOutput {
  const rawExecutorText = executorResponse.content || executorResponse.reasoning || "";
  const usedNativeToolCalls = conversation.executedCalls.length > 0;
  const usefulProgress = hasUsefulExecutorProgress(conversation);
  const parsed = parseExecutorOutput(rawExecutorText);
  const parsedSummary = parsed.summary.trim();
  const parsedRawResult = parsed.raw_result.trim();
  const conversationSummary = conversation.lastSummary.trim();
  const parsedAddsSynthesis = parsedSummary.length > 0
    && parsedSummary !== conversationSummary
    && !/^Command (succeeded|failed|exited)\b/i.test(parsedSummary)
    && !/^Listed \d+ entries\b/i.test(parsedSummary)
    && !/^Read file\b/i.test(parsedSummary);
  const isFormatError = parsed.summary === "AI 返回的格式异常，请重试或更换模型"
    || parsed.error?.startsWith("Unable to parse executor output as JSON");
  const modelReturnedStructuredJson = !isFormatError;
  const honorModelTerminalAssessment = usedNativeToolCalls
    && modelReturnedStructuredJson
    && (parsed.status === "failed" || parsed.status === "blocked");
  const declaredToolCallsWithoutExecution = !usedNativeToolCalls && parsed.tool_calls_made.length > 0;

  const summary = honorModelTerminalAssessment
    ? parsed.summary
    : usedNativeToolCalls && parsedAddsSynthesis
      ? parsed.summary
    : usedNativeToolCalls
      ? (conversation.lastSummary || parsed.summary)
    : !isFormatError
      ? parsed.summary
      : (conversation.lastSummary || parsed.summary);
  const rawResult = honorModelTerminalAssessment
    ? (parsed.raw_result || conversation.lastRawResult || JSON.stringify(executorResponse.raw))
    : usedNativeToolCalls && parsedAddsSynthesis
      ? (parsedRawResult || conversation.lastRawResult || JSON.stringify(executorResponse.raw))
    : usedNativeToolCalls
      ? (conversation.lastRawResult || JSON.stringify(executorResponse.raw))
    : parsed.raw_result && parsed.raw_result !== (executorResponse.content || executorResponse.reasoning || "")
      ? parsed.raw_result
      : (parsed.raw_result || conversation.lastRawResult || JSON.stringify(executorResponse.raw));
  const error = honorModelTerminalAssessment
    ? (parsed.error || conversation.lastError)
    : usedNativeToolCalls
      ? conversation.lastError
    : (parsed.error || conversation.lastError);

  const status = !conversation.ok
    ? "failed"
    : declaredToolCallsWithoutExecution
      ? "blocked"
      : honorModelTerminalAssessment
        ? parsed.status
      : usedNativeToolCalls && conversation.ok
        ? (conversation.lastError ? "partial_success" : "success")
        : parsed.status === "success" && !usedNativeToolCalls
          ? "blocked"
        : parsed.status;

  return {
    status,
    summary,
    tool_calls_made: usedNativeToolCalls ? conversation.executedCalls : [],
    artifacts: usedNativeToolCalls ? conversation.artifacts : [],
    raw_result: rawResult,
    error: declaredToolCallsWithoutExecution
      ? "Executor declared tool calls without actually executing any native tools."
      : parsed.status === "success" && !usedNativeToolCalls
        ? "Executor self-declared success without native tool execution."
        : error,
    source: usedNativeToolCalls ? "native_tool" : "model_text",
    display_summary: getExecutorDisplaySummary({
      summary,
      raw_result: rawResult,
      error: declaredToolCallsWithoutExecution
        ? "Executor declared tool calls without actually executing any native tools."
        : parsed.status === "success" && !usedNativeToolCalls
          ? "Executor self-declared success without native tool execution."
          : error,
    }),
  };
}

function buildCandidateRankingText(executorHistory: ExecutorOutput[]): string {
  const ranked = extractScoredCandidates(executorHistory);
  if (ranked.length === 0) {
    return "none";
  }

  return ranked.map((repo, index) => {
    const reasons = repo.reasons.length > 0 ? repo.reasons.join(", ") : "no strong matching signal";
    const concerns = repo.concerns.length > 0 ? repo.concerns.join(", ") : "none";
    return `${index + 1}. ${repo.name} | label=${repo.label} | score=${repo.score} | stars=${repo.stargazers_count} | url=${repo.html_url} | reasons=${reasons} | concerns=${concerns}`;
  }).join("\n");
}

function getResearchRankingArtifactPath(logger?: RunLogger): string | undefined {
  if (!logger) {
    return undefined;
  }
  return resolve(RUNTIME_ROOT, "command-results", `${logger.runId}-ranking.json`);
}

function persistRankingArtifact(executorHistory: ExecutorOutput[], logger?: RunLogger): string | undefined {
  const path = getResearchRankingArtifactPath(logger);
  if (!path) {
    return undefined;
  }
  const ranked = extractScoredCandidates(executorHistory);
  safeWriteTextFile(path, JSON.stringify(ranked, null, 2));
  logger?.log("ranking.artifact.updated", {
    path,
    candidate_count: ranked.length,
  });
  return path;
}

export function hasNonEmptyCommandArtifact(executorHistory: ExecutorOutput[]): boolean {
  return executorHistory.some((item) =>
    item.source === "native_tool"
    && item.artifacts.some((artifact) =>
      !!artifact.path
      && artifact.path.includes("command-results")
      && artifact.content_preview.trim().length > 0
      && artifact.content_preview !== "(no output)"
    )
  );
}

export function hasUsefulArtifactRead(history: ExecutorOutput[]): boolean {
  return history.some((item) =>
    item.source === "native_tool"
    && item.tool_calls_made.some((call) => call.tool === "read_file")
    && item.status === "success"
  );
}

export function hasSuccessfulWrite(history: ExecutorOutput[]): boolean {
  return history.some((item) =>
    item.source === "native_tool"
    && item.status === "success"
    && item.tool_calls_made.some((call) => call.tool === "write_file")
  );
}

function hasSuccessfulWriteToPath(history: ExecutorOutput[], requestedPath: string | undefined): boolean {
  if (!requestedPath) {
    return hasSuccessfulWrite(history);
  }

  const normalizedRequested = normalizePathForComparison(resolve(requestedPath));
  return history.some((item) =>
    item.source === "native_tool"
    && item.status === "success"
    && item.tool_calls_made.some((call) =>
      call.tool === "write_file"
      && typeof call.arguments.path === "string"
      && normalizePathForComparison(resolve(String(call.arguments.path))) === normalizedRequested)
  );
}

function buildRequiredWriteExecutorRequest(targetPath: string, finalAnswer?: string): PlannerExecutorRequest {
  const answerHint = isNonEmptyString(finalAnswer)
    ? `Base the markdown content on this finalized summary if it is helpful: ${finalAnswer.trim()}`
    : "Base the markdown content on the strongest evidence already gathered in recent artifacts.";

  return {
    instruction: `Write the requested deliverable to ${targetPath}. First inspect the most relevant recent local artifacts if needed, then call write_file with the complete final markdown content. ${answerHint} Return a concise confirmation that includes the exact written path.`,
    allowed_tools: ["list_files", "read_file", "write_file"],
    expected_output: `A markdown file written successfully to ${targetPath}, plus a brief confirmation of the exact path.`,
  };
}

function checkGoalAchieved(history: ExecutorOutput[], routePolicy: RoutePolicy): { achieved: boolean; answer?: string } {
  if (history.length === 0) return { achieved: false };
  if (routePolicy.type === "file_ops" || routePolicy.type === "code") {
    const lastStep = history[history.length - 1];
    if (lastStep?.source === "native_tool"
      && lastStep.status === "success"
      && lastStep.tool_calls_made.some((call) => call.tool === "write_file")) {
      return { achieved: true, answer: lastStep.summary || "File operation completed successfully." };
    }
  }
  return { achieved: false };
}

function finalizeRunTaskResult(params: {
  goal: string;
  status: "completed" | "failed" | "blocked";
  output: string;
  verified: boolean;
  executorHistory: ExecutorOutput[];
  options?: RunOptions;
}): RunTaskResult {
  const contract = buildSingleTaskContract({
    jobId: params.options?.jobId,
    planId: params.options?.planId,
    taskRunId: params.options?.taskRunId,
    goal: params.goal,
    status: params.status,
    verified: params.verified,
    output: params.output,
    executorHistory: params.executorHistory,
  });
  return {
    status: params.status,
    output: params.output,
    verified: params.verified,
    executorHistory: params.executorHistory,
    job: contract.job,
    plan: contract.plan,
    taskRuns: contract.taskRuns,
    artifacts: contract.artifacts,
  };
}

export async function runTask(
  config: OrchestratorConfig,
  taskPrompt: string,
  routePolicy: RoutePolicy,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<RunTaskResult> {
  const complexity = assessTaskComplexity(taskPrompt, routePolicy.type, routePolicy);
  logger?.log("orchestrator.task_complexity", {
    task_type: routePolicy.type,
    execution_mode: complexity.mode,
    complexity_score: complexity.score,
    reasons: complexity.reasons,
  });
  options?.onEvent?.({
    type: "workflow.complexity.assessed",
    data: {
      task_type: routePolicy.type,
      execution_mode: complexity.mode,
      complexity_score: complexity.score,
      reasons: complexity.reasons,
    },
  });

  if (complexity.mode === "direct") {
    const directResult = await runDirectTask(config, taskPrompt, routePolicy, logger, deps, options);
    if (directResult.status === "completed") {
      return directResult;
    }
    logger?.log("orchestrator.direct.fallback", {
      reason: directResult.output,
      task_type: routePolicy.type,
    });
  }

  const runtimeDeps = mergeRuntimeDeps(deps);
  const executorHistory: ExecutorOutput[] = [];
  const loopDetector = new LoopDetector();
  const requestedOutputPath = extractRequestedOutputPath(taskPrompt);
  let replanCount = 0;
  let degradedRetryWarningEmitted = false;

  for (let step = 0; step < config.policy.maxSteps; step++) {
    assertNotCancelled(options);
    const planner = await runtimeDeps.runPlannerStep(config, taskPrompt, executorHistory, replanCount, routePolicy, step + 1, logger, runtimeDeps, options);

    if (planner.workflow_plan && shouldExecuteWorkflowPlan(planner.workflow_plan)) {
      logger?.log("workflow.plan.execute", {
        step: step + 1,
        workflow_id: planner.workflow_plan.id,
        task_count: planner.workflow_plan.tasks.length,
      });
      return await runWorkflowPlan(
        config,
        taskPrompt,
        planner.workflow_plan,
        routePolicy,
        logger,
        runtimeDeps,
        options,
      );
    }

    if (planner.status === "final" && requestedOutputPath && !hasSuccessfulWriteToPath(executorHistory, requestedOutputPath)) {
      logger?.log("planner.protocol_violation", {
        step: step + 1,
        reason: "final_without_required_file_write",
        requested_output_path: requestedOutputPath,
        parsed: planner,
      });
      planner.status = "need_executor";
      planner.audit = {
        verdict: "retry",
        notes: `Protocol corrected: the task requested a local output file at ${requestedOutputPath}, but no successful write_file call created it.`,
      };
      planner.executor_request = buildRequiredWriteExecutorRequest(requestedOutputPath, planner.final_answer);
      planner.final_answer = undefined;
    }

    if (planner.status === "final" || planner.status === "clarify") {
      return finalizeRunTaskResult({
        goal: taskPrompt,
        status: "completed",
        output: planner.final_answer ?? planner.reasoning_summary ?? "",
        verified: true,
        executorHistory,
        options,
      });
    }

    if (!planner.executor_request) {
      return finalizeRunTaskResult({
        goal: taskPrompt,
        status: "failed",
        output: "Planner did not provide executor request.",
        verified: false,
        executorHistory,
        options,
      });
    }

    const currentRequestKey = normalizeRequestKey(planner.executor_request);
    const loopResult = loopDetector.check(executorHistory, currentRequestKey);
    if (loopResult.detected) {
      return finalizeRunTaskResult({
        goal: taskPrompt,
        status: "blocked",
        output: `Loop detected: ${loopResult.message}`,
        verified: false,
        executorHistory,
        options,
      });
    }

    assertNotCancelled(options);
    const executorResult = await runtimeDeps.runExecutorStep(config, planner, step + 1, logger, runtimeDeps, options);
    executorHistory.push(executorResult);

    const goalCheck = requestedOutputPath
      ? {
          achieved: hasSuccessfulWriteToPath(executorHistory, requestedOutputPath),
          answer: executorHistory.at(-1)?.summary || `File written successfully to ${requestedOutputPath}.`,
        }
      : checkGoalAchieved(executorHistory, routePolicy);
    if (goalCheck.achieved) {
      return finalizeRunTaskResult({
        goal: taskPrompt,
        status: "completed",
        output: goalCheck.answer ?? "",
        verified: true,
        executorHistory,
        options,
      });
    }

    const postExecLoop = loopDetector.check(executorHistory);
    if (postExecLoop.detected && postExecLoop.type !== "repeated_request") {
      return finalizeRunTaskResult({
        goal: taskPrompt,
        status: "blocked",
        output: `Loop detected: ${postExecLoop.message}`,
        verified: false,
        executorHistory,
        options,
      });
    }

    if (planner.audit.verdict === "retry") {
      replanCount++;
      if (replanCount > config.policy.maxReplans) {
        replanCount = config.policy.maxReplans;
        if (!degradedRetryWarningEmitted) {
          degradedRetryWarningEmitted = true;
          logger?.log("orchestrator.degraded", { step: step + 1, reason: "max_replans_reached" });
        }
      }
    } else if (planner.audit.verdict === "approved" || planner.audit.verdict === "not_applicable") {
      replanCount = 0;
    }
  }

  return finalizeRunTaskResult({
    goal: taskPrompt,
    status: "blocked",
    output: "Max steps reached.",
    verified: false,
    executorHistory,
    options,
  });
}

async function runPlannerStep(
  config: OrchestratorConfig,
  userGoal: string,
  executorHistory: ExecutorOutput[],
  replanCount: number,
  routePolicy: RoutePolicy,
  stepNumber: number,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<PlannerOutput> {
  const runtimeDeps = mergeRuntimeDeps(deps);
  assertNotCancelled(options);
  const rankingArtifactPath = routePolicy.enableRanking ? persistRankingArtifact(executorHistory, logger) : undefined;
  const candidateRankingText = routePolicy.enableRanking ? buildCandidateRankingText(executorHistory) : undefined;
  const plannerMessages = buildPlannerMessages(config, userGoal, executorHistory, replanCount, routePolicy, candidateRankingText);

  logger?.log("planner.request", { step: stepNumber, replan_count: replanCount });
  options?.onEvent?.({ type: "workflow.step.start", step: stepNumber, data: { replan_count: replanCount } });

  let plannerRaw: string;
  try {
    const plannerResponse = await runtimeDeps.runChatCompletionDetailed(config.planner, plannerMessages, undefined, options);
    emitReasoningTrace("planner", stepNumber, plannerResponse.reasoning, logger);
    plannerRaw = plannerResponse.content || plannerResponse.reasoning || "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlannerUnavailableError(`Planner request failed: ${message}`, error instanceof Error ? error : undefined);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson<Record<string, unknown>>(plannerRaw);
  } catch (parseError) {
    logger?.log("planner.parse_error", {
      step: stepNumber,
      raw_preview: plannerRaw.slice(0, 500),
      error: parseError instanceof Error ? parseError.message : String(parseError),
    });
    return {
      goal: userGoal,
      status: "need_executor",
      reasoning_summary: "Planner output was not valid JSON. Retrying.",
      next_step: "Retry with clearer instructions.",
      audit: { verdict: "retry", notes: `Planner output could not be parsed as JSON: ${parseError instanceof Error ? parseError.message.slice(0, 100) : "unknown error"}` },
      executor_request: executorHistory.length > 0
        ? { instruction: "Repeat the last successful tool operation to confirm the result.", allowed_tools: ["read_file", "list_files"], expected_output: "Confirmation of the previous result." }
        : undefined,
    };
  }
  const planner = parsePlannerOutputRecord(userGoal, parsed, executorHistory.length > 0);

  // Protocol: final with executor_request but no answer
  if (planner.status === "final" && planner.executor_request && !isNonEmptyString(planner.final_answer)) {
    planner.status = "need_executor";
    planner.audit = { verdict: "retry", notes: "Protocol corrected: final with executor_request and no answer." };
  }

  // R4+: Research finalization requires actual evidence, even if a markdown file was already written.
  if (planner.status === "final" && routePolicy.requireEvidenceBeforeFinal) {
    const researchAccessDegraded = hasRecentFetchAccessFailures(executorHistory)
      && hasReadableFetchedEvidence(executorHistory)
      && hasUsableResearchArtifacts(executorHistory);

    if (researchAccessDegraded && !hasUsefulArtifactRead(executorHistory)) {
      planner.status = "need_executor";
      planner.audit = {
        verdict: "retry",
        notes: "Research degraded: recent url_fetch calls were blocked by source-site access limits, so continue from the artifacts already collected instead of expanding search.",
      };
      planner.executor_request = {
        instruction: rankingArtifactPath
          ? `Read the ranking artifact at ${rankingArtifactPath} plus the strongest already-fetched evidence artifact, then write a constrained evidence summary. Clearly separate confirmed facts from gaps caused by 403/401/429 source restrictions. Do not call web_search or url_fetch again unless a local artifact is unreadable.`
          : "Read the strongest already-fetched evidence artifact under runtime/command-results, then write a constrained evidence summary. Clearly separate confirmed facts from gaps caused by 403/401/429 source restrictions. Do not call web_search or url_fetch again unless a local artifact is unreadable.",
        allowed_tools: rankingArtifactPath ? ["read_file"] : ["list_files", "read_file"],
        expected_output: "Grounded summary based only on the existing readable artifacts, with explicit evidence gaps.",
      };
      planner.final_answer = undefined;
    } else if (!researchAccessDegraded
      && routePolicy.requireArtifactReadback
      && !hasUsefulArtifactRead(executorHistory)
      && executorHistory.some((i) => i.artifacts.some((a) => a.path?.includes("command-results")))) {
      planner.status = "need_executor";
      planner.audit = { verdict: "retry", notes: "Research: search results exist but were not read back." };
      planner.executor_request = {
        instruction: "Read the most relevant recent file under runtime/command-results and extract the strongest candidates.",
        allowed_tools: ["list_files", "read_file"],
        expected_output: "Structured summary of candidates.",
      };
      planner.final_answer = undefined;
    } else if (!researchAccessDegraded && !hasSufficientEvidenceForRoute(executorHistory, routePolicy)) {
      planner.status = "need_executor";
      planner.audit = {
        verdict: "retry",
        notes: `Insufficient evidence for final answer. Candidate count=${getGroundedCandidateCount(executorHistory)}; required minimum=${routePolicy.minGroundedCandidates}; readback=${routePolicy.requireArtifactReadback}; non_empty_artifact=${routePolicy.requireNonEmptyArtifact}.`,
      };
      planner.executor_request = {
        instruction: rankingArtifactPath
          ? `Read the ranking artifact at ${rankingArtifactPath} and the strongest non-empty search result artifact, then produce a grounded ranking with inclusion reasons and concerns. Do not invent projects that are not present in the evidence.`
          : "List and read the strongest non-empty search result artifact, then produce a grounded ranking with inclusion reasons and concerns. Do not invent projects that are not present in the evidence.",
        allowed_tools: rankingArtifactPath ? ["read_file"] : ["list_files", "read_file"],
        expected_output: `Structured evidence summary with at least ${routePolicy.minGroundedCandidates} grounded candidate projects when candidate comparison applies, each including full_name, url, stars when available, inclusion reason, and concerns.`,
      };
      planner.final_answer = undefined;
    }
  }

  const normalizedPlanner = applyWorkflowMilestoneAFallback(planner, stepNumber, logger, options);

  logger?.log("planner.response.parsed", { step: stepNumber, parsed: normalizedPlanner });
  options?.onEvent?.({
    type: "workflow.planner.decision",
    step: stepNumber,
    data: {
      status: normalizedPlanner.status,
      reasoning_summary: normalizedPlanner.reasoning_summary,
      next_step: normalizedPlanner.next_step,
      decision_text: getPlannerDecisionText(normalizedPlanner),
      verdict: normalizedPlanner.audit?.verdict,
      workflow_id: normalizedPlanner.workflow_plan?.id,
      workflow_task_count: normalizedPlanner.workflow_plan?.tasks.length ?? 0,
    },
  });
  return normalizedPlanner;
}

function formatReasoningTrace(label: string, stepNumber: number, reasoning: string): string {
  const summary = previewText(reasoning, 240);
  return `[thinking][${label}][step ${stepNumber}] ${summary}`;
}

function emitReasoningTrace(label: string, stepNumber: number, reasoning: string, logger?: RunLogger): void {
  if (!reasoning.trim()) {
    return;
  }
  const trace = formatReasoningTrace(label, stepNumber, reasoning);
  logger?.log(`${label}.reasoning`, {
    step: stepNumber,
    summary: previewText(reasoning, 240),
    raw: reasoning,
  });
  console.error(trace);
}

function formatToolCalls(item: ExecutorOutput): string {
  if (item.tool_calls_made.length === 0) return "none";
  return item.tool_calls_made.map((call) => call.tool).join(", ");
}

function formatArtifacts(item: ExecutorOutput, previewLimit: number): string {
  if (item.artifacts.length === 0) return "none";
  return item.artifacts.map((artifact) => {
    const target = artifact.path ? `${artifact.type}:${artifact.path}` : artifact.type;
    const preview = artifact.content_preview ? ` preview=${previewText(artifact.content_preview, previewLimit)}` : "";
    return `${target}${preview}`;
  }).join(" | ");
}

function buildPlannerHistoryText(config: OrchestratorConfig, executorHistory: ExecutorOutput[]): string {
  if (executorHistory.length === 0) {
    return "none";
  }

  const maxEntries = Math.max(1, config.policy.plannerHistoryMaxEntries);
  const previewLimit = Math.max(60, config.policy.plannerHistoryPreviewChars);
  const visibleHistory = executorHistory.slice(-maxEntries);
  const hiddenCount = executorHistory.length - visibleHistory.length;
  const historyLines = visibleHistory.map((item, idx) => {
    const actualStep = hiddenCount + idx + 1;
    const rawPreview = item.raw_result ? ` result=${compressJsonOutput(item.raw_result, previewLimit)}` : "";
    const errorText = item.error ? ` error=${previewText(item.error, previewLimit)}` : "";
    return `step ${actualStep}: status=${item.status}; summary=${item.summary}; tools=${formatToolCalls(item)}; artifacts=${formatArtifacts(item, previewLimit)};${rawPreview}${errorText}`;
  });

  if (hiddenCount > 0) {
    historyLines.unshift(`... ${hiddenCount} earlier worker steps omitted to save planner tokens ...`);
  }

  // Detect poor search quality in recent steps
  const recentSearchSteps = visibleHistory.filter((item) =>
    item.tool_calls_made.some((tc) => tc.tool === "web_search")
  );
  const poorSearchCount = recentSearchSteps.filter((item) => {
    const previews = item.artifacts.map((a) => a.content_preview ?? "").join(" ");
    return previews.length < 150 || /(登录|注册|首页|navigation|sign\s*in)/i.test(previews);
  }).length;
  if (recentSearchSteps.length >= 2 && poorSearchCount >= 2) {
    historyLines.push("⚠ SEARCH QUALITY WARNING: The last search results appear irrelevant or low-quality. Consider changing the search query significantly, or skip search and use your own knowledge instead.");
  }

  return historyLines.join("\n");
}

function buildPlannerMessages(
  config: OrchestratorConfig,
  userGoal: string,
  executorHistory: ExecutorOutput[],
  replanCount: number,
  routePolicy: RoutePolicy,
  rankingText?: string,
  currentStep?: number
): ChatMessage[] {
  const historyText = buildPlannerHistoryText(config, executorHistory);
  const remainingReplans = Math.max(0, config.policy.maxReplans - replanCount);
  const routePolicyBlock = [
    `Route type: ${routePolicy.type}`,
    `Route instruction: ${routePolicy.plannerInstruction}`,
    `Preferred tools: ${routePolicy.preferredTools.join(", ") || "none"}`,
    `Artifact priority: ${routePolicy.artifactPriority.join(" -> ") || "none"}`,
    `Completion checklist: ${routePolicy.completionChecklist.join(" | ") || "none"}`,
    `Fallback rule: ${routePolicy.fallbackRule}`,
  ].join("\n");

  // Build step budget guidance
  let stepBudgetBlock = "";
  if (currentStep !== undefined) {
    const remaining = config.policy.maxSteps - currentStep - 1;
    let budgetGuidance = "";

    if (remaining <= 0) {
      budgetGuidance = "⚠️ CRITICAL: This is your FINAL step. You MUST return status 'final' with an answer based on current evidence. Do not request more executor steps.";
    } else if (remaining === 1) {
      budgetGuidance = "⚠️ WARNING: Only 1 step remaining after this. If you request executor work now, you will have ONE more chance to finalize. Consider returning 'final' now if you have sufficient evidence.";
    } else if (remaining <= 2) {
      budgetGuidance = `⚠️ NOTICE: Only ${remaining} steps remaining. Start consolidating findings. Avoid exploring new directions unless critical.`;
    } else {
      budgetGuidance = `${remaining} steps remaining. Continue normal planning.`;
    }

    stepBudgetBlock = `\nStep budget: ${currentStep + 1}/${config.policy.maxSteps} (${remaining} remaining)\n${budgetGuidance}`;
  }

  return [
    { role: "system", content: `${PLANNER_PROMPT}\n\nRuntime profile:\n${runtimeProfileText(config)}\n\nAvailable tools:\n${toolListText()}` },
    {
      role: "user",
      content: `Goal: ${userGoal}\n${routePolicyBlock}\nReplan budget remaining: ${remainingReplans}${stepBudgetBlock}\nWorker history:\n${historyText}${routePolicy.enableRanking ? `\n\nDeterministic candidate ranking:\n${rankingText || "none"}` : ""}`,
    },
  ];
}

function buildExecutorMessages(config: OrchestratorConfig, request: PlannerOutput["executor_request"]): ChatMessage[] {
  return [
    { role: "system", content: `${EXECUTOR_PROMPT}\n\nRuntime profile:\n${runtimeProfileText(config)}\n\nAvailable tools:\n${toolListText()}` },
    {
      role: "user",
      content: JSON.stringify(request),
    },
  ];
}

function tryParseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function executeDeclaredToolCallsFallback(
  declaredCalls: Array<{ tool: string; arguments: Record<string, unknown> }>,
  request: PlannerOutput["executor_request"],
  stepNumber: number,
  logger?: RunLogger,
  options?: RunOptions,
): Promise<{
  executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  artifacts: ExecutorOutput["artifacts"];
  lastSummary: string;
  lastRawResult: string;
  lastError?: string;
  ok: boolean;
}> {
  const artifacts: ExecutorOutput["artifacts"] = [];
  const executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  let lastSummary = "";
  let lastRawResult = "";
  let lastError: string | undefined;
  let ok = true;

  for (const call of declaredCalls) {
    if (!request?.allowed_tools.includes(call.tool)) {
      logger?.log("tool.blocked", {
        step: stepNumber,
        tool: call.tool,
        arguments: call.arguments,
        reason: "Declared tool not allowed for this step",
      });
      return {
        executedCalls,
        artifacts,
        lastSummary: `Executor declared disallowed tool ${call.tool}`,
        lastRawResult,
        lastError: `Tool ${call.tool} is not allowed for this step`,
        ok: false,
      };
    }

    logger?.log("tool.execution.started", {
      step: stepNumber,
      tool: call.tool,
      arguments: call.arguments,
      source: "declared_tool_calls_fallback",
    });
    options?.onEvent?.({
      type: "workflow.tool.start",
      step: stepNumber,
      data: { tool: call.tool, arguments: call.arguments },
    });
    const result = await executeTool(call.tool, call.arguments);
    logger?.log("tool.execution.finished", {
      step: stepNumber,
      tool: call.tool,
      ok: result.ok,
      summary: result.summary,
      error: result.error,
      artifact: result.artifact,
      raw_result_preview: result.rawResult.slice(0, 500),
      source: "declared_tool_calls_fallback",
    });
    options?.onEvent?.({
      type: "workflow.tool.result",
      step: stepNumber,
      data: { tool: call.tool, ok: result.ok, summary: result.summary },
    });

    executedCalls.push(call);
    if (result.artifact) {
      artifacts.push(result.artifact);
    }
    lastSummary = result.summary;
    lastRawResult = result.rawResult;
    if (!result.ok) {
      ok = false;
      lastError = result.error;
      break;
    }
  }

  return {
    executedCalls,
    artifacts,
    lastSummary,
    lastRawResult,
    lastError,
    ok,
  };
}

export async function runExecutorStep(
  config: OrchestratorConfig,
  planner: PlannerOutput,
  stepNumber: number,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<ExecutorOutput> {
  void deps;
  assertNotCancelled(options);
  if (!planner.executor_request) {
    throw new Error("Planner requested executor but did not provide executor_request");
  }

  const executorRequest = applyExecutorToolPolicy(planner.executor_request, config.executorToolPolicy);
  const scopedPlanner: PlannerOutput = {
    ...planner,
    executor_request: executorRequest,
  };
  const allowedTools = TOOL_DEFINITIONS.filter((tool) => executorRequest.allowed_tools.includes(tool.name));
  logger?.log("executor.request", {
    step: stepNumber,
    request: executorRequest,
    allowed_tools: allowedTools.map((tool) => tool.name),
    tool_policy_applied: !!config.executorToolPolicy,
  });
  options?.onEvent?.({
    type: "workflow.executor.start",
    step: stepNumber,
    data: {
      instruction: executorRequest.instruction,
      allowed_tools: allowedTools.map((tool) => tool.name),
    },
  });
  const conversation = await runExecutorConversation(
    config,
    scopedPlanner.executor_request,
    allowedTools,
    stepNumber,
    logger,
    options,
  );
  const executorResponse = conversation.response;
  const finalized = finalizeExecutorResult(executorResponse, conversation);
  logger?.log("executor.response.parsed", {
    step: stepNumber,
    parsed: finalized,
    used_native_tool_calls: finalized.source === "native_tool",
    declared_tool_calls_without_execution: finalized.error === "Executor declared tool calls without actually executing any native tools.",
  });
  options?.onEvent?.({
    type: "workflow.executor.result",
    step: stepNumber,
    data: {
      status: finalized.status,
      summary: finalized.summary,
      display_summary: getExecutorDisplaySummary(finalized),
      artifact_count: finalized.artifacts.length,
    },
  });
  return finalized;
}

export async function runOrchestrator(
  config: OrchestratorConfig,
  userGoal: string,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<PlannerOutput> {
  const runtimeDeps = mergeRuntimeDeps(deps);
  assertNotCancelled(options);
  const executorHistory: ExecutorOutput[] = [];
  const requestedOutputPath = extractRequestedOutputPath(userGoal);
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);
  const taskType = detectTaskType(userGoal, routing);
  const routePolicy = getRoutePolicy(taskType, routing);
  let replanCount = 0;
  let degradedRetryWarningEmitted = false;
  const loopDetector = new LoopDetector();
  let stepState: OrchestratorStepState = "pending";
  const allowedTransitions: Record<OrchestratorStepState, OrchestratorStepState[]> = {
    pending: ["planning"],
    planning: ["executing", "finalized", "blocked"],
    executing: ["planning", "finalized", "failed"],
    completed: [],
    failed: [],
    blocked: [],
    finalized: [],
  };
  function transitionTo(next: OrchestratorStepState, reason: string): void {
    const allowed = allowedTransitions[stepState];
    if (!allowed.includes(next)) {
      logger?.log("orchestrator.state_machine.violation", {
        from: stepState,
        to: next,
        reason,
        step: executorHistory.length + 1,
      });
    }
    logger?.log("orchestrator.state_transition", { from: stepState, to: next, reason });
    stepState = next;
  }
  logger?.log("orchestrator.config", {
    planner_model: config.planner.model,
    executor_model: config.executor.model,
    max_steps: config.policy.maxSteps,
    max_replans: config.policy.maxReplans,
    planner_history_max_entries: config.policy.plannerHistoryMaxEntries,
    planner_history_preview_chars: config.policy.plannerHistoryPreviewChars,
    max_repeated_executor_requests: config.policy.maxRepeatedExecutorRequests,
    task_type: taskType,
    route_policy: routePolicy,
  });

  for (let step = 0; step < config.policy.maxSteps; step++) {
    transitionTo("planning", `step ${step + 1} starting`);
    const rankingArtifactPath = routePolicy.enableRanking ? persistRankingArtifact(executorHistory, logger) : undefined;
    const candidateRankingText = routePolicy.enableRanking ? buildCandidateRankingText(executorHistory) : undefined;
    const plannerMessages = buildPlannerMessages(config, userGoal, executorHistory, replanCount, routePolicy, candidateRankingText, step);
    logger?.log("planner.request", {
      step: step + 1,
      messages: plannerMessages,
      executor_history: executorHistory,
      replan_count: replanCount,
      ranking_artifact_path: rankingArtifactPath,
      task_type: taskType,
      route_policy: routePolicy.type,
    });
    let plannerRaw: string;
    try {
      const plannerResponse = await runtimeDeps.runChatCompletionDetailed(config.planner, plannerMessages, undefined, options);
      emitReasoningTrace("planner", step + 1, plannerResponse.reasoning, logger);
      plannerRaw = plannerResponse.content || plannerResponse.reasoning || "";
      logger?.log("planner.response.raw", {
        step: step + 1,
        content: plannerResponse.content,
        reasoning: plannerResponse.reasoning,
        raw: plannerResponse.raw,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.log("planner.response.error", {
        step: step + 1,
        error: message,
      });
      throw new PlannerUnavailableError(`Planner request failed: ${message}`, error instanceof Error ? error : undefined);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseModelJson<Record<string, unknown>>(plannerRaw);
    } catch (parseError) {
      logger?.log("planner.parse_error", {
        step: step + 1,
        raw_preview: plannerRaw.slice(0, 500),
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      // Treat parse failure as retry — the planner will be called again
      continue;
    }
    const planner = parsePlannerOutputRecord(userGoal, parsed, executorHistory.length > 0);

    if (planner.status === "final" && planner.executor_request && !isNonEmptyString(planner.final_answer)) {
      logger?.log("planner.protocol_violation", {
        step: step + 1,
        reason: "final_with_executor_request_and_no_answer",
        parsed: planner,
      });
      planner.status = "need_executor";
      planner.audit = {
        verdict: planner.audit.verdict === "approved" ? "retry" : planner.audit.verdict,
        notes: planner.audit.notes
          ? `${planner.audit.notes} Protocol corrected: planner returned final with executor_request and no answer.`
          : "Protocol corrected: planner returned final with executor_request and no answer.",
      };
    }

    if (
      planner.status === "final"
      && requestedOutputPath
      && !hasSuccessfulWriteToPath(executorHistory, requestedOutputPath)
    ) {
      logger?.log("planner.protocol_violation", {
        step: step + 1,
        reason: "final_without_required_file_write",
        requested_output_path: requestedOutputPath,
        parsed: planner,
      });
      planner.status = "need_executor";
      planner.audit = {
        verdict: "retry",
        notes: `Protocol corrected: the task requested a local output file at ${requestedOutputPath}, but no successful write_file call created it.`,
      };
      planner.executor_request = buildRequiredWriteExecutorRequest(requestedOutputPath, planner.final_answer);
      planner.final_answer = undefined;
    }

    if (
      planner.status === "final"
      && routePolicy.requireEvidenceBeforeFinal
      && !hasSuccessfulWrite(executorHistory)
      && !hasUsefulArtifactRead(executorHistory)
      && executorHistory.some((item) => item.artifacts.some((artifact) => artifact.path?.includes("command-results")))
    ) {
      logger?.log("planner.protocol_violation", {
        step: step + 1,
        reason: "final_before_reading_search_artifact",
        parsed: planner,
      });
      planner.status = "need_executor";
      planner.audit = {
        verdict: "retry",
        notes: "Protocol corrected: search results exist in artifacts but were not read back for synthesis before final answer.",
      };
      planner.executor_request = {
        instruction: "Read the most relevant recent file under runtime/command-results and extract the strongest candidate projects with reasons they match the user goal.",
        allowed_tools: ["list_files", "read_file"],
        expected_output: "Structured summary of the recent search artifact with candidate projects, relevance reasons, and ranking evidence.",
      };
      planner.final_answer = undefined;
    }

    if (
      planner.status === "final"
      && routePolicy.requireEvidenceBeforeFinal
      && !hasSuccessfulWrite(executorHistory)
      && (!hasUsefulArtifactRead(executorHistory) || !hasNonEmptyCommandArtifact(executorHistory))
    ) {
      logger?.log("planner.protocol_violation", {
        step: step + 1,
        reason: "final_without_research_evidence",
        parsed: planner,
      });
      planner.status = "need_executor";
      planner.audit = {
        verdict: "retry",
        notes: "Protocol corrected: research final answer requires at least one non-empty search artifact and one successful artifact read.",
      };
      planner.executor_request = {
        instruction: rankingArtifactPath
          ? `Read the ranking artifact at ${rankingArtifactPath} and the most relevant recent search result artifact under runtime/command-results, then produce a structured evidence summary for final answering.`
          : "List files under runtime/command-results and read the most relevant recent non-empty search result artifact, then produce a structured evidence summary for final answering.",
        allowed_tools: rankingArtifactPath ? ["read_file"] : ["list_files", "read_file"],
        expected_output: "Structured evidence summary derived from recent non-empty research artifacts.",
      };
      planner.final_answer = undefined;
    }

    const normalizedPlanner = applyWorkflowMilestoneAFallback(planner, step + 1, logger, options);

    const currentRequestKey = normalizedPlanner.status === "need_executor" && normalizedPlanner.executor_request
      ? normalizeRequestKey(normalizedPlanner.executor_request)
      : undefined;

    logger?.log("planner.response.parsed", {
      step: step + 1,
      parsed: normalizedPlanner,
    });
    options?.onEvent?.({
      type: "workflow.planner.decision",
      step: step + 1,
      data: {
        status: normalizedPlanner.status,
        reasoning_summary: normalizedPlanner.reasoning_summary,
        next_step: normalizedPlanner.next_step,
        decision_text: getPlannerDecisionText(normalizedPlanner),
        verdict: normalizedPlanner.audit?.verdict,
        workflow_id: normalizedPlanner.workflow_plan?.id,
        workflow_task_count: normalizedPlanner.workflow_plan?.tasks.length ?? 0,
      },
    });

    // Unified loop detection
    const loopResult = loopDetector.check(executorHistory, currentRequestKey);
    if (loopResult.detected) {
      transitionTo("blocked", loopResult.type ?? "unknown_loop");
      const result: PlannerOutput = {
        goal: userGoal,
        status: "final",
        reasoning_summary: `Stopped: ${loopResult.message}`,
        next_step: "",
        audit: { verdict: "blocked", notes: loopResult.message ?? "Loop detected." },
        final_answer: `The orchestrator stopped: ${loopResult.message} Recent artifacts: ${summarizeRecentArtifacts(executorHistory)}.`,
      };
      logger?.log("orchestrator.loop_detected", { step: step + 1, type: loopResult.type, result });
      return result;
    }

    if (normalizedPlanner.status === "final" || normalizedPlanner.status === "clarify") {
      transitionTo("finalized", `planner returned ${normalizedPlanner.status}`);
      logger?.log("orchestrator.finished", {
        step: step + 1,
        result: normalizedPlanner,
      });
      return normalizedPlanner;
    }

    if (normalizedPlanner.audit.verdict === "retry") {
      replanCount += 1;
      if (replanCount > config.policy.maxReplans) {
        replanCount = config.policy.maxReplans;
        if (!degradedRetryWarningEmitted) {
          degradedRetryWarningEmitted = true;
          logger?.log("orchestrator.degraded", {
            step: step + 1,
            reason: "max_replans_reached",
            message: "Manager requested too many worker retries; continuing in degraded mode.",
          });
        }
      }
    } else if (normalizedPlanner.audit.verdict === "approved" || normalizedPlanner.audit.verdict === "not_applicable") {
      replanCount = 0;
    }

    transitionTo("executing", `executor step ${step + 1}`);
    assertNotCancelled(options);
    const executorResult = await runtimeDeps.runExecutorStep(config, normalizedPlanner, step + 1, logger, runtimeDeps, options);
    executorHistory.push(executorResult);
    logger?.log("executor.step.finished", {
      step: step + 1,
      result: executorResult,
      replan_count: replanCount,
    });

    // P0-2: Goal achieved short-circuit — if write_file succeeded, stop immediately
    const goalCheck = requestedOutputPath
      ? {
          achieved: hasSuccessfulWriteToPath(executorHistory, requestedOutputPath),
          answer: executorHistory.at(-1)?.summary || `File written successfully to ${requestedOutputPath}.`,
        }
      : checkGoalAchieved(executorHistory, routePolicy);
    if (goalCheck.achieved) {
      transitionTo("finalized", "goal_achieved");
      const result: PlannerOutput = {
        goal: userGoal,
        status: "final",
        reasoning_summary: "Goal achieved: verified native tool result satisfies the objective.",
        next_step: "",
        audit: { verdict: "approved", notes: "Write tool succeeded with verified native execution." },
        final_answer: goalCheck.answer,
      };
      logger?.log("orchestrator.goal_achieved", { step: step + 1, result });
      return result;
    }

    // P0-4 + P2-2: Unified loop detection after executor step
    const postExecLoop = loopDetector.check(executorHistory);
    if (postExecLoop.detected && postExecLoop.type !== "repeated_request") {
      transitionTo("blocked", postExecLoop.type ?? "unknown_loop");
      const result: PlannerOutput = {
        goal: userGoal,
        status: "final",
        reasoning_summary: `Stopped: ${postExecLoop.message}`,
        next_step: "",
        audit: { verdict: "blocked", notes: postExecLoop.message ?? "Loop detected after executor step." },
        final_answer: `The orchestrator stopped: ${postExecLoop.message}`,
      };
      logger?.log("orchestrator.loop_detected_post_exec", { step: step + 1, type: postExecLoop.type, result });
      return result;
    }
  }

  transitionTo("finalized", "max_steps_reached");

  // Extract partial results from executor history
  const artifacts = executorHistory.flatMap(h => h.artifacts || []);
  const hasEvidence = artifacts.length > 0;
  const failurePatterns = {
    http403: executorHistory.filter(h => h.error?.includes("403")).length,
    searchPoor: executorHistory.filter(h => h.tool_calls_made?.some(t => t.tool === "web_search")).length,
    missingFiles: executorHistory.filter(h => h.error?.includes("ENOENT") || h.error?.includes("no such file")).length,
  };

  let suggestions = "";
  if (failurePatterns.http403 > 2) {
    suggestions += "\n- Many websites blocked access (HTTP 403). Consider using alternative data sources or APIs.";
  }
  if (failurePatterns.searchPoor > 3 && artifacts.length < 3) {
    suggestions += "\n- Web search results were limited. Try: (1) more specific search terms, (2) alternative search tools, or (3) direct URL fetching.";
  }
  if (failurePatterns.missingFiles > 2) {
    suggestions += "\n- Multiple file access errors. Verify file paths and naming conventions.";
  }

  const result: PlannerOutput = {
    goal: userGoal,
    status: "final",
    reasoning_summary: hasEvidence
      ? "Reached step limit. Summarizing available evidence."
      : "Reached step limit without sufficient evidence.",
    next_step: "",
    audit: {
      verdict: hasEvidence ? "approved" : "blocked",
      notes: hasEvidence
        ? "Task incomplete but partial results available"
        : "Task incomplete, insufficient evidence gathered",
    },
    final_answer: hasEvidence
      ? `Task reached the ${config.policy.maxSteps}-step limit. Based on available evidence:\n\n${artifacts.slice(0, 3).map((a, i) => `${i + 1}. ${a.type} artifact: ${a.path}\n   Preview: ${previewText(a.content_preview || "", 200)}`).join("\n\n")}\n\nNote: This is a partial result due to step budget constraints.${suggestions ? `\n\nSuggestions for better results:${suggestions}` : ""}`
      : `The task could not be completed within the ${config.policy.maxSteps}-step budget. No sufficient evidence was gathered.${suggestions ? `\n\nSuggestions:${suggestions}` : ""}`,
  };
  logger?.log("orchestrator.finished", {
    step: config.policy.maxSteps,
    result,
    has_evidence: hasEvidence,
    artifact_count: artifacts.length,
    failure_patterns: failurePatterns,
  });
  return result;
}

export const __testables = {
  assessTaskComplexity,
  runPlannerStep,
  finalizeExecutorResult,
  buildPlannerMessages,
  buildExecutorMessages,
};
