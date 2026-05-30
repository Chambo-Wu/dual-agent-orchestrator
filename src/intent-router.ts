import type { RunLogger } from "./logger.js";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { parseModelJson } from "./json.js";
import type { IntentRouteMetadata, OrchestratorConfig, RunOptions } from "./types.js";

export interface IntentRouteResult extends IntentRouteMetadata {}

export interface IntentRouterInput {
  config: OrchestratorConfig;
  userGoal: string;
  logger?: RunLogger;
  options?: RunOptions;
  allowPlannerFallback?: boolean;
}

const GOAL_PATTERN = /(^|\s)\/goal\b|\bgoal mode\b|目标模式|多轮任务|多阶段任务|持续推进|自动推进/iu;
const CODING_PATTERN = /\b(code|coding|debug|fix|bug|refactor|implement|edit|patch|test|build|compile|repo|repository|typescript|javascript|python|java|csharp|golang|rust|file|module|function|class|api|endpoint)\b|\.ts\b|\.tsx\b|\.js\b|\.jsx\b|\.py\b|\.java\b|\.cs\b|src[\\/]|test[\\/]/iu;
const DIRECT_LOOKUP_PATTERN = /\b(weather|forecast|temperature|time|timezone|utc|clock|stock|ticker|quote|price|market cap|crypto|exchange rate|score|scores|schedule|standings|who is|what is|when is)\b|天气|时间|时区|汇率|价格|比分|赛程/iu;
const RESEARCH_PATTERN = /\b(research|compare|comparison|survey|investigate|analy[sz]e|analysis|ranking|rank|benchmark|official|source|sources|citation|citations|latest|today|current|news|release|announcement|changelog|release notes|search|lookup|find)\b|调研|研究|对比|比较|排行|排名|分析|最新|今天|当前|新闻|官方|来源|搜索|查找/iu;

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

export function detectIntentRouteHeuristics(userGoal: string): IntentRouteResult {
  const normalized = userGoal.trim();
  const words = wordCount(normalized);

  if (GOAL_PATTERN.test(normalized)) {
    return {
      kind: "goal",
      reason: "matched explicit goal-mode language",
      source: "heuristic",
    };
  }

  if (CODING_PATTERN.test(normalized)) {
    return {
      kind: "coding",
      reason: "matched engineering or repository-oriented language",
      source: "heuristic",
    };
  }

  if (DIRECT_LOOKUP_PATTERN.test(normalized) && words <= 40) {
    return {
      kind: "direct_answer",
      reason: "matched a short direct lookup request",
      source: "heuristic",
    };
  }

  if (RESEARCH_PATTERN.test(normalized)) {
    return {
      kind: "research",
      reason: "matched evidence-gathering or current-information language",
      source: "heuristic",
    };
  }

  if (words <= 18) {
    return {
      kind: "direct_answer",
      reason: "defaulted short request to direct-answer flow",
      source: "heuristic",
    };
  }

  if (/\b(plan|design|proposal|architecture)\b|方案|设计|架构/iu.test(normalized)) {
    return {
      kind: "goal",
      reason: "matched planning-oriented request language",
      source: "heuristic",
    };
  }

  return {
    kind: "research",
    reason: "defaulted longer open-ended request to research flow",
    source: "heuristic",
  };
}

async function classifyIntentWithPlanner(input: IntentRouterInput): Promise<IntentRouteResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are an intent router. Return only valid JSON with fields: kind, reason. Allowed kind values: direct_answer, research, goal, coding.",
    },
    {
      role: "user",
      content: `Classify this request for execution routing:\n${input.userGoal}`,
    },
  ];
  const response = await runChatCompletionDetailed(input.config.planner, messages, undefined, input.options);
  const parsed = parseModelJson<Record<string, unknown>>(response.content || response.reasoning || "{}");
  const kind = parsed.kind;
  if (kind === "direct_answer" || kind === "research" || kind === "goal" || kind === "coding") {
    return {
      kind,
      reason: typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "planner classified the route",
      source: "planner",
    };
  }
  throw new Error("Planner returned an invalid intent route.");
}

export async function detectIntentRoute(input: IntentRouterInput): Promise<IntentRouteResult> {
  const heuristic = detectIntentRouteHeuristics(input.userGoal);
  input.logger?.log("intent.route.heuristic", {
    goal_preview: input.userGoal.slice(0, 240),
    route: heuristic,
  });

  if (!input.allowPlannerFallback) {
    return heuristic;
  }

  const isAmbiguous = heuristic.kind === "research" && heuristic.reason.startsWith("defaulted");
  if (!isAmbiguous) {
    return heuristic;
  }

  try {
    const plannerRoute = await classifyIntentWithPlanner(input);
    input.logger?.log("intent.route.planner", {
      goal_preview: input.userGoal.slice(0, 240),
      route: plannerRoute,
    });
    return plannerRoute;
  } catch (error) {
    input.logger?.log("intent.route.planner_failed", {
      goal_preview: input.userGoal.slice(0, 240),
      error: error instanceof Error ? error.message : String(error),
      fallback_route: heuristic,
    });
    return heuristic;
  }
}
