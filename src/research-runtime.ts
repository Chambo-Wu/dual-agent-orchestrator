import type { RunLogger } from "./logger.js";
import { runTask, detectTaskType, getRoutePolicy } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import type { OrchestratorConfig, RoutePolicy, RunOptions, RunTaskResult, TaskType } from "./types.js";
import type { RuntimeDeps } from "./runtime/deps.js";

const RESEARCH_TASK_TYPES: TaskType[] = ["fact_research", "research", "web_search"];

function normalizeResearchTaskType(taskType: TaskType): TaskType {
  if (RESEARCH_TASK_TYPES.includes(taskType)) {
    return taskType;
  }
  return "research";
}

export function resolveResearchRoutePolicy(config: OrchestratorConfig, userGoal: string): RoutePolicy {
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);
  const detectedType = detectTaskType(userGoal, routing);
  const researchType = normalizeResearchTaskType(detectedType);
  const base = getRoutePolicy(researchType, routing);
  return {
    ...base,
    plannerInstruction: `${base.plannerInstruction} Additional research runtime contract: preserve evidence quality, prefer primary sources when possible, and do not finalize until artifact readback is complete when evidence is required.`,
    completionChecklist: [
      ...base.completionChecklist,
      "separate confirmed evidence from remaining uncertainty",
    ],
  };
}

export async function runResearchIntent(
  config: OrchestratorConfig,
  userGoal: string,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<RunTaskResult> {
  const routePolicy = resolveResearchRoutePolicy(config, userGoal);
  const selectedSkill = options?.intentExecutionPlan?.selectedSkill;
  logger?.log("intent.route.research", {
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
