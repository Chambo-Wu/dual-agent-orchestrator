import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { installSkillById } from "./skill-installer.js";
import { getInstalledSkill, getSkillManifest } from "./skill-registry.js";
import type { OrchestratorConfig, PlannerOutput, WorkflowPlan, WorkflowTaskSpec } from "./types.js";
import type { SkillInstallResult, SkillManifest } from "./skill-types.js";
import { parseWorkflowPlan } from "./workflow-plan.js";

export interface SkillInstallEventData {
  type: "system.skill_install_attempted" | "system.skill_install_completed" | "system.skill_install_blocked" | "system.skill_install_failed";
  data: Record<string, unknown>;
}

export interface ApplySkillWorkflowResult {
  planner: PlannerOutput;
  installEvents: SkillInstallEventData[];
}

function templatePath(templateId: string): string {
  return resolve(PROJECT_ROOT, "skills", "templates", `${templateId}.json`);
}

function readTemplatePlan(templateId: string): WorkflowPlan | undefined {
  try {
    const raw = readFileSync(templatePath(templateId), "utf8");
    return parseWorkflowPlan(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function patchWorkflowInstructions(plan: WorkflowPlan, goal: string): WorkflowPlan {
  return {
    ...plan,
    summary: `${plan.summary} Goal: ${goal}`,
    tasks: plan.tasks.map((task) => ({
      ...task,
      instruction: `${task.instruction}\n\nUser goal:\n${goal}`,
    })),
  };
}

function buildAllowedToolSet(manifest: SkillManifest): Set<string> {
  return new Set([
    ...manifest.requiredTools,
    ...(manifest.optionalTools ?? []),
  ]);
}

function compileSkillTask(task: WorkflowTaskSpec, manifest: SkillManifest): WorkflowTaskSpec {
  const allowedToolSet = buildAllowedToolSet(manifest);
  const narrowedTools = task.allowed_tools.filter((tool) => allowedToolSet.has(tool));
  return {
    ...task,
    allowed_tools: narrowedTools.length > 0 ? narrowedTools : task.allowed_tools,
    instruction: `${task.instruction}\n\nSkill context:\n- Skill: ${manifest.id}\n- Skill title: ${manifest.title}\n- Skill intent: follow the ${manifest.title} workflow and preserve only relevant evidence for this discovery task.`,
  };
}

function buildSkillVerificationTask(plan: WorkflowPlan, manifest: SkillManifest): WorkflowTaskSpec | undefined {
  if (!manifest.verification || plan.tasks.some((task) => task.kind === "verify")) {
    return undefined;
  }
  const requiredTaskIds = plan.tasks.filter((task) => task.required !== false).map((task) => task.id);
  const minimumArtifactCount = manifest.verification.requiredArtifacts?.length ?? 1;
  const requiredArtifacts = manifest.verification.requiredArtifacts?.join(", ") ?? "relevant discovery artifacts";
  const successSignal = manifest.verification.successSignal ?? "verification requirements satisfied";
  return {
    id: `${plan.id}__skill_verify`,
    title: `Verify ${manifest.title}`,
    kind: "verify",
    role: "verifier",
    instruction: `Verify that the workflow outputs satisfy skill ${manifest.id}. Required artifacts: ${requiredArtifacts}. Success signal: ${successSignal}.`,
    allowed_tools: [],
    depends_on: requiredTaskIds,
    required: true,
    constraints: {
      verifier_profile: "artifact",
      minimum_artifact_count: minimumArtifactCount,
    },
  };
}

function compileSkillWorkflow(plan: WorkflowPlan, manifest: SkillManifest): WorkflowPlan {
  const compiledTasks = plan.tasks.map((task) => compileSkillTask(task, manifest));
  const verificationTask = buildSkillVerificationTask({ ...plan, tasks: compiledTasks }, manifest);
  return {
    ...plan,
    strategy: `${plan.strategy}+skill:${manifest.id}`,
    summary: `${plan.summary} Skill: ${manifest.id}.`,
    tasks: verificationTask ? [...compiledTasks, verificationTask] : compiledTasks,
  };
}

function resolveSkillTemplateId(config: OrchestratorConfig, skillId: string): string | undefined {
  const manifest = getSkillManifest(skillId, config);
  if (!manifest || manifest.execution.strategy !== "workflow_template") {
    return undefined;
  }
  return manifest.execution.templateId;
}

export function materializeSkillWorkflow(
  config: OrchestratorConfig,
  goal: string,
  planner: PlannerOutput,
): WorkflowPlan | undefined {
  const skillId = planner.skill?.skill_id;
  if (!skillId || planner.workflow_plan) {
    return planner.workflow_plan;
  }
  const manifest = getSkillManifest(skillId, config);
  const templateId = resolveSkillTemplateId(config, skillId);
  if (!templateId || !manifest) {
    return undefined;
  }
  const plan = readTemplatePlan(templateId);
  return plan ? compileSkillWorkflow(patchWorkflowInstructions(plan, goal), manifest) : undefined;
}

function buildInstallEventSummary(result: SkillInstallResult): SkillInstallEventData[] {
  const baseData: Record<string, unknown> = {
    skill_id: result.skillId,
    install_status: result.status,
    install_reason: result.reason,
    install_source: result.source ?? null,
    install_location: result.location ?? result.record?.location ?? null,
  };
  return [
    {
      type: "system.skill_install_attempted",
      data: baseData,
    },
    {
      type: result.status === "installed" || result.status === "already_installed"
        ? "system.skill_install_completed"
        : result.status === "blocked" || result.status === "unavailable"
          ? "system.skill_install_blocked"
          : "system.skill_install_failed",
      data: baseData,
    },
  ];
}

export function applySkillWorkflow(config: OrchestratorConfig, goal: string, planner: PlannerOutput): ApplySkillWorkflowResult {
  const skillId = planner.skill?.skill_id;
  const skillAction = planner.skill?.skill_action;
  const installEvents: SkillInstallEventData[] = [];

  if (skillId && skillAction === "install_then_use" && config.skills.enabled) {
    const installResult = installSkillById(config, skillId, { requireAutoInstallEnabled: true });
    installEvents.push(...buildInstallEventSummary(installResult));
    if (installResult.status === "blocked" || installResult.status === "failed" || installResult.status === "unavailable") {
      return {
        planner: {
          ...planner,
          audit: {
            verdict: "retry",
            notes: planner.audit.notes
              ? `${planner.audit.notes} ${installResult.reason}`
              : installResult.reason,
          },
        },
        installEvents,
      };
    }
  }

  if (skillId && skillAction === "use_installed" && config.skills.enabled && !getInstalledSkill(skillId, config)) {
    return {
      planner: {
        ...planner,
        audit: {
          verdict: "retry",
          notes: planner.audit.notes
            ? `${planner.audit.notes} Selected skill is not installed.`
            : "Selected skill is not installed.",
        },
      },
      installEvents,
    };
  }

  const workflowPlan = materializeSkillWorkflow(config, goal, planner);
  if (!workflowPlan) {
    return {
      planner,
      installEvents,
    };
  }
  return {
    planner: {
      ...planner,
      status: "workflow",
      workflow_plan: workflowPlan,
      audit: {
        verdict: planner.audit.verdict === "blocked" ? "blocked" : "approved",
        notes: planner.audit.notes
          ? `${planner.audit.notes} Skill workflow template applied.`
          : "Skill workflow template applied.",
      },
    },
    installEvents,
  };
}
