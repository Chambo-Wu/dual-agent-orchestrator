import { EXECUTOR_PROMPT, PLANNER_PROMPT } from "./prompts.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { parseModelJson } from "./json.js";
import { parseExecutorOutput } from "./executor-adapter.js";
import type { RunLogger } from "./logger.js";
import { executeTool, TOOL_DEFINITIONS } from "./tools.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { RUNTIME_ROOT } from "./paths.js";
import type { ExecutorOutput, OrchestratorConfig, PlannerExecutorRequest, PlannerOutput, RoutePolicy, TaskType } from "./types.js";

export class PlannerUnavailableError extends Error {
  readonly causeError?: Error;

  constructor(message: string, causeError?: Error) {
    super(message);
    this.name = "PlannerUnavailableError";
    this.causeError = causeError;
  }
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

function previewText(input: string, limit = 400): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function shouldReturnAfterSuccessfulTool(tool: string): boolean {
  return tool === "write_file" || tool === "read_file" || tool === "list_files";
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

function summarizeRecentArtifacts(executorHistory: ExecutorOutput[]): string {
  const artifacts = executorHistory
    .flatMap((item) => item.artifacts)
    .filter((artifact) => artifact.path)
    .slice(-6)
    .map((artifact) => `${artifact.type}:${artifact.path}`);
  return artifacts.length > 0 ? artifacts.join("; ") : "none";
}

function matchesGoal(goal: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(goal);
}

function detectTaskType(userGoal: string, routing: RoutePolicy[]): TaskType {
  const goal = userGoal.toLowerCase();
  for (const route of routing) {
    if (route.matchers.some((matcher) => matchesGoal(goal, matcher))) {
      return route.type;
    }
  }
  return "general";
}

function getRoutePolicy(taskType: TaskType, routing: RoutePolicy[]): RoutePolicy {
  return routing.find((route) => route.type === taskType) || routing[routing.length - 1];
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

async function runExecutorConversation(
  config: OrchestratorConfig,
  request: PlannerOutput["executor_request"],
  allowedTools: typeof TOOL_DEFINITIONS,
  stepNumber: number,
  logger?: RunLogger
): Promise<{ response: Awaited<ReturnType<typeof runChatCompletionDetailed>>; executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }>; artifacts: ExecutorOutput["artifacts"]; lastSummary: string; lastRawResult: string; lastError?: string; ok: boolean }> {
  const messages = buildExecutorMessages(request);
  const artifacts: ExecutorOutput["artifacts"] = [];
  const executedCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  let lastSummary = "";
  let lastRawResult = "";
  let lastError: string | undefined;
  let ok = true;

  for (let toolRound = 0; toolRound <= config.policy.maxToolRetries; toolRound++) {
    const executorResponse = await runChatCompletionDetailed(config.executor, messages, allowedTools);
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
      let argumentsObject: Record<string, unknown> = {};
      try {
        argumentsObject = JSON.parse(nativeCall.arguments) as Record<string, unknown>;
      } catch {
        argumentsObject = {};
      }

      const call = { tool: nativeCall.name, arguments: argumentsObject };
      executedCalls.push(call);

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
      const result = executeTool(call.tool, call.arguments);
      logger?.log("tool.execution.finished", {
        step: stepNumber,
        tool: call.tool,
        ok: result.ok,
        summary: result.summary,
        error: result.error,
        artifact: result.artifact,
        raw_result_preview: result.rawResult.slice(0, 500),
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

      if (result.ok && shouldReturnAfterSuccessfulTool(call.tool)) {
        return {
          response: executorResponse,
          executedCalls,
          artifacts,
          lastSummary: result.summary,
          lastRawResult: result.rawResult,
          lastError,
          ok,
        };
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
    lastSummary: lastSummary || "Executor exceeded tool round limit.",
    lastRawResult,
    lastError: lastError || "Executor exceeded tool round limit",
    ok: false,
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

function hasNonEmptyCommandArtifact(executorHistory: ExecutorOutput[]): boolean {
  return executorHistory.some((item) =>
    item.artifacts.some((artifact) =>
      !!artifact.path
      && artifact.path.includes("command-results")
      && artifact.content_preview.trim().length > 0
      && artifact.content_preview !== "(no output)"
    )
  );
}

function hasUsefulArtifactRead(history: ExecutorOutput[]): boolean {
  return history.some((item) =>
    item.tool_calls_made.some((call) => call.tool === "read_file") &&
    item.status === "success"
  );
}

function hasSuccessfulWrite(history: ExecutorOutput[]): boolean {
  return history.some((item) =>
    item.status === "success"
    && item.tool_calls_made.some((call) => call.tool === "write_file")
  );
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
    const rawPreview = item.raw_result ? ` result=${previewText(item.raw_result, previewLimit)}` : "";
    const errorText = item.error ? ` error=${previewText(item.error, previewLimit)}` : "";
    return `step ${actualStep}: status=${item.status}; summary=${item.summary}; tools=${formatToolCalls(item)}; artifacts=${formatArtifacts(item, previewLimit)};${rawPreview}${errorText}`;
  });

  if (hiddenCount > 0) {
    historyLines.unshift(`... ${hiddenCount} earlier worker steps omitted to save planner tokens ...`);
  }

  return historyLines.join("\n");
}

function buildPlannerMessages(
  config: OrchestratorConfig,
  userGoal: string,
  executorHistory: ExecutorOutput[],
  replanCount: number,
  routePolicy: RoutePolicy,
  rankingText?: string
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

  return [
    { role: "system", content: `${PLANNER_PROMPT}\n\nAvailable tools:\n${toolListText()}` },
    {
      role: "user",
      content: `Goal: ${userGoal}\n${routePolicyBlock}\nReplan budget remaining: ${remainingReplans}\nWorker history:\n${historyText}${routePolicy.enableRanking ? `\n\nDeterministic candidate ranking:\n${rankingText || "none"}` : ""}`,
    },
  ];
}

function buildExecutorMessages(request: PlannerOutput["executor_request"]): ChatMessage[] {
  return [
    { role: "system", content: `${EXECUTOR_PROMPT}\n\nAvailable tools:\n${toolListText()}` },
    {
      role: "user",
      content: JSON.stringify(request),
    },
  ];
}

async function runExecutorStep(
  config: OrchestratorConfig,
  planner: PlannerOutput,
  stepNumber: number,
  logger?: RunLogger
): Promise<ExecutorOutput> {
  if (!planner.executor_request) {
    throw new Error("Planner requested executor but did not provide executor_request");
  }

  const allowedTools = TOOL_DEFINITIONS.filter((tool) => planner.executor_request?.allowed_tools.includes(tool.name));
  logger?.log("executor.request", {
    step: stepNumber,
    request: planner.executor_request,
    allowed_tools: allowedTools.map((tool) => tool.name),
  });
  const conversation = await runExecutorConversation(
    config,
    planner.executor_request,
    allowedTools,
    stepNumber,
    logger
  );
  const executorResponse = conversation.response;
  const parsed = parseExecutorOutput(executorResponse.content || executorResponse.reasoning || "");
  logger?.log("executor.response.parsed", {
    step: stepNumber,
    parsed,
    used_native_tool_calls: conversation.executedCalls.length > 0,
  });

  const toolCallsMade = parsed.tool_calls_made.length > 0
    ? parsed.tool_calls_made
    : conversation.executedCalls;
  const artifacts = parsed.artifacts.length > 0
    ? [...conversation.artifacts, ...parsed.artifacts]
    : conversation.artifacts;
  const summary = parsed.summary !== "Executor did not return valid JSON."
    ? parsed.summary
    : (conversation.lastSummary || parsed.summary);
  const rawResult = parsed.raw_result && parsed.raw_result !== (executorResponse.content || executorResponse.reasoning || "")
    ? parsed.raw_result
    : (parsed.raw_result || conversation.lastRawResult || JSON.stringify(executorResponse.raw));
  const error = parsed.error || conversation.lastError;
  const status = !conversation.ok
    ? "failed"
    : (toolCallsMade.length > 0 && parsed.status === "failed" && parsed.error === "Unable to parse executor output as JSON")
      ? "success"
      : parsed.status;

  return {
    status,
    summary,
    tool_calls_made: toolCallsMade,
    artifacts,
    raw_result: rawResult,
    error,
  };
}

export async function runOrchestrator(
  config: OrchestratorConfig,
  userGoal: string,
  logger?: RunLogger
): Promise<PlannerOutput> {
  const executorHistory: ExecutorOutput[] = [];
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);
  const taskType = detectTaskType(userGoal, routing);
  const routePolicy = getRoutePolicy(taskType, routing);
  let replanCount = 0;
  let degradedRetryWarningEmitted = false;
  let lastExecutorRequestKey = "";
  let repeatedExecutorRequestCount = 0;
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
    const rankingArtifactPath = routePolicy.enableRanking ? persistRankingArtifact(executorHistory, logger) : undefined;
    const candidateRankingText = routePolicy.enableRanking ? buildCandidateRankingText(executorHistory) : undefined;
    const plannerMessages = buildPlannerMessages(config, userGoal, executorHistory, replanCount, routePolicy, candidateRankingText);
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
      const plannerResponse = await runChatCompletionDetailed(config.planner, plannerMessages);
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
    const parsed = parseModelJson<Record<string, unknown>>(plannerRaw);
    const parsedAudit = isRecord(parsed.audit) ? parsed.audit : undefined;
    const parsedExecutorRequest = parsePlannerExecutorRequest(parsed.executor_request);
    const planner: PlannerOutput = {
      goal: userGoal,
      status: parsed.status === "need_executor" || parsed.status === "final" || parsed.status === "clarify"
        ? parsed.status
        : "clarify",
      reasoning_summary: typeof parsed.step === "string" ? parsed.step : "",
      next_step: typeof parsed.step === "string" ? parsed.step : "",
      audit: parsedAudit
        ? {
            verdict: parsedAudit.verdict === "approved"
              || parsedAudit.verdict === "retry"
              || parsedAudit.verdict === "blocked"
              || parsedAudit.verdict === "not_applicable"
              ? parsedAudit.verdict
              : "not_applicable",
            notes: typeof parsedAudit.notes === "string" ? parsedAudit.notes : "",
          }
        : {
            verdict: executorHistory.length > 0 ? "approved" : "not_applicable",
            notes: "",
          },
      executor_request: parsedExecutorRequest,
      final_answer: typeof parsed.answer === "string" ? parsed.answer : undefined,
      clarification_question: typeof parsed.question === "string" ? parsed.question : undefined,
    };

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

    if (planner.status === "need_executor" && planner.executor_request) {
      const requestKey = normalizeRequestKey(planner.executor_request);
      if (requestKey && requestKey === lastExecutorRequestKey) {
        repeatedExecutorRequestCount += 1;
      } else {
        repeatedExecutorRequestCount = 0;
        lastExecutorRequestKey = requestKey;
      }
    } else {
      repeatedExecutorRequestCount = 0;
      lastExecutorRequestKey = "";
    }

    logger?.log("planner.response.parsed", {
      step: step + 1,
      parsed: planner,
      repeated_executor_request_count: repeatedExecutorRequestCount,
    });

    if (planner.status === "need_executor" && repeatedExecutorRequestCount > config.policy.maxRepeatedExecutorRequests) {
      const result: PlannerOutput = {
        goal: userGoal,
        status: "final",
        reasoning_summary: "Stopped because the manager kept issuing repeated executor requests.",
        next_step: "",
        audit: {
          verdict: "blocked",
          notes: `Repeated executor request detected. Recent artifacts: ${summarizeRecentArtifacts(executorHistory)}`,
        },
        final_answer: `The orchestrator detected a repeated execution loop. Recent artifact files are: ${summarizeRecentArtifacts(executorHistory)}.`,
      };
      logger?.log("orchestrator.loop_detected", {
        step: step + 1,
        repeated_executor_request_count: repeatedExecutorRequestCount,
        request: planner.executor_request,
        result,
      });
      return result;
    }

    if (planner.status === "final" || planner.status === "clarify") {
      logger?.log("orchestrator.finished", {
        step: step + 1,
        result: planner,
      });
      return planner;
    }

    if (planner.audit.verdict === "retry") {
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
    } else if (planner.audit.verdict === "approved" || planner.audit.verdict === "not_applicable") {
      replanCount = 0;
    }

    const executorResult = await runExecutorStep(config, planner, step + 1, logger);
    executorHistory.push(executorResult);
    logger?.log("executor.step.finished", {
      step: step + 1,
      result: executorResult,
      replan_count: replanCount,
    });
  }

  const result: PlannerOutput = {
    goal: userGoal,
    status: "final",
    reasoning_summary: "Stopped because max_steps was reached.",
    next_step: "",
    audit: {
      verdict: executorHistory.length > 0 ? "approved" : "not_applicable",
      notes: "",
    },
    final_answer: "The orchestrator stopped after reaching the maximum number of steps.",
  };
  logger?.log("orchestrator.finished", {
    step: config.policy.maxSteps,
    result,
  });
  return result;
}
