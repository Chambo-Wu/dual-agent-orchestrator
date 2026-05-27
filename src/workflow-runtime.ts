import { randomUUID } from "node:crypto";
import type { RunLogger } from "./logger.js";
import { mergeRuntimeDeps, type RuntimeDeps } from "./runtime/deps.js";
import type { ApprovalRequest, Artifact, OrchestratorConfig, PlannerOutput, RegisteredAgent, RoutePolicy, RunOptions, RunTaskResult, TaskRun, VerificationCheck, VerificationResult, WorkflowPlan, WorkflowTaskSpec } from "./types.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord, collectArtifactsFromExecutorHistory } from "./workflow-contract.js";
import { assessWorkflowExecutionSupport, validateWorkflowPlan } from "./workflow-plan.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT } from "./paths.js";
import { createModelVerifier, DEFAULT_VERIFIERS, runVerifiers, verificationPassed as verificationResultPassed, type VerificationContext, type Verifier } from "./verification.js";
import { persistApprovalRequest } from "./job-store.js";
import { readJobRecord, updateStoredJobRecord } from "./job-store.js";
import { setApprovalResolver } from "./job-runtime.js";
import { buildWorkflowGraph } from "./workflow-graph.js";
import { getExecutorDecisionText, summarizeVerification } from "./output-contract.js";

type WorkflowTaskOutcome = {
  task: WorkflowTaskSpec;
  status: TaskRun["status"];
  verified: boolean;
  output: string;
  artifacts: Artifact[];
  executorHistory: RunTaskResult["executorHistory"];
  attempts: number;
  verificationResult?: VerificationResult;
};

type WorkflowTaskOverride = {
  sourceTaskId: string;
  task: WorkflowTaskSpec;
};

type WorkflowReplanRecord = {
  supersededWorkflowId: string;
  replacementWorkflowId: string;
  failedTaskId: string;
  failedTaskTitle: string;
};

type WorkflowRuntimeState = {
  replanCount: number;
  archivedTaskRuns: TaskRun[];
  archivedArtifacts: Artifact[];
  replanHistory: WorkflowReplanRecord[];
};

type WorkflowFinishEvaluation = {
  met: boolean;
  terminal: boolean;
  status: RunTaskResult["status"];
  verified: boolean;
  summary: string;
};

function resolveFailureStatus(task: WorkflowTaskSpec, defaultStatus: Extract<TaskRun["status"], "failed" | "blocked"> = "failed"): Extract<TaskRun["status"], "failed" | "blocked" | "skipped"> {
  switch (task.retry_policy?.on_failure) {
    case "skip":
      return "skipped";
    case "fail":
    default:
      return defaultStatus;
  }
}

function areDependenciesCompleted(task: WorkflowTaskSpec, outcomes: Map<string, WorkflowTaskOutcome>): boolean {
  return task.depends_on.every((depId) => outcomes.get(depId)?.status === "completed");
}

function hasBlockingDependency(task: WorkflowTaskSpec, outcomes: Map<string, WorkflowTaskOutcome>): WorkflowTaskOutcome | undefined {
  for (const depId of task.depends_on) {
    const outcome = outcomes.get(depId);
    if (!outcome) {
      continue;
    }
    if (outcome.status === "failed" || outcome.status === "blocked") {
      return outcome;
    }
  }
  return undefined;
}

function hasSkippedDependency(task: WorkflowTaskSpec, outcomes: Map<string, WorkflowTaskOutcome>): WorkflowTaskOutcome | undefined {
  for (const depId of task.depends_on) {
    const outcome = outcomes.get(depId);
    if (outcome?.status === "skipped") {
      return outcome;
    }
  }
  return undefined;
}

function buildWorkflowTaskPrompt(goal: string, task: WorkflowTaskSpec, dependencyOutputs: string[]): string {
  const dependencySection = dependencyOutputs.length > 0
    ? `\n\nDependency outputs:\n${dependencyOutputs.map((value, index) => `${index + 1}. ${value}`).join("\n")}`
    : "";
  return `Workflow goal: ${goal}\nWorkflow task: ${task.title}\nTask kind: ${task.kind}\nInstruction: ${task.instruction}${dependencySection}`;
}

function buildSynthesisPrompt(goal: string, task: WorkflowTaskSpec, dependencyOutputs: string[]): string {
  const dependencySection = dependencyOutputs.length > 0
    ? dependencyOutputs.map((value, index) => `Dependency ${index + 1}:\n${value}`).join("\n\n")
    : "No dependency outputs were provided.";
  return `Goal: ${goal}\nWorkflow task: ${task.title}\nTask kind: synthesize\nInstruction: ${task.instruction}\n\nSynthesize the following dependency outputs into one concise, grounded result:\n\n${dependencySection}`;
}

function buildWorkflowReplanPrompt(
  goal: string,
  plan: WorkflowPlan,
  failedTask: WorkflowTaskSpec,
  outcome: WorkflowTaskOutcome,
  replanCount: number,
): string {
  return [
    goal,
    "",
    "Workflow runtime replan request:",
    `- Current workflow id: ${plan.id}`,
    `- Replan attempt: ${replanCount + 1}`,
    `- Failed task id: ${failedTask.id}`,
    `- Failed task title: ${failedTask.title}`,
    `- Failed task kind: ${failedTask.kind}`,
    `- Failure status: ${outcome.status}`,
    `- Failure output: ${outcome.output}`,
    "",
    "Return status=\"workflow\" with a corrected workflow_plan that avoids the failed path, or a final/clarify answer if no safe workflow can continue.",
    "Keep the replacement workflow small and executable by the current runtime.",
  ].join("\n");
}

function buildSyntheticFailureHistory(task: WorkflowTaskSpec, outcome: WorkflowTaskOutcome): RunTaskResult["executorHistory"] {
  if (outcome.executorHistory.length > 0) {
    return outcome.executorHistory;
  }
  return [{
    status: outcome.status === "blocked" ? "blocked" : "failed",
    summary: outcome.output || `Workflow task ${task.id} failed.`,
    tool_calls_made: [],
    artifacts: [],
    raw_result: outcome.output,
    error: outcome.output,
    source: "model_text",
  }];
}

function emitWorkflowTaskEvent(
  type: string,
  task: WorkflowTaskSpec,
  step: number,
  options?: RunOptions,
  data?: Record<string, unknown>,
): void {
  options?.onEvent?.({
    type,
    step,
    data: {
      task_id: task.id,
      title: task.title,
      kind: task.kind,
      role: task.role,
      ...data,
    },
  });
}

async function waitForApproval(task: WorkflowTaskSpec, options?: RunOptions): Promise<"approved" | "denied"> {
  if (!options?.jobId) {
    throw new Error("Approval task requires a jobId-backed session.");
  }

  const approvalRequest: ApprovalRequest = {
    id: `appr_${randomUUID().slice(0, 8)}`,
    jobId: options.jobId,
    taskIds: [task.id],
    reason: task.instruction,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  persistApprovalRequest(options.jobId, approvalRequest);

  return await new Promise<"approved" | "denied">((resolve) => {
    const registered = setApprovalResolver(options.jobId!, (decision) => {
      resolve(decision);
    });
    if (!registered) {
      resolve("denied");
    }
  });
}

function buildTaskRunFromOutcome(outcome: WorkflowTaskOutcome): TaskRun {
  return createTaskRunRecord({
    id: outcome.task.id,
    title: outcome.task.title,
    description: outcome.task.instruction,
    status: outcome.status,
    assignee: outcome.task.role,
    dependsOn: outcome.task.depends_on,
    verified: outcome.verified,
    output: outcome.output,
    artifacts: outcome.artifacts,
    attempts: outcome.attempts,
    executorHistory: outcome.executorHistory,
    verificationResult: outcome.verificationResult,
  });
}

function cloneArtifactsForArchivedTaskRun(artifacts: readonly Artifact[], archivedTaskRunId: string): Artifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    id: `${artifact.id}_archived_${archivedTaskRunId}`,
    sourceTaskRunId: archivedTaskRunId,
    relatedTaskRunId: archivedTaskRunId,
  }));
}

function buildArchivedTaskRuns(
  plan: WorkflowPlan,
  outcomes: Iterable<WorkflowTaskOutcome>,
  replacementWorkflowId: string,
): TaskRun[] {
  return [...outcomes].map((outcome) => {
    const archivedTaskRunId = `${plan.id}:${outcome.task.id}`;
    return createTaskRunRecord({
      id: archivedTaskRunId,
      title: `${outcome.task.title} [superseded by ${replacementWorkflowId}]`,
      description: `${outcome.task.instruction}\nSuperseded by workflow ${replacementWorkflowId}.`,
      status: outcome.status,
      assignee: outcome.task.role,
      dependsOn: outcome.task.depends_on,
      verified: outcome.verified,
      output: outcome.output,
      artifacts: cloneArtifactsForArchivedTaskRun(outcome.artifacts, archivedTaskRunId),
      attempts: outcome.attempts,
      executorHistory: outcome.executorHistory,
      verificationResult: outcome.verificationResult,
    });
  });
}

function buildPlanSummary(plan: WorkflowPlan, state: WorkflowRuntimeState): string {
  if (state.replanHistory.length === 0) {
    return `Workflow plan ${plan.id} executed in the current runtime.`;
  }
  const historyText = state.replanHistory
    .map((entry, index) => `${index + 1}. ${entry.supersededWorkflowId} -> ${entry.replacementWorkflowId} (failed task: ${entry.failedTaskId})`)
    .join(" | ");
  return `Workflow plan ${plan.id} executed in the current runtime after ${state.replanHistory.length} replans. History: ${historyText}`;
}

function persistWorkflowProgress(
  goal: string,
  plan: WorkflowPlan,
  outcomes: Map<string, WorkflowTaskOutcome>,
  status: RunTaskResult["status"],
  state: WorkflowRuntimeState,
  options?: RunOptions,
): void {
  if (!options?.jobId || !options.planId) {
    return;
  }

  const taskRuns = plan.tasks.map((task) => buildTaskRunFromOutcome(outcomes.get(task.id) ?? {
    task,
    status: "pending",
    verified: false,
    output: "",
    artifacts: [],
    executorHistory: [],
    attempts: 0,
  }));
  const mergedTaskRuns = [...state.archivedTaskRuns, ...taskRuns];
  const artifacts = [...state.archivedArtifacts, ...mergedTaskRuns.flatMap((taskRun) => taskRun.artifacts)];
  const output = summarizeWorkflowOutput(plan, outcomes) || "Workflow is in progress.";
  const jobStatus = status === "completed"
    ? "completed"
    : status === "failed"
      ? "failed"
      : status === "blocked" && mergedTaskRuns.some((taskRun) => taskRun.status === "awaiting_approval")
        ? "awaiting_approval"
        : "running";
  const verified = mergedTaskRuns.every((taskRun) => taskRun.status !== "completed" || taskRun.verified);
  const planRecord = createPlanRecord({
    id: options.planId,
    goal,
    mode: "task",
    taskRunIds: mergedTaskRuns.map((taskRun) => taskRun.id),
    summary: buildPlanSummary(plan, state),
  });
  const jobRecord = createJobRecord({
    id: options.jobId,
    goal,
    mode: "task",
    status: jobStatus,
    verified,
    output,
    plan: planRecord,
    taskRuns: mergedTaskRuns,
    artifacts,
    workflowGraph: buildWorkflowGraph(plan.id, mergedTaskRuns, planRecord.summary),
  });
  const existing = readJobRecord(options.jobId);
  if (existing) {
    updateStoredJobRecord(options.jobId, (record) => ({
      ...record,
      savedAt: new Date().toISOString(),
      job: jobRecord,
      plan: planRecord,
      taskRuns: mergedTaskRuns,
      artifacts,
      workflowGraph: jobRecord.workflowGraph,
    }));
    return;
  }
}

function summarizeWorkflowOutput(plan: WorkflowPlan, outcomes: Map<string, WorkflowTaskOutcome>): string {
  const completedRequired = plan.tasks
    .filter((task) => task.required !== false)
    .map((task) => outcomes.get(task.id))
    .filter((outcome): outcome is WorkflowTaskOutcome => Boolean(outcome));

  const lastCompleted = [...completedRequired].reverse().find((outcome) => outcome.status === "completed");
  if (lastCompleted?.output.trim()) {
    return lastCompleted.output;
  }

  return completedRequired
    .map((outcome) => `${outcome.task.title}: ${outcome.output}`)
    .filter((value) => value.trim().length > 0)
    .join("\n");
}

function buildTaskLookup(plan: WorkflowPlan): Map<string, WorkflowTaskSpec> {
  return new Map(plan.tasks.map((task) => [task.id, task]));
}

function resolveVerifierAgent(config: OrchestratorConfig, agentId?: string): RegisteredAgent | undefined {
  const agents = Object.values(config.agents ?? {});
  if (agentId) {
    return agents.find((agent) => agent.id === agentId);
  }
  return agents.find((agent) => {
    const id = agent.id.toLowerCase();
    const role = agent.role.toLowerCase();
    return id === "verifier" || role === "verifier" || role.includes("verifier");
  });
}

function resolveTaskVerifiers(
  config: OrchestratorConfig,
  task: WorkflowTaskSpec,
  runtimeDeps: RuntimeDeps,
  options?: RunOptions,
): { verifiers?: Verifier[]; preflightChecks: VerificationCheck[] } {
  const preflightChecks: VerificationCheck[] = [];
  if (task.constraints?.verifier_profile === "system") {
    return { verifiers: DEFAULT_VERIFIERS, preflightChecks };
  }

  const wantsModelVerifier = task.constraints?.verifier_profile === "system_and_model"
    || task.constraints?.verifier_agent_id !== undefined
    || task.constraints?.verifier_profile === undefined;
  if (!wantsModelVerifier) {
    return { verifiers: DEFAULT_VERIFIERS, preflightChecks };
  }

  const verifierAgent = resolveVerifierAgent(config, task.constraints?.verifier_agent_id);
  if (!verifierAgent) {
    if (task.constraints?.verifier_profile === "system_and_model" || task.constraints?.verifier_agent_id) {
      preflightChecks.push({
        name: "verifier_agent_resolution",
        passed: false,
        status: "failed",
        detail: task.constraints?.verifier_agent_id
          ? `Configured verifier_agent_id was not found: ${task.constraints.verifier_agent_id}.`
          : "No registered verifier agent was found for system_and_model verification.",
      });
      return { verifiers: DEFAULT_VERIFIERS, preflightChecks };
    }
    return { verifiers: undefined, preflightChecks };
  }
  return {
    verifiers: [
      ...DEFAULT_VERIFIERS,
      createModelVerifier(verifierAgent.model, {
        runChat: runtimeDeps.runChatCompletionDetailed,
        runOptions: options,
      }),
    ],
    preflightChecks,
  };
}

function mergePreflightChecks(result: VerificationResult, preflightChecks: VerificationCheck[]): VerificationResult {
  if (preflightChecks.length === 0) {
    return result;
  }
  const checks = [...preflightChecks, ...result.checks];
  const failedChecks = checks.filter((check) => !check.passed);
  const insufficientChecks = failedChecks.filter((check) => check.status === "insufficient");
  const hardFailedChecks = failedChecks.filter((check) => check.status !== "insufficient");
  const status: VerificationResult["status"] = hardFailedChecks.length > 0
    ? "failed"
    : insufficientChecks.length > 0
      ? "insufficient"
      : "verified";
  return {
    status,
    summary: failedChecks.length === 0
      ? result.summary
      : failedChecks.map((check) => `${check.name}: ${check.detail}`).join("; "),
    checks,
  };
}

function buildDependencyOutputs(task: WorkflowTaskSpec, outcomes: Map<string, WorkflowTaskOutcome>): string[] {
  return task.depends_on
    .map((depId) => outcomes.get(depId)?.output ?? "")
    .filter((value) => value.trim().length > 0);
}

function buildVerificationContext(
  goal: string,
  task: WorkflowTaskSpec,
  outcomes: Map<string, WorkflowTaskOutcome>,
  options?: RunOptions,
): VerificationContext {
  const dependencyOutcomes = task.depends_on
    .map((depId) => outcomes.get(depId))
    .filter((outcome): outcome is WorkflowTaskOutcome => Boolean(outcome));
  const taskRuns = dependencyOutcomes.map((outcome) => buildTaskRunFromOutcome(outcome));
  const acceptance = task.constraints?.minimum_artifact_count !== undefined
    || task.constraints?.required_artifact_type !== undefined
    || task.constraints?.required_schema !== undefined
    ? {
        minimumArtifactCount: task.constraints.minimum_artifact_count,
        requiredArtifactType: task.constraints.required_artifact_type,
        requiredSchema: task.constraints.required_schema,
      }
    : undefined;

  return {
    jobId: options?.jobId ?? `workflow_${task.id}`,
    goal,
    executorHistory: dependencyOutcomes.flatMap((outcome) => outcome.executorHistory),
    artifacts: dependencyOutcomes.flatMap((outcome) => outcome.artifacts),
    taskRuns,
    workspaceRoot: WORKSPACE_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    acceptance,
  };
}

function resolveFinishConditionTaskIds(plan: WorkflowPlan): string[] {
  if (plan.finish_when.task_ids && plan.finish_when.task_ids.length > 0) {
    return [...plan.finish_when.task_ids];
  }
  if (plan.finish_when.mode === "manual_approval_resolved") {
    return plan.tasks.filter((task) => task.kind === "approval").map((task) => task.id);
  }
  return plan.tasks.filter((task) => task.required !== false).map((task) => task.id);
}

function evaluateFinishCondition(plan: WorkflowPlan, outcomes: Map<string, WorkflowTaskOutcome>): WorkflowFinishEvaluation {
  const taskIds = resolveFinishConditionTaskIds(plan);
  const selectedOutcomes = taskIds
    .map((taskId) => outcomes.get(taskId))
    .filter((outcome): outcome is WorkflowTaskOutcome => Boolean(outcome));
  const unresolvedCount = taskIds.length - selectedOutcomes.length;
  const completedOutcomes = selectedOutcomes.filter((outcome) => outcome.status === "completed");
  const hasFailed = selectedOutcomes.some((outcome) => outcome.status === "failed");
  const hasBlocked = selectedOutcomes.some((outcome) => outcome.status === "blocked");

  switch (plan.finish_when.mode) {
    case "any_of":
      if (completedOutcomes.length > 0) {
        return {
          met: true,
          terminal: true,
          status: "completed",
          verified: completedOutcomes.some((outcome) => outcome.verified),
          summary: `finish_when any_of satisfied by ${completedOutcomes[0]!.task.id}.`,
        };
      }
      if (unresolvedCount === 0) {
        return {
          met: false,
          terminal: true,
          status: hasBlocked ? "blocked" : "failed",
          verified: false,
          summary: "finish_when any_of could not be satisfied.",
        };
      }
      return {
        met: false,
        terminal: false,
        status: "blocked",
        verified: false,
        summary: "finish_when any_of still pending.",
      };
    case "first_success":
      if (completedOutcomes.length > 0) {
        return {
          met: true,
          terminal: true,
          status: "completed",
          verified: completedOutcomes[0]!.verified,
          summary: `finish_when first_success satisfied by ${completedOutcomes[0]!.task.id}.`,
        };
      }
      if (unresolvedCount === 0) {
        return {
          met: false,
          terminal: true,
          status: hasBlocked ? "blocked" : "failed",
          verified: false,
          summary: "finish_when first_success could not be satisfied.",
        };
      }
      return {
        met: false,
        terminal: false,
        status: "blocked",
        verified: false,
        summary: "finish_when first_success still pending.",
      };
    case "manual_approval_resolved": {
      if (taskIds.length === 0) {
        return {
          met: true,
          terminal: true,
          status: "completed",
          verified: true,
          summary: "finish_when manual_approval_resolved had no approval tasks.",
        };
      }
      const hasAwaitingApproval = taskIds.some((taskId) => outcomes.get(taskId)?.status === "awaiting_approval");
      if (unresolvedCount > 0 || hasAwaitingApproval) {
        return {
          met: false,
          terminal: false,
          status: "blocked",
          verified: false,
          summary: "finish_when manual_approval_resolved still pending approval.",
        };
      }
      const allCompleted = selectedOutcomes.every((outcome) => outcome.status === "completed");
      return {
        met: true,
        terminal: true,
        status: allCompleted ? "completed" : hasFailed ? "failed" : "blocked",
        verified: allCompleted && selectedOutcomes.every((outcome) => outcome.verified),
        summary: allCompleted
          ? "finish_when manual_approval_resolved satisfied."
          : "finish_when manual_approval_resolved resolved without approval.",
      };
    }
    case "all_required_tasks_completed":
    default: {
      const requiredTaskIds = plan.tasks.filter((task) => task.required !== false).map((task) => task.id);
      const requiredOutcomes = requiredTaskIds
        .map((taskId) => outcomes.get(taskId))
        .filter((outcome): outcome is WorkflowTaskOutcome => Boolean(outcome));
      const requiredUnresolvedCount = requiredTaskIds.length - requiredOutcomes.length;
      const requiredHasFailed = requiredOutcomes.some((outcome) => outcome.status === "failed");
      const requiredHasBlocked = requiredOutcomes.some((outcome) => outcome.status === "blocked");
      const allRequiredCompleted = requiredOutcomes.every((outcome) => outcome.status === "completed");
      return {
        met: requiredTaskIds.length === 0 || (requiredUnresolvedCount === 0 && allRequiredCompleted),
        terminal: requiredUnresolvedCount === 0 || requiredHasFailed || requiredHasBlocked,
        status: requiredHasBlocked
          ? "blocked"
          : requiredHasFailed
            ? "failed"
            : allRequiredCompleted
              ? "completed"
              : "blocked",
        verified: allRequiredCompleted && requiredOutcomes.every((outcome) => outcome.verified),
        summary: allRequiredCompleted
          ? "finish_when all_required_tasks_completed satisfied."
          : "finish_when all_required_tasks_completed still pending.",
      };
    }
  }
}

function markRemainingTasksSkipped(plan: WorkflowPlan, outcomes: Map<string, WorkflowTaskOutcome>, reason: string): void {
  for (const task of plan.tasks) {
    if (outcomes.has(task.id)) {
      continue;
    }
    outcomes.set(task.id, {
      task,
      status: "skipped",
      verified: false,
      output: reason,
      artifacts: [],
      executorHistory: [],
      attempts: 0,
    });
  }
}

function finalizeIfFinishConditionMet(
  plan: WorkflowPlan,
  outcomes: Map<string, WorkflowTaskOutcome>,
): boolean {
  const finish = evaluateFinishCondition(plan, outcomes);
  if (!finish.met) {
    return false;
  }
  markRemainingTasksSkipped(plan, outcomes, finish.summary);
  return true;
}

function materializeTask(task: WorkflowTaskSpec, overrides: Map<string, WorkflowTaskOverride>): WorkflowTaskOverride {
  return overrides.get(task.id) ?? { sourceTaskId: task.id, task };
}

async function executeFallbackTask(
  sourceTask: WorkflowTaskSpec,
  fallbackTaskId: string,
  taskLookup: Map<string, WorkflowTaskSpec>,
  fallbackOverrides: Map<string, WorkflowTaskOverride>,
  outcomes: Map<string, WorkflowTaskOutcome>,
  goal: string,
  config: OrchestratorConfig,
  routePolicy: RoutePolicy,
  step: number,
  logger: RunLogger | undefined,
  runtimeDeps: RuntimeDeps,
  options: RunOptions | undefined,
): Promise<WorkflowTaskOutcome> {
  const fallbackTask = taskLookup.get(fallbackTaskId);
  if (!fallbackTask) {
    return {
      task: sourceTask,
      status: "failed",
      verified: false,
      output: `Fallback task ${fallbackTaskId} was not found.`,
      artifacts: [],
      executorHistory: [],
      attempts: 0,
    };
  }

  const dependencyOutputs = buildDependencyOutputs(fallbackTask, outcomes);
  const overriddenTask: WorkflowTaskSpec = {
    ...fallbackTask,
    id: sourceTask.id,
    title: `${sourceTask.title} (fallback: ${fallbackTask.title})`,
    required: sourceTask.required,
  };
  fallbackOverrides.set(sourceTask.id, {
    sourceTaskId: sourceTask.id,
    task: overriddenTask,
  });
  emitWorkflowTaskEvent("workflow.task.assigned", overriddenTask, step, options, {
    depends_on: overriddenTask.depends_on,
    fallback_for: sourceTask.id,
    fallback_task_id: fallbackTask.id,
  });
  logger?.log("workflow.task.fallback", {
    workflow_task_id: sourceTask.id,
    fallback_task_id: fallbackTask.id,
  });

  if (fallbackTask.kind === "delegate") {
    const subtaskResult = await runtimeDeps.runTask(
      config,
      buildWorkflowTaskPrompt(goal, overriddenTask, dependencyOutputs),
      routePolicy,
      logger,
      runtimeDeps,
      options,
    );
    return {
      task: overriddenTask,
      status: subtaskResult.status === "completed"
        ? "completed"
        : subtaskResult.status === "failed"
          ? resolveFailureStatus(sourceTask, "failed")
          : resolveFailureStatus(sourceTask, "blocked"),
      verified: subtaskResult.verified,
      output: subtaskResult.output,
      artifacts: subtaskResult.artifacts,
      executorHistory: subtaskResult.executorHistory,
      attempts: subtaskResult.executorHistory.length,
    };
  }

  if (fallbackTask.kind === "synthesize") {
    const synthesis = await runtimeDeps.runTeamSynthesis(
      config,
      goal,
      buildSynthesisPrompt(goal, overriddenTask, dependencyOutputs),
      dependencyOutputs.join("\n\n"),
      logger,
      runtimeDeps,
      options,
    );
    return {
      task: overriddenTask,
      status: synthesis.trim() ? "completed" : resolveFailureStatus(sourceTask, "failed"),
      verified: synthesis.trim().length > 0,
      output: synthesis.trim() || "Fallback synthesis produced no output.",
      artifacts: [],
      executorHistory: [],
      attempts: 1,
    };
  }

  const planner: PlannerOutput = {
    goal,
    status: "need_executor",
    reasoning_summary: `workflow fallback task ${sourceTask.id}`,
    next_step: overriddenTask.title,
    audit: {
      verdict: "approved",
      notes: `Workflow task ${sourceTask.id} is executing fallback task ${fallbackTask.id}.`,
    },
    executor_request: {
      instruction: buildWorkflowTaskPrompt(goal, overriddenTask, dependencyOutputs),
      allowed_tools: overriddenTask.allowed_tools,
      expected_output: `Complete fallback workflow task ${fallbackTask.id} for ${sourceTask.id}.`,
    },
  };
  const executorResult = await runtimeDeps.runExecutorStep(config, planner, step, logger, runtimeDeps, options);
  return {
    task: overriddenTask,
    status: executorResult.status === "success"
      ? "completed"
      : executorResult.status === "failed"
        ? resolveFailureStatus(sourceTask, "failed")
        : resolveFailureStatus(sourceTask, "blocked"),
    verified: executorResult.status === "success",
    output: getExecutorDecisionText(executorResult),
    artifacts: collectArtifactsFromExecutorHistory([executorResult], sourceTask.id),
    executorHistory: [executorResult],
    attempts: 1,
  };
}

function persistOutcomeAndEvent(
  goal: string,
  plan: WorkflowPlan,
  outcomes: Map<string, WorkflowTaskOutcome>,
  task: WorkflowTaskSpec,
  outcome: WorkflowTaskOutcome,
  step: number,
  state: WorkflowRuntimeState,
  options?: RunOptions,
): void {
  outcomes.set(task.id, outcome);
  emitWorkflowTaskEvent(
    outcome.status === "completed"
      ? "workflow.task.completed"
      : outcome.status === "skipped"
        ? "workflow.task.skipped"
        : "workflow.task.failed",
    task,
    step,
    options,
    { output: outcome.output },
  );
  persistWorkflowProgress(
    goal,
    plan,
    outcomes,
    outcome.status === "completed" ? "completed" : outcome.status === "failed" ? "failed" : "blocked",
    state,
    options,
  );
}

async function maybeReplanWorkflow(
  goal: string,
  plan: WorkflowPlan,
  failedTask: WorkflowTaskSpec,
  outcome: WorkflowTaskOutcome,
  outcomes: Map<string, WorkflowTaskOutcome>,
  routePolicy: RoutePolicy,
  step: number,
  logger: RunLogger | undefined,
  runtimeDeps: RuntimeDeps,
  config: OrchestratorConfig,
  state: WorkflowRuntimeState,
  options?: RunOptions,
): Promise<RunTaskResult | undefined> {
  if (failedTask.retry_policy?.on_failure !== "replan") {
    return undefined;
  }
  if (plan.replan_policy?.allow_runtime_replan !== true) {
    logger?.log("workflow.replan.skipped", {
      workflow_id: plan.id,
      task_id: failedTask.id,
      reason: "runtime_replan_not_allowed",
    });
    return undefined;
  }

  const maxReplans = Math.min(
    config.policy.maxReplans,
    plan.replan_policy.max_replans,
  );
  if (state.replanCount >= maxReplans) {
    logger?.log("workflow.replan.skipped", {
      workflow_id: plan.id,
      task_id: failedTask.id,
      reason: "max_replans_reached",
      replan_count: state.replanCount,
      max_replans: maxReplans,
    });
    return undefined;
  }

  options?.onEvent?.({
    type: "workflow.replan.requested",
    step,
    data: {
      workflow_id: plan.id,
      task_id: failedTask.id,
      title: failedTask.title,
      replan_count: state.replanCount,
      max_replans: maxReplans,
      reason: outcome.output,
    },
  });
  logger?.log("workflow.replan.requested", {
    workflow_id: plan.id,
    task_id: failedTask.id,
    replan_count: state.replanCount,
    max_replans: maxReplans,
    outcome,
  });

  const replanGoal = buildWorkflowReplanPrompt(goal, plan, failedTask, outcome, state.replanCount);
  const planner = await runtimeDeps.runPlannerStep(
    config,
    replanGoal,
    buildSyntheticFailureHistory(failedTask, outcome),
    state.replanCount + 1,
    routePolicy,
    step,
    logger,
    runtimeDeps,
    options,
  );
  state.replanCount += 1;

  if (!planner.workflow_plan) {
    logger?.log("workflow.replan.rejected", {
      workflow_id: plan.id,
      task_id: failedTask.id,
      reason: "planner_did_not_return_workflow_plan",
      planner_status: planner.status,
    });
    options?.onEvent?.({
      type: "workflow.replan.rejected",
      step,
      data: {
        workflow_id: plan.id,
        task_id: failedTask.id,
        reason: "planner_did_not_return_workflow_plan",
        planner_status: planner.status,
      },
    });
    return undefined;
  }

  const validation = validateWorkflowPlan(planner.workflow_plan, TOOL_DEFINITIONS);
  const support = validation.valid ? assessWorkflowExecutionSupport(planner.workflow_plan) : undefined;
  if (!validation.valid || support?.supported === false) {
    const issues = validation.valid ? support?.issues ?? [] : validation.issues;
    logger?.log("workflow.replan.rejected", {
      workflow_id: plan.id,
      replacement_workflow_id: planner.workflow_plan.id,
      task_id: failedTask.id,
      issues,
    });
    options?.onEvent?.({
      type: "workflow.replan.rejected",
      step,
      data: {
        workflow_id: plan.id,
        replacement_workflow_id: planner.workflow_plan.id,
        task_id: failedTask.id,
        issues,
      },
    });
    return undefined;
  }

  logger?.log("workflow.replan.accepted", {
    workflow_id: plan.id,
    replacement_workflow_id: planner.workflow_plan.id,
    task_id: failedTask.id,
    replan_count: state.replanCount,
  });
  options?.onEvent?.({
    type: "workflow.replan.accepted",
    step,
    data: {
      workflow_id: plan.id,
      replacement_workflow_id: planner.workflow_plan.id,
      task_id: failedTask.id,
      replan_count: state.replanCount,
      task_count: planner.workflow_plan.tasks.length,
    },
  });
  options?.onEvent?.({
    type: "workflow.plan.replanned",
    step,
    data: {
      workflow_id: plan.id,
      replacement_workflow_id: planner.workflow_plan.id,
      task_id: failedTask.id,
      replan_count: state.replanCount,
    },
  });
  const archivedOutcomeMap = new Map<string, WorkflowTaskOutcome>();
  for (const existingOutcome of outcomes.values()) {
    archivedOutcomeMap.set(existingOutcome.task.id, existingOutcome);
  }
  archivedOutcomeMap.set(failedTask.id, outcome);
  for (const archivedOutcome of archivedOutcomeMap.values()) {
    options?.onEvent?.({
      type: "workflow.task.superseded",
      step,
      data: {
        task_id: archivedOutcome.task.id,
        title: archivedOutcome.task.title,
        kind: archivedOutcome.task.kind,
        role: archivedOutcome.task.role,
        workflow_id: plan.id,
        replacement_workflow_id: planner.workflow_plan.id,
      },
    });
  }
  const archivedTaskRuns = buildArchivedTaskRuns(plan, archivedOutcomeMap.values(), planner.workflow_plan.id);
  state.archivedTaskRuns.push(...archivedTaskRuns);
  state.archivedArtifacts.push(...archivedTaskRuns.flatMap((taskRun) => taskRun.artifacts));
  state.replanHistory.push({
    supersededWorkflowId: plan.id,
    replacementWorkflowId: planner.workflow_plan.id,
    failedTaskId: failedTask.id,
    failedTaskTitle: failedTask.title,
  });

  return await runWorkflowPlan(
    config,
    goal,
    planner.workflow_plan,
    routePolicy,
    logger,
    runtimeDeps,
    options,
    state,
  );
}

export async function runWorkflowPlan(
  config: OrchestratorConfig,
  goal: string,
  plan: WorkflowPlan,
  routePolicy: RoutePolicy,
  logger?: RunLogger,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
  state: WorkflowRuntimeState = { replanCount: 0, archivedTaskRuns: [], archivedArtifacts: [], replanHistory: [] },
): Promise<RunTaskResult> {
  const runtimeDeps = mergeRuntimeDeps(deps);
  const taskLookup = buildTaskLookup(plan);
  const fallbackOverrides = new Map<string, WorkflowTaskOverride>();
  const consumedFallbackTaskIds = new Set<string>();
  const validation = validateWorkflowPlan(plan, TOOL_DEFINITIONS);
  if (!validation.valid) {
    const output = `Workflow plan validation failed: ${validation.issues.join("; ")}`;
    const failedPlan = createPlanRecord({
      id: options?.planId,
      goal,
      mode: "task",
      taskRunIds: [],
      summary: "Workflow plan validation failed.",
    });
  const failedJob = createJobRecord({
      id: options?.jobId,
      goal,
      mode: "task",
      status: "failed",
      verified: false,
      output,
      plan: failedPlan,
      taskRuns: [],
      artifacts: [],
      workflowGraph: buildWorkflowGraph(plan.id, [], failedPlan.summary),
    });
    return {
      status: "failed",
      output,
      verified: false,
      executorHistory: [],
      job: failedJob,
      plan: failedPlan,
      taskRuns: [],
      artifacts: [],
    };
  }

  const support = assessWorkflowExecutionSupport(plan);
  if (!support.supported) {
    const output = `Workflow plan is valid but not executable in the current runtime: ${support.issues.join("; ")}`;
    const blockedPlan = createPlanRecord({
      id: options?.planId,
      goal,
      mode: "task",
      taskRunIds: [],
      summary: "Workflow plan is not executable in the current runtime.",
    });
  const blockedJob = createJobRecord({
      id: options?.jobId,
      goal,
      mode: "task",
      status: "blocked",
      verified: false,
      output,
      plan: blockedPlan,
      taskRuns: [],
      artifacts: [],
      workflowGraph: buildWorkflowGraph(plan.id, [], blockedPlan.summary),
    });
    return {
      status: "blocked",
      output,
      verified: false,
      executorHistory: [],
      job: blockedJob,
      plan: blockedPlan,
      taskRuns: [],
      artifacts: [],
    };
  }

  const outcomes = new Map<string, WorkflowTaskOutcome>();
  let step = 1;

  for (const task of plan.tasks) {
    if (task.depends_on.length === 0) {
      emitWorkflowTaskEvent("workflow.task.ready", task, step, options);
    }
  }

  while (outcomes.size < plan.tasks.length) {
    let progressed = false;

    for (const task of plan.tasks) {
      if (outcomes.has(task.id)) {
        continue;
      }
      if (consumedFallbackTaskIds.has(task.id)) {
        const consumedOutcome: WorkflowTaskOutcome = {
          task,
          status: "skipped",
          verified: false,
          output: `Task ${task.id} was consumed as a fallback path and will not execute independently.`,
          artifacts: [],
          executorHistory: [],
          attempts: 0,
        };
        persistOutcomeAndEvent(goal, plan, outcomes, task, consumedOutcome, step, state, options);
        progressed = true;
        continue;
      }

      const materialized = materializeTask(task, fallbackOverrides);
      const effectiveTask = materialized.task;

      const blockingDependency = hasBlockingDependency(effectiveTask, outcomes);
      if (blockingDependency) {
        const outcome: WorkflowTaskOutcome = {
          task: effectiveTask,
          status: effectiveTask.required === false ? "skipped" : resolveFailureStatus(effectiveTask, "failed"),
          verified: false,
          output: `Dependency ${blockingDependency.task.id} did not complete successfully.`,
          artifacts: [],
          executorHistory: [],
          attempts: 0,
        };
        persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        if (finalizeIfFinishConditionMet(plan, outcomes)) {
          progressed = true;
          break;
        }
        progressed = true;
        continue;
      }

      const skippedDependency = hasSkippedDependency(effectiveTask, outcomes);
      if (skippedDependency) {
        const outcome: WorkflowTaskOutcome = {
          task: effectiveTask,
          status: "skipped",
          verified: false,
          output: `Dependency ${skippedDependency.task.id} was skipped.`,
          artifacts: [],
          executorHistory: [],
          attempts: 0,
        };
        persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        if (finalizeIfFinishConditionMet(plan, outcomes)) {
          progressed = true;
          break;
        }
        progressed = true;
        continue;
      }

      if (!areDependenciesCompleted(effectiveTask, outcomes)) {
        continue;
      }

      const dependencyOutputs = buildDependencyOutputs(effectiveTask, outcomes);

      emitWorkflowTaskEvent("workflow.task.assigned", effectiveTask, step, options, {
        depends_on: effectiveTask.depends_on,
      });
      logger?.log("workflow.task.start", {
        workflow_id: plan.id,
        task_id: effectiveTask.id,
        kind: effectiveTask.kind,
        role: effectiveTask.role,
      });

      if (effectiveTask.kind === "approval") {
        outcomes.set(task.id, {
          task: effectiveTask,
          status: "awaiting_approval",
          verified: false,
          output: "Waiting for approval.",
          artifacts: [],
          executorHistory: [],
          attempts: 0,
        });
        emitWorkflowTaskEvent("workflow.task.awaiting_approval", effectiveTask, step, options);
        persistWorkflowProgress(goal, plan, outcomes, "blocked", state, options);
        const decision = await waitForApproval(effectiveTask, options);
        if (decision === "approved") {
          const outcome: WorkflowTaskOutcome = {
            task: effectiveTask,
            status: "completed",
            verified: true,
            output: "Approval granted.",
            artifacts: [],
            executorHistory: [],
            attempts: 1,
          };
          persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        } else {
          let outcome: WorkflowTaskOutcome = {
            task: effectiveTask,
            status: resolveFailureStatus(effectiveTask, "blocked"),
            verified: false,
            output: "Approval denied.",
            artifacts: [],
            executorHistory: [],
            attempts: 1,
          };
          if (effectiveTask.retry_policy?.on_failure === "fallback" && effectiveTask.retry_policy.fallback_task_id) {
            consumedFallbackTaskIds.add(effectiveTask.retry_policy.fallback_task_id);
            outcome = await executeFallbackTask(
              effectiveTask,
              effectiveTask.retry_policy.fallback_task_id,
              taskLookup,
              fallbackOverrides,
              outcomes,
              goal,
              config,
              routePolicy,
              step,
              logger,
              runtimeDeps,
              options,
            );
          }
          const replannedResult = await maybeReplanWorkflow(goal, plan, effectiveTask, outcome, outcomes, routePolicy, step, logger, runtimeDeps, config, state, options);
          if (replannedResult) {
            return replannedResult;
          }
          persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        }
        if (finalizeIfFinishConditionMet(plan, outcomes)) {
          progressed = true;
          step += 1;
          break;
        }
        progressed = true;
        step += 1;
        continue;
      }

      if (effectiveTask.kind === "delegate") {
        const subtaskResult = await runtimeDeps.runTask(
          config,
          buildWorkflowTaskPrompt(goal, effectiveTask, dependencyOutputs),
          routePolicy,
          logger,
          runtimeDeps,
          options,
        );
        let outcome: WorkflowTaskOutcome = {
          task: effectiveTask,
          status: subtaskResult.status === "completed"
            ? "completed"
            : subtaskResult.status === "failed"
              ? resolveFailureStatus(effectiveTask, "failed")
              : resolveFailureStatus(effectiveTask, "blocked"),
          verified: subtaskResult.verified,
          output: subtaskResult.output,
          artifacts: subtaskResult.artifacts,
          executorHistory: subtaskResult.executorHistory,
          attempts: subtaskResult.executorHistory.length,
        };
        if (subtaskResult.status !== "completed" && effectiveTask.retry_policy?.on_failure === "fallback" && effectiveTask.retry_policy.fallback_task_id) {
          consumedFallbackTaskIds.add(effectiveTask.retry_policy.fallback_task_id);
          outcome = await executeFallbackTask(
            effectiveTask,
            effectiveTask.retry_policy.fallback_task_id,
            taskLookup,
            fallbackOverrides,
            outcomes,
            goal,
            config,
            routePolicy,
            step,
            logger,
            runtimeDeps,
            options,
          );
        }
        const replannedResult = await maybeReplanWorkflow(goal, plan, effectiveTask, outcome, outcomes, routePolicy, step, logger, runtimeDeps, config, state, options);
        if (replannedResult) {
          return replannedResult;
        }
        persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        if (finalizeIfFinishConditionMet(plan, outcomes)) {
          progressed = true;
          step += 1;
          break;
        }
        progressed = true;
        step += 1;
        continue;
      }

      if (effectiveTask.kind === "synthesize") {
        const synthesis = await runtimeDeps.runTeamSynthesis(
          config,
          goal,
          buildSynthesisPrompt(goal, effectiveTask, dependencyOutputs),
          dependencyOutputs.join("\n\n"),
          logger,
          runtimeDeps,
          options,
        );
        let outcome: WorkflowTaskOutcome = {
          task: effectiveTask,
          status: synthesis.trim() ? "completed" : resolveFailureStatus(effectiveTask, "failed"),
          verified: synthesis.trim().length > 0,
          output: synthesis.trim() || "Synthesis produced no output.",
          artifacts: [],
          executorHistory: [],
          attempts: 1,
        };
        if (!synthesis.trim() && effectiveTask.retry_policy?.on_failure === "fallback" && effectiveTask.retry_policy.fallback_task_id) {
          consumedFallbackTaskIds.add(effectiveTask.retry_policy.fallback_task_id);
          outcome = await executeFallbackTask(
            effectiveTask,
            effectiveTask.retry_policy.fallback_task_id,
            taskLookup,
            fallbackOverrides,
            outcomes,
            goal,
            config,
            routePolicy,
            step,
            logger,
            runtimeDeps,
            options,
          );
        }
        const replannedResult = await maybeReplanWorkflow(goal, plan, effectiveTask, outcome, outcomes, routePolicy, step, logger, runtimeDeps, config, state, options);
        if (replannedResult) {
          return replannedResult;
        }
        persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        if (finalizeIfFinishConditionMet(plan, outcomes)) {
          progressed = true;
          step += 1;
          break;
        }
        progressed = true;
        step += 1;
        continue;
      }

      if (effectiveTask.kind === "verify") {
        const verificationContext = buildVerificationContext(goal, effectiveTask, outcomes, options);
        const verifierSelection = resolveTaskVerifiers(config, effectiveTask, runtimeDeps, options);
        const verificationResult = mergePreflightChecks(
          await runVerifiers(verificationContext, verifierSelection.verifiers),
          verifierSelection.preflightChecks,
        );
        const passed = verificationResultPassed(verificationResult);
        const verificationSummary = summarizeVerification(verificationResult);
        const failureStatus = verificationResult.status === "insufficient"
          ? resolveFailureStatus(effectiveTask, "blocked")
          : resolveFailureStatus(effectiveTask, "failed");
        let outcome: WorkflowTaskOutcome = {
          task: effectiveTask,
          status: passed ? "completed" : failureStatus,
          verified: passed,
          output: verificationSummary || (passed ? "Verification passed." : "Verification failed."),
          artifacts: [],
          executorHistory: [],
          attempts: 1,
          verificationResult,
        };
        const replannedResult = await maybeReplanWorkflow(goal, plan, effectiveTask, outcome, outcomes, routePolicy, step, logger, runtimeDeps, config, state, options);
        if (replannedResult) {
          return replannedResult;
        }
        persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
        if (finalizeIfFinishConditionMet(plan, outcomes)) {
          progressed = true;
          step += 1;
          break;
        }
        progressed = true;
        step += 1;
        continue;
      }

      const planner: PlannerOutput = {
        goal,
        status: "need_executor",
        reasoning_summary: `workflow task ${effectiveTask.id}`,
        next_step: effectiveTask.title,
        audit: {
          verdict: "approved",
          notes: `Workflow task ${effectiveTask.id} executing in the current runtime.`,
        },
        executor_request: {
          instruction: buildWorkflowTaskPrompt(goal, effectiveTask, dependencyOutputs),
          allowed_tools: effectiveTask.allowed_tools,
          expected_output: `Complete workflow task ${effectiveTask.id} (${effectiveTask.title}).`,
        },
      };
      const executorResult = await runtimeDeps.runExecutorStep(config, planner, step, logger, runtimeDeps, options);
      let outcome: WorkflowTaskOutcome = {
        task: effectiveTask,
        status: executorResult.status === "success"
          ? "completed"
          : executorResult.status === "failed"
            ? resolveFailureStatus(effectiveTask, "failed")
            : resolveFailureStatus(effectiveTask, "blocked"),
        verified: executorResult.status === "success",
        output: getExecutorDecisionText(executorResult),
        artifacts: collectArtifactsFromExecutorHistory([executorResult], task.id),
        executorHistory: [executorResult],
        attempts: 1,
      };
      if (executorResult.status !== "success" && effectiveTask.retry_policy?.on_failure === "fallback" && effectiveTask.retry_policy.fallback_task_id) {
        consumedFallbackTaskIds.add(effectiveTask.retry_policy.fallback_task_id);
        outcome = await executeFallbackTask(
          effectiveTask,
          effectiveTask.retry_policy.fallback_task_id,
          taskLookup,
          fallbackOverrides,
          outcomes,
          goal,
          config,
          routePolicy,
          step,
          logger,
          runtimeDeps,
          options,
        );
      }
      const replannedResult = await maybeReplanWorkflow(goal, plan, effectiveTask, outcome, outcomes, routePolicy, step, logger, runtimeDeps, config, state, options);
      if (replannedResult) {
        return replannedResult;
      }
      persistOutcomeAndEvent(goal, plan, outcomes, task, outcome, step, state, options);
      if (finalizeIfFinishConditionMet(plan, outcomes)) {
        progressed = true;
        step += 1;
        break;
      }
      progressed = true;
      step += 1;
    }

    if (!progressed) {
      break;
    }
  }

  const taskRuns = plan.tasks.map((task) => buildTaskRunFromOutcome(outcomes.get(task.id) ?? {
    task,
    status: "blocked",
    verified: false,
    output: "Task was not executed.",
    artifacts: [],
    executorHistory: [],
    attempts: 0,
  }));
  const mergedTaskRuns = [...state.archivedTaskRuns, ...taskRuns];
  const artifacts = [...state.archivedArtifacts, ...mergedTaskRuns.flatMap((taskRun) => taskRun.artifacts)];
  const finish = evaluateFinishCondition(plan, outcomes);
  const status = finish.met || finish.terminal ? finish.status : "blocked";
  const verified = status === "completed" && finish.verified;
  const output = summarizeWorkflowOutput(plan, outcomes) || `Workflow ${plan.id} finished with status ${status}.`;
  const planRecord = createPlanRecord({
    id: options?.planId,
    goal,
    mode: "task",
    taskRunIds: mergedTaskRuns.map((taskRun) => taskRun.id),
    summary: buildPlanSummary(plan, state),
  });
  const jobRecord = createJobRecord({
    id: options?.jobId,
    goal,
    mode: "task",
    status,
    verified,
    output,
    plan: planRecord,
    taskRuns: mergedTaskRuns,
    artifacts,
    workflowGraph: buildWorkflowGraph(plan.id, mergedTaskRuns, planRecord.summary),
  });
  persistWorkflowProgress(goal, plan, outcomes, status, state, options);

  return {
    status,
    output,
    verified,
    executorHistory: mergedTaskRuns.flatMap((taskRun) => taskRun.executorHistory ?? []),
    job: jobRecord,
    plan: planRecord,
    taskRuns: mergedTaskRuns,
    artifacts,
  };
}
