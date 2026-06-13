import { dirname, relative, resolve } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { getSkillEvolutionProposalCandidateRoot } from "./skill-evolution-store.js";
import type { StoredJobRecord } from "./job-store.js";
import type { SkillEvolutionProposal, SkillIsolatedReplayEvent, SkillIsolatedReplayStepSummary, SkillRuntimeReplayTaskPayload } from "./skill-evolution-types.js";
import type { SkillManifest } from "./skill-types.js";
import type { Artifact, OrchestratorConfig, RoutePolicy, RunTaskResult } from "./types.js";
import type { VerificationCheck, VerificationResult } from "./types.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "./workflow-contract.js";
import { materializeSkillWorkflow } from "./skill-runtime.js";
import type { PlannerOutput } from "./types.js";
import { runWorkflowPlan } from "./workflow-runtime.js";
import type { RuntimeDeps } from "./runtime/deps.js";

function normalizePath(pathText: string): string {
  return pathText.replace(/\\/g, "/");
}

function resolveBuiltinBaseFromTargetFile(proposal: SkillEvolutionProposal, targetFile: string): string {
  const normalized = normalizePath(targetFile);
  const segments = normalized.split("/");
  const skillSegmentIndex = segments.lastIndexOf(proposal.skillId);
  if (skillSegmentIndex > 0) {
    return segments.slice(0, skillSegmentIndex).join("/");
  }
  return normalizePath(dirname(dirname(normalized)));
}

export function resolveCandidateReplayBuiltinDir(proposal: SkillEvolutionProposal): {
  candidateRoot: string;
  builtinDirAbsolute: string;
  builtinDirRelative: string;
  targetFile: string;
} | null {
  const targetFile = proposal.targetFiles.find((item) => item.endsWith("/skill.json") || item.endsWith("\\skill.json"))
    ?? proposal.targetFiles.find((item) => item.endsWith("/SKILL.md") || item.endsWith("\\SKILL.md"));
  if (!targetFile) {
    return null;
  }
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  const builtinBase = resolveBuiltinBaseFromTargetFile(proposal, targetFile);
  const builtinDirAbsolute = resolve(candidateRoot, builtinBase);
  return {
    candidateRoot,
    builtinDirAbsolute,
    builtinDirRelative: normalizePath(builtinDirAbsolute),
    targetFile,
  };
}

export function buildCandidateReplayConfig(
  baseConfig: OrchestratorConfig,
  proposal: SkillEvolutionProposal,
): {
  config: OrchestratorConfig;
  runtimeSource: {
    prepared: boolean;
    builtinDir?: string;
    candidateRoot?: string;
    targetFile?: string;
    skillId: string;
    note: string;
  };
} {
  const resolved = resolveCandidateReplayBuiltinDir(proposal);
  if (!resolved) {
    return {
      config: baseConfig,
      runtimeSource: {
        prepared: false,
        skillId: proposal.skillId,
        note: "No candidate skill target file was found, so replay runtime injection could not be prepared.",
      },
    };
  }

  return {
    config: {
      ...baseConfig,
      skills: {
        ...baseConfig.skills,
        builtinDir: resolved.builtinDirRelative,
      },
    },
    runtimeSource: {
      prepared: true,
      builtinDir: resolved.builtinDirRelative,
      candidateRoot: resolved.candidateRoot,
      targetFile: resolved.targetFile,
      skillId: proposal.skillId,
      note: "Replay runtime config is prepared to resolve builtin skills from the candidate snapshot first.",
    },
  };
}

export function probeCandidateRuntimeWorkflow(input: {
  baseConfig: OrchestratorConfig;
  proposal: SkillEvolutionProposal;
  baselineRecord?: StoredJobRecord | null;
}): {
  configPrepared: boolean;
  workflowMaterialized: boolean;
  workflowTaskCount: number;
  workflowStrategy?: string;
  runtimeSource: ReturnType<typeof buildCandidateReplayConfig>["runtimeSource"];
  reason: string;
} {
  const replayRuntime = buildCandidateReplayConfig(input.baseConfig, input.proposal);
  if (!replayRuntime.runtimeSource.prepared) {
    return {
      configPrepared: false,
      workflowMaterialized: false,
      workflowTaskCount: 0,
      runtimeSource: replayRuntime.runtimeSource,
      reason: replayRuntime.runtimeSource.note,
    };
  }

  const planner: PlannerOutput = {
    goal: input.baselineRecord?.job.goal ?? `Replay candidate skill ${input.proposal.skillId}.`,
    status: "need_executor",
    reasoning_summary: "Probe candidate runtime workflow materialization for deployment validation.",
    next_step: "Materialize the selected skill workflow from the candidate snapshot.",
    audit: {
      verdict: "approved",
      notes: "Deployment validation runtime probe.",
    },
    skill: {
      skill_id: input.proposal.skillId,
      skill_action: "use_installed",
      skill_reason: "Candidate runtime replay probe.",
    },
  };
  const workflow = materializeSkillWorkflow(replayRuntime.config, planner.goal, planner);
  if (!workflow) {
    return {
      configPrepared: true,
      workflowMaterialized: false,
      workflowTaskCount: 0,
      runtimeSource: replayRuntime.runtimeSource,
      reason: "Candidate runtime config was prepared, but the candidate skill workflow could not be materialized.",
    };
  }

  return {
    configPrepared: true,
    workflowMaterialized: true,
    workflowTaskCount: workflow.tasks.length,
    workflowStrategy: workflow.strategy,
    runtimeSource: replayRuntime.runtimeSource,
    reason: `Candidate runtime workflow materialized with ${workflow.tasks.length} task(s); execution is still disabled for this validator boundary.`,
  };
}

function buildCandidateReplayPlanner(proposal: SkillEvolutionProposal, baselineRecord?: StoredJobRecord | null): PlannerOutput {
  return {
    goal: baselineRecord?.job.goal ?? `Replay candidate skill ${proposal.skillId}.`,
    status: "need_executor",
    reasoning_summary: "Replay candidate runtime workflow for deployment validation.",
    next_step: "Execute the selected candidate skill workflow in deterministic replay mode.",
    audit: {
      verdict: "approved",
      notes: "Deployment validation candidate runtime replay.",
    },
    skill: {
      skill_id: proposal.skillId,
      skill_action: "use_installed",
      skill_reason: "Candidate runtime replay execution.",
    },
  };
}

function mapReplayArtifact(artifact: Artifact) {
  return {
    type: artifact.type === "summary" ? "text" as const : artifact.type,
    path: artifact.path,
    content_preview: artifact.contentPreview,
  };
}

function buildReplayRoutePolicy(): RoutePolicy {
  return {
    type: "general",
    matchers: [],
    plannerInstruction: "Run candidate skill workflow replay with deterministic recorded evidence.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 0,
    requireArtifactReadback: false,
    requireNonEmptyArtifact: false,
    preferredTools: [],
    artifactPriority: [],
    completionChecklist: [],
    fallbackRule: "Do not replan during deployment validation replay.",
  };
}

function buildCandidateReplayDeps(baselineRecord: StoredJobRecord): Partial<RuntimeDeps> {
  const artifacts = baselineRecord.artifacts.map(mapReplayArtifact);
  return {
    runTask: async () => ({
      status: "completed",
      output: "Candidate workflow delegate task replayed against recorded baseline evidence.",
      verified: true,
      executorHistory: [{
        status: "success",
        summary: "Replay delegate task consumed recorded baseline evidence.",
        tool_calls_made: [],
        artifacts,
        raw_result: "deterministic_candidate_runtime_replay",
      }],
      job: baselineRecord.job,
      plan: baselineRecord.plan,
      taskRuns: baselineRecord.taskRuns,
      artifacts: baselineRecord.artifacts,
    }),
    runExecutorStep: async (_config, planner) => ({
      status: "success",
      summary: planner.executor_request?.expected_output ?? "Candidate workflow task replayed against recorded baseline evidence.",
      tool_calls_made: [],
      artifacts,
      raw_result: "deterministic_candidate_runtime_replay",
    }),
    runTeamSynthesis: async (_config, _goal, resultsText) => resultsText || "Candidate workflow synthesis replayed recorded baseline evidence.",
    runTeamDecomposition: async () => JSON.stringify({ tasks: [] }),
  };
}

export async function runCandidateRuntimeWorkflowReplay(input: {
  baseConfig: OrchestratorConfig;
  proposal: SkillEvolutionProposal;
  baselineRecord: StoredJobRecord;
}): Promise<{
  configPrepared: boolean;
  workflowMaterialized: boolean;
  workflowTaskCount: number;
  workflowExecuted: boolean;
  replayReady: boolean;
  status?: RunTaskResult["status"];
  verified?: boolean;
  artifactCount: number;
  taskRunCount: number;
  taskPayloads: SkillRuntimeReplayTaskPayload[];
  workflowStrategy?: string;
  runtimeSource: ReturnType<typeof buildCandidateReplayConfig>["runtimeSource"];
  reason: string;
}> {
  const replayRuntime = buildCandidateReplayConfig(input.baseConfig, input.proposal);
  if (!replayRuntime.runtimeSource.prepared) {
    return {
      configPrepared: false,
      workflowMaterialized: false,
      workflowTaskCount: 0,
      workflowExecuted: false,
      replayReady: false,
      artifactCount: 0,
      taskRunCount: 0,
      taskPayloads: [],
      runtimeSource: replayRuntime.runtimeSource,
      reason: replayRuntime.runtimeSource.note,
    };
  }

  const planner = buildCandidateReplayPlanner(input.proposal, input.baselineRecord);
  const workflow = materializeSkillWorkflow(replayRuntime.config, planner.goal, planner);
  if (!workflow) {
    return {
      configPrepared: true,
      workflowMaterialized: false,
      workflowTaskCount: 0,
      workflowExecuted: false,
      replayReady: false,
      artifactCount: 0,
      taskRunCount: 0,
      taskPayloads: [],
      runtimeSource: replayRuntime.runtimeSource,
      reason: "Candidate runtime config was prepared, but the candidate skill workflow could not be materialized.",
    };
  }

  const result = await runWorkflowPlan(
    replayRuntime.config,
    planner.goal,
    workflow,
    buildReplayRoutePolicy(),
    undefined,
    buildCandidateReplayDeps(input.baselineRecord),
    {
      jobId: `${input.proposal.id}__candidate_runtime_replay`,
      planId: `${input.proposal.id}__candidate_runtime_replay_plan`,
    },
  );
  const replayReady = result.status === "completed" && result.verified;
  return {
    configPrepared: true,
    workflowMaterialized: true,
    workflowTaskCount: workflow.tasks.length,
    workflowExecuted: true,
    replayReady,
    status: result.status,
    verified: result.verified,
    artifactCount: result.artifacts.length,
    taskRunCount: result.taskRuns.length,
    taskPayloads: result.taskRuns.map((taskRun) => ({
      taskRunId: taskRun.id,
      title: taskRun.title,
      status: taskRun.status,
      verified: taskRun.verified,
      artifactCount: taskRun.artifacts.length,
      attempts: taskRun.attempts,
      assignee: taskRun.assignee ?? null,
      dependsOn: [...taskRun.dependsOn],
      outputPreview: taskRun.output.slice(0, 240),
    })),
    workflowStrategy: workflow.strategy,
    runtimeSource: replayRuntime.runtimeSource,
    reason: replayReady
      ? `Candidate runtime workflow executed ${result.taskRuns.length} task(s) in deterministic replay mode.`
      : `Candidate runtime workflow executed but finished with status ${result.status}.`,
  };
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function collectArtifactEvidenceTags(record: StoredJobRecord): Set<string> {
  const tags = new Set<string>();
  for (const artifact of record.artifacts) {
    const combined = [
      artifact.id,
      artifact.path,
      artifact.type,
      artifact.contentPreview,
    ].map((item) => normalizeText(item)).join(" ");
    if (combined.includes("symbol") || combined.includes("entrypoint")) tags.add("symbol_hits");
    if (combined.includes("file") || combined.includes(".ts") || combined.includes(".js") || combined.includes("excerpt")) tags.add("file_excerpt");
    if (combined.includes("search") || combined.includes("source") || combined.includes("http")) tags.add("search_results");
    if (combined.includes("primary source") || combined.includes("official")) tags.add("primary_source_summary");
    if (combined.includes("workspace") || combined.includes("file hit")) tags.add("file_hits");
    if (combined.includes("config") || combined.includes("schema") || combined.includes(".json") || combined.includes(".yml") || combined.includes(".yaml")) tags.add("config_excerpt");
    if (combined.includes("integration") || combined.includes("endpoint") || combined.includes("api")) tags.add("integration_hits");
    if (combined.includes("call path") || combined.includes("boundary") || combined.includes("route")) tags.add("call_path_excerpt");
  }
  return tags;
}

function evaluateSuccessSignal(
  signal: string | undefined,
  evidenceTags: Set<string>,
  artifactCount: number,
): boolean {
  switch (signal) {
    case "at_least_one_relevant_entrypoint":
      return evidenceTags.has("symbol_hits") || evidenceTags.has("call_path_excerpt") || evidenceTags.has("integration_hits");
    case "at_least_two_non_empty_primary_sources":
      return artifactCount >= 2 && (evidenceTags.has("search_results") || evidenceTags.has("primary_source_summary"));
    case "at_least_one_relevant_workspace_target":
      return artifactCount >= 1 && (evidenceTags.has("file_hits") || evidenceTags.has("file_excerpt") || evidenceTags.has("config_excerpt"));
    case "at_least_one_relevant_integration_boundary":
      return evidenceTags.has("integration_hits") || evidenceTags.has("call_path_excerpt");
    default:
      return artifactCount > 0;
  }
}

function deriveRecordedSatisfiedArtifacts(
  record: StoredJobRecord,
  liveManifest: SkillManifest | null,
  candidateManifest: SkillManifest | null,
): Set<string> {
  const satisfied = new Set<string>();
  if (record.job.verificationResult?.status !== "verified") {
    return satisfied;
  }
  const liveRequiredArtifacts = new Set(liveManifest?.verification?.requiredArtifacts ?? []);
  const candidateRequiredArtifacts = new Set(candidateManifest?.verification?.requiredArtifacts ?? []);
  for (const item of liveRequiredArtifacts) {
    if (candidateRequiredArtifacts.has(item)) {
      satisfied.add(item);
    }
  }
  return satisfied;
}

export function runIsolatedSkillManifestReplay(input: {
  baselineRecord: StoredJobRecord;
  liveManifest: SkillManifest | null;
  candidateManifest: SkillManifest | null;
}): {
  baseline: {
    verificationResult: VerificationResult;
    missingRequirements: string[];
  };
  candidate: {
    verificationResult: VerificationResult;
    missingRequirements: string[];
  };
} | null {
  const { baselineRecord, liveManifest, candidateManifest } = input;
  if (!liveManifest || !candidateManifest) {
    return null;
  }

  const evidenceTags = collectArtifactEvidenceTags(baselineRecord);
  const artifactCount = baselineRecord.artifacts.length;
  const recordedSatisfiedArtifacts = deriveRecordedSatisfiedArtifacts(baselineRecord, liveManifest, candidateManifest);

  const evaluateManifest = (manifest: SkillManifest): {
    verificationResult: VerificationResult;
    missingRequirements: string[];
  } => {
    const requiredArtifacts = manifest.verification?.requiredArtifacts ?? [];
    const missingRequirements = requiredArtifacts.filter((item) => !recordedSatisfiedArtifacts.has(item) && !evidenceTags.has(item));
    const checks: VerificationCheck[] = [];
    checks.push({
      name: "artifact_presence",
      passed: missingRequirements.length === 0,
      status: missingRequirements.length === 0 ? "passed" : "insufficient",
      detail: missingRequirements.length === 0
        ? "Required skill artifacts are present for isolated replay."
        : `Missing required replay artifacts: ${missingRequirements.join(", ")}.`,
    });
    const successSignalPassed = evaluateSuccessSignal(manifest.verification?.successSignal, evidenceTags, artifactCount);
    checks.push({
      name: "acceptance_criteria",
      passed: successSignalPassed,
      status: successSignalPassed ? "passed" : "insufficient",
      detail: successSignalPassed
        ? "Recorded replay artifacts satisfy the manifest success signal."
        : `Recorded replay artifacts do not satisfy success signal ${manifest.verification?.successSignal ?? "default"}.`,
    });
    const passed = checks.every((check) => check.passed);
    return {
      verificationResult: {
        status: passed ? "verified" : "insufficient",
        summary: passed
          ? "Isolated manifest replay satisfied the skill verification contract."
          : "Isolated manifest replay did not satisfy the skill verification contract.",
        checks,
      },
      missingRequirements,
    };
  };

  return {
    baseline: evaluateManifest(liveManifest),
    candidate: evaluateManifest(candidateManifest),
  };
}

export function buildIsolatedSkillReplayContracts(input: {
  proposal: SkillEvolutionProposal;
  baselineRecord: StoredJobRecord;
  liveManifest: SkillManifest | null;
  candidateManifest: SkillManifest | null;
  manifestReplay: NonNullable<ReturnType<typeof runIsolatedSkillManifestReplay>>;
}): {
  baseline: {
    jobId: string;
    taskRunId: string;
    status: "completed" | "blocked";
    verificationStatus: VerificationResult["status"];
    artifactCount: number;
    stepSummary: SkillIsolatedReplayStepSummary;
    events: SkillIsolatedReplayEvent[];
  };
  candidate: {
    jobId: string;
    taskRunId: string;
    status: "completed" | "blocked";
    verificationStatus: VerificationResult["status"];
    artifactCount: number;
    stepSummary: SkillIsolatedReplayStepSummary;
    events: SkillIsolatedReplayEvent[];
  };
} {
  const baselineTaskRunId = `${input.proposal.id}__baseline_replay_task`;
  const candidateTaskRunId = `${input.proposal.id}__candidate_replay_task`;
  const baselineJobId = `${input.proposal.id}__baseline_replay`;
  const candidateJobId = `${input.proposal.id}__candidate_replay`;
  const buildReplay = (
    jobId: string,
    taskRunId: string,
    manifest: SkillManifest | null,
    verificationResult: VerificationResult,
    ): {
      jobId: string;
      taskRunId: string;
      status: "completed" | "blocked";
      verificationStatus: VerificationResult["status"];
      artifactCount: number;
      stepSummary: SkillIsolatedReplayStepSummary;
      events: SkillIsolatedReplayEvent[];
    } => {
    const verified = verificationResult.status === "verified";
    const events = buildIsolatedReplayEvents({
      taskRunId,
      manifest,
      artifactCount: input.baselineRecord.artifacts.length,
      verificationResult,
    });
    const stepSummary = buildIsolatedReplayStepSummary({
      events,
      manifest,
      artifactCount: input.baselineRecord.artifacts.length,
      verificationResult,
    });
    const taskRun = createTaskRunRecord({
      id: taskRunId,
      title: `Replay ${manifest?.title ?? manifest?.id ?? "skill"} verification`,
      description: `Isolated replay for ${manifest?.id ?? "unknown-skill"}`,
      status: "completed",
      verified,
      output: verificationResult.summary,
      artifacts: [...input.baselineRecord.artifacts],
      attempts: 1,
      verificationResult,
    });
    const plan = createPlanRecord({
      id: `${jobId}__plan`,
      goal: `Isolated replay for ${manifest?.id ?? "unknown-skill"}`,
      mode: "task",
      taskRunIds: [taskRun.id],
      summary: "Synthetic isolated replay verification plan.",
      selectedSkill: {
        skill_id: manifest?.id ?? input.proposal.skillId,
        skill_action: "use_installed",
        skill_reason: "Isolated replay validates the skill verification contract against recorded baseline artifacts.",
        skill_install_status: "installed",
      },
    });
    createJobRecord({
      id: jobId,
      goal: plan.goal,
      mode: "task",
      status: verified ? "completed" : "blocked",
      verified,
      output: verificationResult.summary,
      plan,
      taskRuns: [taskRun],
      artifacts: [...input.baselineRecord.artifacts],
      verificationResult,
      selectedSkill: plan.selectedSkill,
    });
    return {
      jobId,
      taskRunId,
      status: verified ? "completed" : "blocked",
      verificationStatus: verificationResult.status,
      artifactCount: input.baselineRecord.artifacts.length,
      stepSummary,
      events,
    };
  };

  return {
    baseline: buildReplay(baselineJobId, baselineTaskRunId, input.liveManifest, input.manifestReplay.baseline.verificationResult),
    candidate: buildReplay(candidateJobId, candidateTaskRunId, input.candidateManifest, input.manifestReplay.candidate.verificationResult),
  };
}

function buildIsolatedReplayEvents(input: {
  taskRunId: string;
  manifest: SkillManifest | null;
  artifactCount: number;
  verificationResult: VerificationResult;
}): SkillIsolatedReplayEvent[] {
  const requiredArtifacts = input.manifest?.verification?.requiredArtifacts ?? [];
  const failedChecks = input.verificationResult.checks.filter((check) => !check.passed).map((check) => check.name);
  const passedChecks = input.verificationResult.checks.filter((check) => check.passed).map((check) => check.name);
  const missingRequirements = extractMissingReplayRequirements(input.verificationResult);
  const terminalType = input.verificationResult.status === "verified"
    ? "replay_job_completed"
    : "replay_job_blocked";
  const terminalStatus = input.verificationResult.status === "verified" ? "completed" : "blocked";
  const basePayload = {
    taskRunId: input.taskRunId,
    replaySource: "recorded_baseline_artifacts" as const,
    manifestId: input.manifest?.id,
    manifestTitle: input.manifest?.title,
  };

  return [
    {
      seq: 1,
      type: "replay_job_created",
      step: "prepare",
      status: "running",
      summary: `Created isolated replay job for ${input.manifest?.id ?? "unknown-skill"}.`,
      detail: "Replay contract was synthesized from the proposal snapshot and recorded baseline job.",
      stepPayload: {
        ...basePayload,
        requiredArtifactCount: requiredArtifacts.length,
        checkCount: input.verificationResult.checks.length,
      },
    },
    {
      seq: 2,
      type: "artifacts_loaded",
      step: "prepare",
      status: "completed",
      summary: `Loaded ${input.artifactCount} recorded artifact(s) from the baseline job.`,
      detail: "The isolated replay reuses recorded baseline artifacts as deterministic evidence input.",
      stepPayload: {
        ...basePayload,
        artifactCount: input.artifactCount,
      },
    },
    {
      seq: 3,
      type: "manifest_resolved",
      step: "manifest",
      status: input.manifest ? "completed" : "blocked",
      summary: input.manifest
        ? `Resolved manifest ${input.manifest.id} for isolated replay verification.`
        : "Manifest could not be resolved for isolated replay verification.",
      detail: input.manifest
        ? `Verification requires ${requiredArtifacts.length} artifact contract item(s).`
        : "Replay cannot map verification requirements because the manifest is unavailable.",
      stepPayload: {
        ...basePayload,
        requiredArtifacts,
        requiredArtifactCount: requiredArtifacts.length,
      },
    },
    {
      seq: 4,
      type: "verification_started",
      step: "verification",
      status: "running",
      summary: "Started isolated manifest verification against recorded baseline artifacts.",
      detail: `Evaluating ${input.verificationResult.checks.length} verification check(s).`,
      stepPayload: {
        ...basePayload,
        artifactCount: input.artifactCount,
        checkCount: input.verificationResult.checks.length,
        requiredArtifactCount: requiredArtifacts.length,
      },
    },
    {
      seq: 5,
      type: "checks_evaluated",
      step: "verification",
      status: input.verificationResult.status === "verified" ? "completed" : "blocked",
      summary: input.verificationResult.status === "verified"
        ? "All isolated replay verification checks passed."
        : `Isolated replay left verification gaps in ${failedChecks.join(", ") || "unknown_check"}.`,
      detail: input.verificationResult.summary,
      verificationStatus: input.verificationResult.status,
      stepPayload: {
        ...basePayload,
        checkCount: input.verificationResult.checks.length,
        passedCheckNames: passedChecks,
        failedCheckNames: failedChecks,
        missingRequirements,
      },
    },
    {
      seq: 6,
      type: "verification_completed",
      step: "verification",
      status: terminalStatus,
      summary: input.verificationResult.status === "verified"
        ? "Isolated replay verification completed successfully."
        : "Isolated replay verification completed with insufficient evidence.",
      detail: input.verificationResult.summary,
      verificationStatus: input.verificationResult.status,
      stepPayload: {
        ...basePayload,
        checkCount: input.verificationResult.checks.length,
        passedCheckNames: passedChecks,
        failedCheckNames: failedChecks,
        missingRequirements,
      },
    },
    {
      seq: 7,
      type: terminalType,
      step: "complete",
      status: terminalStatus,
      summary: input.verificationResult.status === "verified"
        ? "Replay job completed with a verified terminal state."
        : "Replay job stopped in a blocked terminal state.",
      detail: input.verificationResult.summary,
      verificationStatus: input.verificationResult.status,
      stepPayload: {
        ...basePayload,
        terminal: true,
        artifactCount: input.artifactCount,
        checkCount: input.verificationResult.checks.length,
        passedCheckNames: passedChecks,
        failedCheckNames: failedChecks,
        missingRequirements,
      },
    },
  ];
}

function extractMissingReplayRequirements(verificationResult: VerificationResult): string[] {
  return verificationResult.checks
    .filter((check) => !check.passed && check.name === "artifact_presence")
    .flatMap((check) => {
      const marker = "Missing required replay artifacts: ";
      return check.detail.startsWith(marker)
        ? check.detail.slice(marker.length).replace(/\.$/u, "").split(", ").filter(Boolean)
        : [];
    });
}

function buildIsolatedReplayStepSummary(input: {
  events: SkillIsolatedReplayEvent[];
  manifest: SkillManifest | null;
  artifactCount: number;
  verificationResult: VerificationResult;
}): SkillIsolatedReplayStepSummary {
  const failedChecks = input.verificationResult.checks.filter((check) => !check.passed).map((check) => check.name);
  const missingRequirements = extractMissingReplayRequirements(input.verificationResult);
  const terminalEvent = input.events.at(-1);
  const completedSteps = input.events.filter((event) => event.status === "completed").length;
  const blockedSteps = input.events.filter((event) => event.status === "blocked").length;
  const verificationSteps = input.events.filter((event) => event.step === "verification").length;

  return {
    replaySource: "recorded_baseline_artifacts",
    totalSteps: input.events.length,
    completedSteps,
    blockedSteps,
    verificationSteps,
    evidenceArtifactCount: input.artifactCount,
    requiredArtifactCount: input.manifest?.verification?.requiredArtifacts?.length ?? 0,
    failedChecks,
    missingRequirements,
    terminalEventType: terminalEvent?.type ?? "replay_job_blocked",
    terminalStatus: terminalEvent?.status ?? "blocked",
    summary: input.verificationResult.status === "verified"
      ? `Replay step evidence completed ${completedSteps} step(s) using ${input.artifactCount} recorded artifact(s).`
      : `Replay step evidence blocked ${blockedSteps} step(s); failed checks: ${failedChecks.join(", ") || "unknown_check"}.`,
  };
}
