import type { RunLogger } from "./logger.js";
import { runTask, detectTaskType, getRoutePolicy } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import type { OrchestratorConfig, RoutePolicy, RunOptions, RunTaskResult, TaskType } from "./types.js";
import type { RuntimeDeps } from "./runtime/deps.js";

function normalizeDirectAnswerTaskType(taskType: TaskType): TaskType {
  if (taskType === "research" || taskType === "fact_research" || taskType === "code" || taskType === "data_analysis") {
    return "general";
  }
  return taskType;
}

export function resolveDirectAnswerRoutePolicy(config: OrchestratorConfig, userGoal: string): RoutePolicy {
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);
  const detectedType = detectTaskType(userGoal, routing);
  const directType = normalizeDirectAnswerTaskType(detectedType);
  return getRoutePolicy(directType, routing);
}

export async function runDirectAnswerIntent(
  config: OrchestratorConfig,
  userGoal: string,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<RunTaskResult> {
  const routePolicy = resolveDirectAnswerRoutePolicy(config, userGoal);
  const selectedSkill = options?.intentExecutionPlan?.selectedSkill;
  logger?.log("intent.route.direct_answer", {
    goal_preview: userGoal.slice(0, 240),
    route_policy: routePolicy.type,
    candidate_skills: options?.intentExecutionPlan?.candidateSkills ?? [],
    selected_skill: selectedSkill ?? null,
  });
  const runtimePrompt = selectedSkill?.skill_id
    ? `${userGoal}\n\nSelected skill: ${selectedSkill.skill_id}${selectedSkill.skill_reason ? `\nSkill reason: ${selectedSkill.skill_reason}` : ""}`
    : userGoal;
  return runTask(config, runtimePrompt, routePolicy, logger, deps, options);
}
