import type { RunLogger } from "./logger.js";
import { runTask } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { buildSingleTaskContract } from "./workflow-contract.js";
import type { ExecutorOutput, IntentRouteMetadata, OrchestratorConfig, OrchestratorEventCallback, RoutePolicy, RunOptions, RunTaskResult } from "./types.js";
import type { RuntimeDeps } from "./runtime/deps.js";

export type CodingPhase = "understand" | "edit" | "verify" | "summarize";

const CODING_PHASE_GUIDANCE = [
  "Understand the relevant local code and constraints before editing.",
  "Prefer the smallest effective code change.",
  "Run validation or tests when feasible and report what was actually verified.",
  "Summarize the behavioral change, remaining risk, and any unverified edge cases.",
].join(" ");

function getBaseCodeRoutePolicy(config: OrchestratorConfig): RoutePolicy {
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);
  const base = routing.find((route) => route.type === "code");
  if (!base) {
    throw new Error("Code route policy is not configured.");
  }
  return base;
}

export function resolveCodingRoutePolicy(config: OrchestratorConfig): RoutePolicy {
  const base = getBaseCodeRoutePolicy(config);
  return {
    ...base,
    plannerInstruction: `${base.plannerInstruction} Additional coding runtime contract: ${CODING_PHASE_GUIDANCE}`,
    preferredTools: ["list_files", "read_file", "shell_command", "write_file", ...base.preferredTools.filter((tool) => !["list_files", "read_file", "shell_command", "write_file"].includes(tool))],
    completionChecklist: [
      "inspect the local code before editing",
      ...base.completionChecklist,
      "state what was verified versus left unverified",
    ],
  };
}

function resolveCodingPhaseRoutePolicy(config: OrchestratorConfig, phase: CodingPhase): RoutePolicy {
  const base = resolveCodingRoutePolicy(config);
  switch (phase) {
    case "understand":
      return {
        ...base,
        plannerInstruction: `${base.plannerInstruction} Current coding phase: understand. Only inspect local code, identify relevant files, symbols, and likely change points. Do not write files or claim implementation is complete in this phase.`,
        preferredTools: ["list_files", "read_file", "shell_command"],
        completionChecklist: [
          "identify the most relevant files and symbols",
          "capture constraints before editing",
          "do not modify files in this phase",
        ],
      };
    case "edit":
      return {
        ...base,
        plannerInstruction: `${base.plannerInstruction} Current coding phase: edit. Apply the smallest effective implementation change using the understanding gathered earlier.`,
      };
    case "verify":
      return {
        ...base,
        plannerInstruction: `${base.plannerInstruction} Current coding phase: verify. Prefer targeted build, test, or static validation commands. Do not broaden scope or make fresh feature edits unless verification proves the previous edit is invalid.`,
        preferredTools: ["shell_command", "read_file", "list_files"],
        completionChecklist: [
          "run the narrowest useful validation",
          "report exactly what was verified",
          "separate failed validation from unavailable validation",
        ],
      };
    case "summarize":
      return base;
  }
}

function emitCodingPhaseEvent(
  onEvent: OrchestratorEventCallback | undefined,
  type: "workflow.coding.phase_start" | "workflow.coding.phase_result",
  phase: CodingPhase,
  data: Record<string, unknown>,
): void {
  onEvent?.({
    type,
    data: {
      phase,
      ...data,
    },
  });
}

function buildPhasePrompt(userGoal: string, phase: CodingPhase, completedPhaseOutputs: readonly string[]): string {
  const prior = completedPhaseOutputs.length > 0
    ? `\nPrevious coding phase outputs:\n${completedPhaseOutputs.map((output, index) => `${index + 1}. ${output}`).join("\n")}`
    : "";

  switch (phase) {
    case "understand":
      return `${userGoal}\n\nCoding phase: understand.${prior}\nInspect the local codebase and identify the relevant files, symbols, entrypoints, and constraints before making any edits. Do not write files in this phase.`;
    case "edit":
      return `${userGoal}\n\nCoding phase: edit.${prior}\nApply the minimal effective code change based on the understanding above. Prefer precise edits over broad refactors.`;
    case "verify":
      return `${userGoal}\n\nCoding phase: verify.${prior}\nRun the narrowest useful validation commands for the recent code change. If validation cannot run, explain that clearly instead of pretending it passed.`;
    case "summarize":
      return `${userGoal}\n\nCoding phase: summarize.${prior}`;
  }
}

function summarizePhaseOutput(phase: CodingPhase, result: RunTaskResult): string {
  return `${phase}: ${result.output.trim() || result.status}`;
}

function deriveFinalStatus(results: readonly RunTaskResult[]): RunTaskResult["status"] {
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }
  if (results.some((result) => result.status === "blocked")) {
    return "blocked";
  }
  return "completed";
}

function deriveVerified(results: readonly RunTaskResult[]): boolean {
  const verifyResult = results.find((result, index) => index === 2);
  if (!verifyResult) {
    return false;
  }
  return verifyResult.status === "completed" && verifyResult.verified;
}

function buildCodingSummary(userGoal: string, results: readonly RunTaskResult[]): string {
  const understand = results[0]?.output?.trim() || "No understanding summary recorded.";
  const edit = results[1]?.output?.trim() || "No edit summary recorded.";
  const verify = results[2]?.output?.trim() || "No verification summary recorded.";
  const finalStatus = deriveFinalStatus(results);

  return [
    `Goal: ${userGoal}`,
    `Coding runtime phases completed with status: ${finalStatus}.`,
    `Understand: ${understand}`,
    `Edit: ${edit}`,
    `Verify: ${verify}`,
  ].join("\n\n");
}

export async function runCodingIntent(
  config: OrchestratorConfig,
  userGoal: string,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<RunTaskResult> {
  const selectedSkill = options?.intentExecutionPlan?.selectedSkill;
  logger?.log("intent.route.coding", {
    goal_preview: userGoal.slice(0, 240),
    route_policy: "code",
    execution_mode: "phased",
    candidate_skills: options?.intentExecutionPlan?.candidateSkills ?? [],
    selected_skill: selectedSkill ?? null,
  });

  const phases: CodingPhase[] = ["understand", "edit", "verify"];
  const phaseOutputs: string[] = [];
  const phaseResults: RunTaskResult[] = [];

  for (const phase of phases) {
    const routePolicy = resolveCodingPhaseRoutePolicy(config, phase);
    const phasePrompt = buildPhasePrompt(userGoal, phase, phaseOutputs);
    emitCodingPhaseEvent(options?.onEvent, "workflow.coding.phase_start", phase, {
      title: phase,
      route_type: routePolicy.type,
      allowed_tools: routePolicy.preferredTools,
    });
    const phaseResult = await runTask(config, phasePrompt, routePolicy, logger, deps, options);
    phaseResults.push(phaseResult);
    phaseOutputs.push(summarizePhaseOutput(phase, phaseResult));
    emitCodingPhaseEvent(options?.onEvent, "workflow.coding.phase_result", phase, {
      title: phase,
      status: phaseResult.status,
      verified: phaseResult.verified,
      output_preview: phaseResult.output.slice(0, 240),
    });
    if (phaseResult.status !== "completed") {
      break;
    }
  }

  emitCodingPhaseEvent(options?.onEvent, "workflow.coding.phase_start", "summarize", {
    title: "summarize",
  });
  const summary = buildCodingSummary(userGoal, phaseResults);
  const finalStatus = deriveFinalStatus(phaseResults);
  const verified = deriveVerified(phaseResults);
  emitCodingPhaseEvent(options?.onEvent, "workflow.coding.phase_result", "summarize", {
    title: "summarize",
    status: finalStatus,
    verified,
    output_preview: summary.slice(0, 240),
  });

  const executorHistory: ExecutorOutput[] = phaseResults.flatMap((result) => result.executorHistory);
  const contract = buildSingleTaskContract({
    jobId: options?.jobId,
    planId: options?.planId,
    taskRunId: options?.taskRunId,
    goal: userGoal,
    title: "Coding Task",
    description: userGoal,
    status: finalStatus,
    verified,
    output: summary,
    executorHistory,
    intentRoute: {
      kind: "coding",
      reason: "coding runtime selected",
      source: "heuristic",
    } satisfies IntentRouteMetadata,
    candidateSkills: options?.intentExecutionPlan?.candidateSkills,
    selectedSkill: selectedSkill,
  });

  return {
    status: finalStatus,
    output: summary,
    verified,
    executorHistory,
    job: contract.job,
    plan: contract.plan,
    taskRuns: contract.taskRuns,
    artifacts: contract.artifacts,
  };
}
