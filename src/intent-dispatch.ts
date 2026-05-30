import type { RunLogger } from "./logger.js";
import { runDirectAnswerIntent } from "./direct-answer.js";
import { runCodingIntent } from "./coding-runtime.js";
import { runResearchIntent } from "./research-runtime.js";
import { getInstalledSkill, matchSkills } from "./skill-registry.js";
import type { IntentExecutionPlan, IntentRouteMetadata, OrchestratorConfig, RunOptions, RunTaskResult, SelectedSkillSummary } from "./types.js";
import type { RuntimeDeps } from "./runtime/deps.js";

export function shouldDispatchToTeam(intentRoute: IntentRouteMetadata): boolean {
  return intentRoute.kind === "goal";
}

function summarizeSelectedSkill(
  config: OrchestratorConfig,
  skillId: string | undefined,
): SelectedSkillSummary | undefined {
  if (!skillId) {
    return undefined;
  }
  const installed = getInstalledSkill(skillId, config);
  return {
    skill_id: skillId,
    skill_action: installed ? "use_installed" : "install_then_use",
    skill_reason: "Selected by intent skill matcher before runtime dispatch.",
    skill_install_status: installed ? "installed" : "install_required",
  };
}

export function buildIntentExecutionPlan(
  config: OrchestratorConfig,
  userGoal: string,
  intentRoute: IntentRouteMetadata,
): IntentExecutionPlan {
  if (!config.skills.enabled || intentRoute.kind === "goal" || intentRoute.kind === "direct_answer") {
    return {
      intent: intentRoute,
      candidateSkills: [],
    };
  }

  const candidateSkills = matchSkills(userGoal, intentRoute.kind);
  const selectedSkill = summarizeSelectedSkill(config, candidateSkills[0]?.skillId);
  return {
    intent: intentRoute,
    candidateSkills,
    selectedSkill,
  };
}

export async function dispatchTaskIntentRoute(
  config: OrchestratorConfig,
  userGoal: string,
  intentRoute: IntentRouteMetadata,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<RunTaskResult> {
  const intentExecutionPlan = buildIntentExecutionPlan(config, userGoal, intentRoute);
  const runtimeOptions: RunOptions = {
    ...options,
    intentExecutionPlan,
  };
  logger?.log("intent.skill_plan", {
    intent_kind: intentRoute.kind,
    candidate_skills: intentExecutionPlan.candidateSkills,
    selected_skill: intentExecutionPlan.selectedSkill ?? null,
  });
  runtimeOptions.onEvent?.({
    type: "system.skill_selected",
    data: {
      intent_kind: intentRoute.kind,
      candidate_skills: intentExecutionPlan.candidateSkills,
      selected_skill: intentExecutionPlan.selectedSkill?.skill_id ?? null,
      skill_action: intentExecutionPlan.selectedSkill?.skill_action ?? null,
      skill_install_status: intentExecutionPlan.selectedSkill?.skill_install_status ?? null,
      skill_reason: intentExecutionPlan.selectedSkill?.skill_reason ?? null,
    },
  });

  if (intentRoute.kind === "direct_answer") {
    return runDirectAnswerIntent(config, userGoal, logger, deps, runtimeOptions);
  }

  if (intentRoute.kind === "coding") {
    return runCodingIntent(config, userGoal, logger, deps, runtimeOptions);
  }

  return runResearchIntent(config, userGoal, logger, deps, runtimeOptions);
}
