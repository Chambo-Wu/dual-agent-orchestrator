import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { getSkillEvolutionProposalCandidateRoot } from "./skill-evolution-store.js";
import {
  evaluateSkillMarkdownPatchPolicy,
  hasRiskyManifestEscalation,
  isReflectionToPatchConsistent,
} from "./skill-evolution-policy.js";
import type { StoredJobRecord } from "./job-store.js";
import { buildCandidateReplayConfig, buildIsolatedSkillReplayContracts, probeCandidateRuntimeWorkflow, runCandidateRuntimeWorkflowReplay, runIsolatedSkillManifestReplay } from "./skill-replay-runtime.js";
import type {
  SkillDeploymentValidationReport,
  SkillEvolutionProposal,
  SkillReflectionRecord,
} from "./skill-evolution-types.js";
import type { SkillManifest } from "./skill-types.js";
import type { OrchestratorConfig } from "./types.js";

type CandidateRuntimeWorkflowReplayResult = Awaited<ReturnType<typeof runCandidateRuntimeWorkflowReplay>>;

function safeReadManifest(path: string): SkillManifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
  } catch {
    return null;
  }
}

function resolveCandidateManifestPath(proposal: SkillEvolutionProposal): string | null {
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  const target = proposal.targetFiles.find((item) => item.endsWith("/skill.json") || item.endsWith("\\skill.json"));
  if (!target) {
    return null;
  }
  const path = resolve(candidateRoot, target);
  return existsSync(path) ? path : null;
}

function resolveLiveManifestPath(proposal: SkillEvolutionProposal): string | null {
  const target = proposal.targetFiles.find((item) => item.endsWith("/skill.json") || item.endsWith("\\skill.json"));
  if (!target) {
    return null;
  }
  const path = resolve(PROJECT_ROOT, target);
  return existsSync(path) ? path : null;
}

function countVerificationSignals(manifest: SkillManifest | null): number {
  if (!manifest?.verification) {
    return 0;
  }
  let count = 0;
  if (Array.isArray(manifest.verification.requiredArtifacts)) {
    count += manifest.verification.requiredArtifacts.length;
  }
  if (manifest.verification.successSignal) {
    count += 1;
  }
  if (manifest.verification.artifactLabels) {
    count += Object.keys(manifest.verification.artifactLabels).length;
  }
  if (manifest.verification.successSignalLabel) {
    count += 1;
  }
  if (manifest.verification.remediation?.insufficient) {
    count += 1;
  }
  if (manifest.verification.remediation?.failed) {
    count += 1;
  }
  return count;
}

function normalizeManifestDescription(description: string | undefined): string {
  return (description ?? "")
    .replace(/\s*\[Auto-evolve [^\]]+\]\s*$/u, "")
    .trim();
}

function resolveValidationRiskProfile(candidate: SkillManifest | null, live: SkillManifest | null): SkillDeploymentValidationReport["risk"] {
  const intents = new Set([
    ...(candidate?.intents ?? []),
    ...(live?.intents ?? []),
  ]);
  const codingLike = intents.has("coding") || intents.has("file_ops");
  if (codingLike) {
    return {
      tier: "high",
      skillClass: "coding_like",
      summary: "High-risk coding-like skill: validation should prioritize non-regression over weak improvement signals.",
      acceptanceFocus: "non_regression",
    };
  }
  return {
    tier: "low",
    skillClass: "research_like",
    summary: "Low-risk research-like skill: validation can accept lighter improvement signals once execution evidence is clear.",
    acceptanceFocus: "improvement",
  };
}

function buildStabilitySignals(input: {
  baselineSource: SkillDeploymentValidationReport["contract"]["baselineSelection"]["source"];
  baselineVerified: boolean;
  improving: boolean;
  candidateSelected: boolean;
  silentBypassSignal: boolean;
  risk: SkillDeploymentValidationReport["risk"];
  trueRuntimeReplayReady: boolean;
  sameInputReadiness: SkillDeploymentValidationReport["replay"]["sameInputComparison"]["readiness"];
  executionEvidenceLevel: SkillDeploymentValidationReport["replay"]["provenance"]["executionEvidence"]["level"];
}): SkillDeploymentValidationReport["stability"] {
  const reasons: string[] = [];
  const replayInstabilityDetected = input.baselineSource !== "source_reflection_job";
  if (replayInstabilityDetected) {
    reasons.push("Baseline replay provenance is incomplete, so repeated validation may be unstable.");
  }

  const candidateFlakySignal = input.candidateSelected
    && !input.silentBypassSignal
    && !input.baselineVerified
    && input.improving
    && input.risk.acceptanceFocus === "improvement";
  if (candidateFlakySignal) {
    reasons.push("Candidate improvement currently relies on lightweight heuristic signals and may be flaky before isolated replay exists.");
  }

  let replayStabilityScore = 100;
  if (replayInstabilityDetected) replayStabilityScore -= 30;
  if (candidateFlakySignal) replayStabilityScore -= 25;
  if (!input.trueRuntimeReplayReady) replayStabilityScore -= 25;
  if (input.sameInputReadiness !== "ready") replayStabilityScore -= input.sameInputReadiness === "needs_replay" ? 15 : 30;
  if (input.executionEvidenceLevel !== "direct") replayStabilityScore -= input.executionEvidenceLevel === "partial" ? 15 : 30;
  replayStabilityScore = Math.max(0, Math.min(100, replayStabilityScore));
  const replayStabilityLevel: SkillDeploymentValidationReport["stability"]["replayStabilityLevel"] = replayStabilityScore >= 80
    ? "stable"
    : replayStabilityScore >= 50
      ? "watch"
      : "unstable";

  return {
    replayInstabilityDetected,
    candidateFlakySignal,
    autoAcceptBlocked: replayInstabilityDetected || candidateFlakySignal,
    replayStabilityScore,
    replayStabilityLevel,
    reasons,
  };
}

function buildBaselineSelectionContract(
  proposal: SkillEvolutionProposal,
  reflection: SkillReflectionRecord | null,
  baselineRecord?: StoredJobRecord | null,
): SkillDeploymentValidationReport["contract"]["baselineSelection"] {
  if (baselineRecord?.job.id) {
    return {
      source: "source_reflection_job",
      jobId: baselineRecord.job.id,
      reflectionId: reflection?.id,
      reason: `Baseline uses the persisted source job recorded for reflection ${reflection?.id ?? proposal.sourceReflectionId}.`,
    };
  }
  if (reflection?.jobId) {
    return {
      source: "reflection_only",
      jobId: reflection.jobId,
      reflectionId: reflection.id,
      reason: `Baseline falls back to reflection ${reflection.id} because the full job record is unavailable.`,
    };
  }
  return {
    source: "none",
    reflectionId: reflection?.id ?? proposal.sourceReflectionId,
    reason: "No baseline job provenance is available for this validation run.",
  };
}

function resolveBaselineSelectedSkill(
  baselineRecord: StoredJobRecord | null | undefined,
  reflection: SkillReflectionRecord | null,
): {
  selectedSkillId: string | null;
  source: SkillDeploymentValidationReport["replay"]["provenance"]["baselineSelectedSkillSource"];
} {
  const jobSelectedSkillId = baselineRecord?.job.selectedSkill?.skill_id;
  if (typeof jobSelectedSkillId === "string" && jobSelectedSkillId.trim().length > 0) {
    return {
      selectedSkillId: jobSelectedSkillId,
      source: "job_selected_skill",
    };
  }
  const planSelectedSkillId = baselineRecord?.plan.selectedSkill?.skill_id;
  if (typeof planSelectedSkillId === "string" && planSelectedSkillId.trim().length > 0) {
    return {
      selectedSkillId: planSelectedSkillId,
      source: "plan_selected_skill",
    };
  }
  if (typeof reflection?.skillId === "string" && reflection.skillId.trim().length > 0) {
    return {
      selectedSkillId: reflection.skillId,
      source: "reflection_record",
    };
  }
  return {
    selectedSkillId: null,
    source: "unavailable",
  };
}

function resolveCandidateSelectedSkill(
  candidateManifest: SkillManifest | null,
  reflection: SkillReflectionRecord | null,
): {
  selectedSkillId: string | null;
  source: SkillDeploymentValidationReport["replay"]["provenance"]["candidateSelectedSkillSource"];
} {
  if (typeof candidateManifest?.id === "string" && candidateManifest.id.trim().length > 0) {
    return {
      selectedSkillId: candidateManifest.id,
      source: "candidate_manifest",
    };
  }
  if (typeof reflection?.skillId === "string" && reflection.skillId.trim().length > 0) {
    return {
      selectedSkillId: reflection.skillId,
      source: "reflection_record",
    };
  }
  return {
    selectedSkillId: null,
    source: "unavailable",
  };
}

function buildCandidateBindingEvidence(input: {
  proposal: SkillEvolutionProposal;
  reflection: SkillReflectionRecord | null;
  candidateManifest: SkillManifest | null;
  changedFiles: string[];
  replayRuntimePrepared: boolean;
  candidateSelectedSkillId: string | null;
  risky: boolean;
}): SkillDeploymentValidationReport["replay"]["provenance"]["candidateBinding"] {
  const reasons: string[] = [];
  const manifestPresent = Boolean(input.candidateManifest);
  if (!manifestPresent) {
    reasons.push("Candidate manifest is missing from the proposal snapshot.");
  }
  if (!input.replayRuntimePrepared) {
    reasons.push("Candidate replay runtime config was not prepared for this validation run.");
  }
  if (input.proposal.targetFiles.length === 0) {
    reasons.push("Proposal does not declare any target files to bind into the candidate snapshot.");
  }
  const selectedSkillMatchesProposal = input.candidateSelectedSkillId === input.proposal.skillId;
  if (!selectedSkillMatchesProposal) {
    reasons.push("Candidate selected skill id does not match the proposal skill id.");
  }
  const selectedSkillMatchesReflection = input.reflection?.skillId
    ? input.candidateSelectedSkillId === input.reflection.skillId
    : false;
  if (input.reflection?.skillId && !selectedSkillMatchesReflection) {
    reasons.push("Candidate selected skill id does not match the reflection skill id.");
  }
  if (input.risky) {
    reasons.push("Candidate binding crosses the current validation safety boundary.");
  }

  return {
    manifestPresent,
    runtimePrepared: input.replayRuntimePrepared,
    targetFileCount: input.proposal.targetFiles.length,
    changedFileCount: input.changedFiles.length,
    selectedSkillMatchesProposal,
    selectedSkillMatchesReflection,
    bindingReady: manifestPresent
      && input.replayRuntimePrepared
      && input.proposal.targetFiles.length > 0
      && selectedSkillMatchesProposal
      && !input.risky,
    reasons,
  };
}

function buildExecutionEvidence(input: {
  reflection: SkillReflectionRecord | null;
  candidateManifest: SkillManifest | null;
  changedFiles: string[];
  candidateVerified: boolean;
  silentBypassSignal: boolean;
  candidateReplayEventCount: number;
  candidateReplayTerminalEventType: string | null;
}): SkillDeploymentValidationReport["replay"]["provenance"]["executionEvidence"] {
  const reflectionEventIds = [...(input.reflection?.evidence.eventIds ?? [])];
  const reflectionArtifactIds = [...(input.reflection?.evidence.artifactIds ?? [])];
  const baselineHadArtifacts = reflectionArtifactIds.length > 0;
  const candidateManifestPresent = Boolean(input.candidateManifest);
  const level = input.candidateVerified && !input.silentBypassSignal && candidateManifestPresent
    ? "direct"
    : candidateManifestPresent && (input.changedFiles.length > 0 || reflectionEventIds.length > 0 || baselineHadArtifacts)
      ? "partial"
      : "weak";
  const summary = level === "direct"
    ? `Validation has direct candidate execution evidence via a bound candidate manifest, concrete reflection evidence, and a verified candidate outcome${input.candidateReplayEventCount > 0 ? ` with ${input.candidateReplayEventCount} isolated replay event(s) ending at ${input.candidateReplayTerminalEventType ?? "a terminal state"}` : ""}.`
    : level === "partial"
      ? `Validation has partial execution evidence from reflection artifacts/events and the candidate snapshot${input.candidateReplayEventCount > 0 ? `, plus ${input.candidateReplayEventCount} isolated replay event(s)` : ""}, but isolated replay proof is still incomplete.`
      : "Validation has only weak execution evidence because the candidate binding or reflection evidence is incomplete.";

  return {
    reflectionEventIds,
    reflectionArtifactIds,
    baselineHadArtifacts,
    silentBypassSignal: input.silentBypassSignal,
    candidateManifestPresent,
    candidateChangedFiles: input.changedFiles,
    candidateVerified: input.candidateVerified,
    level,
    summary,
  };
}

function buildSameInputComparison(input: {
  baselineJobAvailable: boolean;
  candidateRuntimePrepared: boolean;
  trueRuntimeReplayReady: boolean;
  inputAligned: boolean;
  baselineSelectedSkillId: string | null;
  candidateSelectedSkillId: string | null;
  proposalSkillId: string;
  baselineVerified: boolean;
  candidateVerified: boolean;
  baselineArtifactCount: number;
  candidateArtifactCount: number;
  baselineFailedChecks: string[];
  candidateFailedChecks: string[];
  baselineMissingRequirements: string[];
  candidateMissingRequirements: string[];
  executionEvidenceLevel: SkillDeploymentValidationReport["replay"]["provenance"]["executionEvidence"]["level"];
  candidateBindingReady: boolean;
  silentBypassSignal: boolean;
}): SkillDeploymentValidationReport["replay"]["sameInputComparison"] {
  const mode = input.baselineJobAvailable && input.candidateRuntimePrepared
    ? "baseline_job_vs_candidate_runtime"
    : "recorded_baseline_vs_candidate";
  const baselineSelected = input.baselineSelectedSkillId === input.proposalSkillId;
  const candidateSelected = input.candidateSelectedSkillId === input.proposalSkillId;
  const baselineObserved = input.inputAligned && baselineSelected;
  const candidateObserved = input.inputAligned && candidateSelected && input.candidateBindingReady;
  const artifactDelta = input.candidateArtifactCount - input.baselineArtifactCount;
  const failedChecksDelta = input.candidateFailedChecks.length - input.baselineFailedChecks.length;
  const baselineMissingSet = new Set(input.baselineMissingRequirements);
  const candidateMissingSet = new Set(input.candidateMissingRequirements);
  const resolvedMissingRequirements = input.baselineMissingRequirements.filter((item) => !candidateMissingSet.has(item));
  const remainingMissingRequirements = input.candidateMissingRequirements.filter((item) => baselineMissingSet.has(item));
  const introducedMissingRequirements = input.candidateMissingRequirements.filter((item) => !baselineMissingSet.has(item));

  const readiness = !input.inputAligned || !baselineObserved || !candidateObserved || input.silentBypassSignal
    ? "blocked"
    : mode === "baseline_job_vs_candidate_runtime" && input.trueRuntimeReplayReady && input.executionEvidenceLevel === "direct" && input.candidateVerified
      ? "ready"
      : "needs_replay";
  const summary = readiness === "ready"
    ? "Baseline job evidence and candidate runtime evidence are aligned on the same recorded input, and the comparison result is strong enough for readiness-sensitive decisions."
    : readiness === "needs_replay"
      ? mode === "baseline_job_vs_candidate_runtime"
        ? "Baseline job evidence and candidate runtime preparation are aligned, but true candidate runtime replay is not enabled yet."
        : "Baseline and candidate can be compared on the same recorded input, but stronger replay evidence is still needed before readiness-sensitive decisions."
      : "Baseline/candidate same-input comparison is blocked because alignment, binding, or execution evidence is still incomplete.";

  return {
    mode,
    inputAligned: input.inputAligned,
    baselineObserved,
    candidateObserved,
    baselineSelected,
    candidateSelected,
    baselineVerified: input.baselineVerified,
    candidateVerified: input.candidateVerified,
    artifactDelta,
    failedChecksDelta,
    resolvedMissingRequirements,
    remainingMissingRequirements,
    introducedMissingRequirements,
    evidenceLevel: input.executionEvidenceLevel,
    readiness,
    summary,
  };
}

function candidateLooksImproving(
  proposal: SkillEvolutionProposal,
  reflection: SkillReflectionRecord | null,
  candidate: SkillManifest | null,
  live: SkillManifest | null,
): boolean {
  if (!candidate) {
    return false;
  }
  const candidateSignalCount = countVerificationSignals(candidate);
  const liveSignalCount = countVerificationSignals(live);
  const changedDescription = normalizeManifestDescription(candidate.description) !== normalizeManifestDescription(live?.description);
  const changedRemediation = JSON.stringify(candidate.verification?.remediation ?? {}) !== JSON.stringify(live?.verification?.remediation ?? {});
  const changedRequiredArtifacts = JSON.stringify(candidate.verification?.requiredArtifacts ?? []) !== JSON.stringify(live?.verification?.requiredArtifacts ?? []);

  if (reflection?.recommendedAction === "append_appendix") {
    return proposal.targetFiles.some((target) => target.endsWith("SKILL.md")) || changedDescription;
  }
  if (reflection?.recommendedAction === "patch_body") {
    return changedDescription || changedRemediation || candidateSignalCount > liveSignalCount;
  }
  if (reflection?.recommendedAction === "patch_verification") {
    return changedRemediation || changedRequiredArtifacts || candidateSignalCount > liveSignalCount;
  }
  return changedDescription || changedRemediation || changedRequiredArtifacts || candidateSignalCount > liveSignalCount;
}

function buildValidationResultTaxonomy(input: {
  passed: boolean;
  candidateSelected: boolean;
  candidateVerified: boolean;
  baselineVerified: boolean;
  inputEquivalent: boolean;
  candidateBindingReady: boolean;
  runtimePrepared: boolean;
  runtimeBoundary: SkillDeploymentValidationReport["replay"]["runtimeBoundary"];
  sameInputReadiness: SkillDeploymentValidationReport["replay"]["sameInputComparison"]["readiness"];
  candidateFailedChecks: string[];
  baselineFailedChecks: string[];
  candidateMissingRequirements: string[];
}): SkillDeploymentValidationReport["resultTaxonomy"] {
  if (input.passed) {
    return {
      category: "passed",
      reason: "Candidate passed validation under the current non-regression and improvement contract.",
      retryable: false,
    };
  }
  if (!input.runtimePrepared || !input.candidateBindingReady || !input.inputEquivalent) {
    return {
      category: "setup_failed",
      reason: "Validation setup is incomplete: candidate runtime binding, runtime preparation, or same-input provenance is missing.",
      retryable: true,
    };
  }
  if (!input.baselineVerified) {
    return {
      category: "baseline_failed",
      reason: "Baseline evidence is not verified, so candidate improvement cannot be judged cleanly.",
      retryable: true,
    };
  }
  if (!input.candidateSelected || !input.candidateVerified || input.candidateMissingRequirements.length > 0) {
    return {
      category: "candidate_failed",
      reason: "Candidate failed verification or did not satisfy required evidence.",
      retryable: true,
    };
  }
  if (input.candidateFailedChecks.length > input.baselineFailedChecks.length) {
    return {
      category: "regression",
      reason: "Candidate introduced more failed checks than the baseline.",
      retryable: false,
    };
  }
  if (input.sameInputReadiness !== "ready" || !input.runtimeBoundary.trueRuntimeReplayReady) {
    return {
      category: "inconclusive",
      reason: "Validation could not reach ready same-input runtime replay evidence.",
      retryable: true,
    };
  }
  return {
    category: "inconclusive",
    reason: "Validation failed without a more specific result category.",
    retryable: true,
  };
}

export function validateSkillEvolutionProposal(input: {
  proposal: SkillEvolutionProposal;
  reflection: SkillReflectionRecord | null;
  baselineRecord?: StoredJobRecord | null;
  config?: OrchestratorConfig;
  candidateRuntimeReplay?: CandidateRuntimeWorkflowReplayResult | null;
}): SkillDeploymentValidationReport {
  const { proposal, reflection, baselineRecord, config } = input;
  const candidateRuntimeReplay = input.candidateRuntimeReplay ?? null;
  const reflectedBaselineVerified = reflection?.evidence.verificationStatus === "verified";
  const reflectedBaselineFailedChecks = [...(reflection?.evidence.failedCheckNames ?? [])];
  const reflectedBaselineArtifactCount = reflection?.evidence.artifactIds.length ?? 0;
  const reflectedBaselineMissingRequirements = [...(reflection?.evidence.missingRequirements ?? [])];
  const silentBypassSignal = reflection?.evidence.silentBypassSignal === true;
  const candidateManifest = safeReadManifest(resolveCandidateManifestPath(proposal) ?? "");
  const liveManifest = safeReadManifest(resolveLiveManifestPath(proposal) ?? "");
  const replayRuntime = config ? buildCandidateReplayConfig(config, proposal) : null;
  const runtimeProbe = config ? probeCandidateRuntimeWorkflow({ baseConfig: config, proposal, baselineRecord }) : null;
  const isolatedReplay = baselineRecord && replayRuntime?.runtimeSource.prepared
    ? runIsolatedSkillManifestReplay({
      baselineRecord,
      liveManifest,
      candidateManifest,
    })
    : null;
  const isolatedReplayContracts = baselineRecord && isolatedReplay
    ? buildIsolatedSkillReplayContracts({
      proposal,
      baselineRecord,
      liveManifest,
      candidateManifest,
      manifestReplay: isolatedReplay,
    })
    : null;
  const baselineVerified = isolatedReplay
    ? isolatedReplay.baseline.verificationResult.status === "verified"
    : (baselineRecord?.job.verificationResult?.status === "verified" || reflectedBaselineVerified);
  const baselineFailedChecks = isolatedReplay?.baseline.verificationResult.checks.filter((check) => !check.passed).map((check) => check.name)
    ?? baselineRecord?.job.verificationResult?.checks?.filter((check) => !check.passed).map((check) => check.name)
    ?? reflectedBaselineFailedChecks;
  const baselineArtifactCount = baselineRecord?.artifacts.length ?? reflectedBaselineArtifactCount;
  const baselineMissingRequirements = isolatedReplay?.baseline.missingRequirements
    ?? reflectedBaselineMissingRequirements;
  const risk = resolveValidationRiskProfile(candidateManifest, liveManifest);
  const changedFiles = proposal.targetFiles.filter((targetFile) => {
    const candidatePath = resolve(getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir), targetFile);
    const livePath = resolve(PROJECT_ROOT, targetFile);
    if (!existsSync(candidatePath)) {
      return false;
    }
    const candidateContent = readFileSync(candidatePath, "utf8");
    const liveContent = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
    return candidateContent !== liveContent;
  });
  const candidateMarkdownPath = proposal.targetFiles.find((targetFile) => targetFile.endsWith("/SKILL.md") || targetFile.endsWith("\\SKILL.md"))
    ? resolve(getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir), proposal.targetFiles.find((targetFile) => targetFile.endsWith("/SKILL.md") || targetFile.endsWith("\\SKILL.md"))!)
    : null;
  const liveMarkdownPath = proposal.targetFiles.find((targetFile) => targetFile.endsWith("/SKILL.md") || targetFile.endsWith("\\SKILL.md"))
    ? resolve(PROJECT_ROOT, proposal.targetFiles.find((targetFile) => targetFile.endsWith("/SKILL.md") || targetFile.endsWith("\\SKILL.md"))!)
    : null;
  const markdownSectionPolicy = evaluateSkillMarkdownPatchPolicy({
    reflection,
    liveMarkdown: liveMarkdownPath && existsSync(liveMarkdownPath) ? readFileSync(liveMarkdownPath, "utf8") : "",
    candidateMarkdown: candidateMarkdownPath && existsSync(candidateMarkdownPath) ? readFileSync(candidateMarkdownPath, "utf8") : "",
  });
  const verificationTouched = JSON.stringify(candidateManifest?.verification ?? null) !== JSON.stringify(liveManifest?.verification ?? null);
  const reflectionPolicyReady = isReflectionToPatchConsistent({
    reflection,
    verificationTouched,
  });
  const runtimeBoundary: SkillDeploymentValidationReport["replay"]["runtimeBoundary"] = {
    source: candidateRuntimeReplay?.workflowExecuted
      ? "candidate_runtime_config"
      : isolatedReplay
      ? "isolated_manifest_replay"
      : replayRuntime?.runtimeSource.prepared
        ? "candidate_runtime_config"
        : "candidate_snapshot",
    contract: candidateRuntimeReplay?.workflowExecuted
      ? "true_candidate_runtime_replay"
      : runtimeProbe?.workflowMaterialized
      ? "candidate_runtime_workflow_materialized"
      : "manifest_replay_only",
    stage: candidateRuntimeReplay?.workflowExecuted
      ? "executed"
      : runtimeProbe?.workflowMaterialized
      ? "workflow_materialized"
      : replayRuntime?.runtimeSource.prepared
        ? "config_prepared"
        : "snapshot_only",
    candidateRuntimeConfigPrepared: replayRuntime?.runtimeSource.prepared === true,
    candidateWorkflowMaterialized: candidateRuntimeReplay?.workflowMaterialized === true || runtimeProbe?.workflowMaterialized === true,
    candidateWorkflowTaskCount: candidateRuntimeReplay?.workflowTaskCount ?? runtimeProbe?.workflowTaskCount ?? 0,
    trueRuntimeReplayEnabled: candidateRuntimeReplay?.workflowExecuted === true,
    trueRuntimeReplayReady: candidateRuntimeReplay?.replayReady === true,
    autoAcceptEligible: candidateRuntimeReplay?.replayReady === true,
    reason: candidateRuntimeReplay
      ? candidateRuntimeReplay.reason
      : isolatedReplay
      ? runtimeProbe?.workflowMaterialized
        ? `${runtimeProbe.reason} Validation also executed isolated manifest replay against recorded baseline artifacts, but did not execute the candidate workflow tasks.`
        : "Validation executed isolated manifest replay against recorded baseline artifacts; it did not execute the candidate through the full runtime."
      : replayRuntime?.runtimeSource.prepared
        ? runtimeProbe?.reason ?? "Candidate runtime config can be prepared, but true candidate runtime replay is not enabled in the validator."
        : "Validation is limited to the candidate snapshot because candidate runtime config was not prepared.",
  };

  const risky = hasRiskyManifestEscalation(candidateManifest, liveManifest);
  const improving = candidateLooksImproving(proposal, reflection, candidateManifest, liveManifest);
  const candidateSelected = !risky && !!candidateManifest && proposal.targetFiles.length > 0;
  const candidateVerified = isolatedReplay
    ? candidateSelected && !silentBypassSignal && isolatedReplay.candidate.verificationResult.status === "verified"
    : candidateSelected && !silentBypassSignal && (baselineVerified || improving);
  const baselineSelection = buildBaselineSelectionContract(proposal, reflection, baselineRecord);
  const inputEquivalence = {
    mode: "same_recorded_input" as const,
    satisfied: baselineSelection.source !== "none",
    reason: baselineSelection.source === "source_reflection_job"
      ? "Baseline and candidate are interpreted against the same recorded source job."
      : baselineSelection.source === "reflection_only"
        ? "Validation falls back to reflection evidence, so same-input is inferred rather than fully replayed."
        : "Validation cannot prove baseline/candidate input equivalence because baseline provenance is missing.",
  };
  const hardGates: SkillDeploymentValidationReport["contract"]["hardGates"] = [
    {
      name: "candidate_selected",
      passed: candidateSelected,
      detail: candidateSelected
        ? "Candidate manifest is present and does not trigger the current risk escalation heuristic."
        : "Candidate is incomplete or escalates beyond the current validation safety boundary.",
    },
    {
      name: "same_recorded_input",
      passed: inputEquivalence.satisfied,
      detail: inputEquivalence.reason,
    },
    {
      name: "candidate_runtime_prepared",
      passed: replayRuntime?.runtimeSource.prepared === true,
      detail: !config
        ? "Candidate replay runtime config is unavailable because no orchestrator config was provided."
        : replayRuntime?.runtimeSource.prepared
          ? "Candidate replay runtime config can be derived from the current orchestrator config."
          : replayRuntime?.runtimeSource.note ?? "Candidate replay runtime config could not be prepared.",
    },
    {
      name: "true_candidate_runtime_replay_enabled",
      passed: runtimeBoundary.trueRuntimeReplayReady,
      detail: runtimeBoundary.reason,
    },
    {
      name: "silent_bypass_absent",
      passed: !silentBypassSignal,
      detail: silentBypassSignal
        ? "Reflection evidence indicates the selected skill lacked concrete execution evidence."
        : "No silent bypass signal is present in the reflection evidence.",
    },
  ];

  const candidateFailedChecks = candidateVerified
    ? baselineVerified
      ? baselineFailedChecks
      : baselineFailedChecks.slice(0, Math.max(0, baselineFailedChecks.length - 1))
    : baselineFailedChecks;
  const candidateArtifactCount = candidateRuntimeReplay?.workflowExecuted
    ? Math.max(baselineArtifactCount, candidateRuntimeReplay.artifactCount, countVerificationSignals(candidateManifest))
    : candidateVerified
    ? Math.max(
        baselineArtifactCount,
        baselineArtifactCount + (improving ? 1 : 0),
        countVerificationSignals(candidateManifest),
      )
    : baselineArtifactCount;
  const riskSatisfied = risk.acceptanceFocus === "non_regression"
    ? baselineVerified
      ? candidateFailedChecks.length <= baselineFailedChecks.length
      : candidateFailedChecks.length < baselineFailedChecks.length
    : candidateVerified && (candidateArtifactCount > baselineArtifactCount || candidateFailedChecks.length < baselineFailedChecks.length);
  hardGates.push({
    name: "risk_tier_contract",
    passed: riskSatisfied,
    detail: risk.acceptanceFocus === "non_regression"
      ? "High-risk skills require non-regression against the baseline."
      : "Low-risk skills require at least one credible improvement signal once execution evidence is present.",
  });

  const passed = candidateSelected
    && !silentBypassSignal
    && inputEquivalence.satisfied
    && candidateVerified
    && reflectionPolicyReady
    && markdownSectionPolicy.policyReady
    && riskSatisfied;

  const reasonCode = !candidateSelected
    ? "candidate_not_selected"
    : silentBypassSignal
      ? "silent_bypass"
      : !reflectionPolicyReady
        ? "candidate_not_verified"
      : !markdownSectionPolicy.policyReady
        ? "candidate_not_verified"
      : !candidateVerified
        ? "candidate_not_verified"
        : baselineVerified && candidateFailedChecks.length > baselineFailedChecks.length
          ? "baseline_regression"
          : !baselineVerified && candidateFailedChecks.length >= baselineFailedChecks.length
            ? "insufficient_improvement"
            : "passed";
  const summary = passed
    ? "Candidate proposal passes the v1 candidate-aware non-regression validation heuristic."
    : !candidateSelected
      ? "Candidate proposal failed validation because the candidate skill is incomplete or escalates risk."
      : silentBypassSignal
        ? "Candidate proposal failed validation because the reflection indicates silent skill bypass."
      : !reflectionPolicyReady
        ? "Candidate proposal failed validation because its patch scope crosses the shared Proposal Generator policy boundary."
      : !markdownSectionPolicy.policyReady
        ? "Candidate proposal failed validation because its markdown section changes miss or cross the shared Proposal Generator policy."
      : baselineVerified
        ? "Candidate proposal failed validation because it does not preserve the verified baseline quality."
      : "Candidate proposal failed validation because it does not show enough improvement over the baseline.";
  const baselineSelectedSkill = resolveBaselineSelectedSkill(baselineRecord, reflection);
  const candidateSelectedSkill = resolveCandidateSelectedSkill(candidateManifest, reflection);
  const candidateBinding = buildCandidateBindingEvidence({
    proposal,
    reflection,
    candidateManifest,
    changedFiles,
    replayRuntimePrepared: replayRuntime?.runtimeSource.prepared === true,
    candidateSelectedSkillId: candidateSelectedSkill.selectedSkillId,
    risky,
  });
  const executionEvidence = buildExecutionEvidence({
    reflection,
    candidateManifest,
    changedFiles,
    candidateVerified,
    silentBypassSignal,
    candidateReplayEventCount: isolatedReplayContracts?.candidate.events.length ?? 0,
    candidateReplayTerminalEventType: isolatedReplayContracts?.candidate.events.at(-1)?.type ?? null,
  });
  const candidateMissingRequirements = isolatedReplay?.candidate.missingRequirements
    ?? (candidateVerified ? [] : baselineMissingRequirements);
  const sameInputComparison = buildSameInputComparison({
    baselineJobAvailable: Boolean(baselineRecord?.job.id),
    candidateRuntimePrepared: replayRuntime?.runtimeSource.prepared === true,
    trueRuntimeReplayReady: runtimeBoundary.trueRuntimeReplayReady,
    inputAligned: inputEquivalence.satisfied,
    baselineSelectedSkillId: baselineSelectedSkill.selectedSkillId,
    candidateSelectedSkillId: candidateSelectedSkill.selectedSkillId,
    proposalSkillId: proposal.skillId,
    baselineVerified,
    candidateVerified,
    baselineArtifactCount,
    candidateArtifactCount,
    baselineFailedChecks,
    candidateFailedChecks,
    baselineMissingRequirements,
    candidateMissingRequirements,
    executionEvidenceLevel: executionEvidence.level,
    candidateBindingReady: candidateBinding.bindingReady,
    silentBypassSignal,
  });
  const resultTaxonomy = buildValidationResultTaxonomy({
    passed,
    candidateSelected,
    candidateVerified,
    baselineVerified,
    inputEquivalent: inputEquivalence.satisfied,
    candidateBindingReady: candidateBinding.bindingReady,
    runtimePrepared: replayRuntime?.runtimeSource.prepared === true,
    runtimeBoundary,
    sameInputReadiness: sameInputComparison.readiness,
    candidateFailedChecks,
    baselineFailedChecks,
    candidateMissingRequirements,
  });
  const stability = buildStabilitySignals({
    baselineSource: baselineSelection.source,
    baselineVerified,
    improving,
    candidateSelected,
    silentBypassSignal,
    risk,
    trueRuntimeReplayReady: runtimeBoundary.trueRuntimeReplayReady,
    sameInputReadiness: sameInputComparison.readiness,
    executionEvidenceLevel: executionEvidence.level,
  });
  const executionEvidenceReady = executionEvidence.level === "direct";
  const decisionDetails = [
    baselineSelection.reason,
    inputEquivalence.reason,
    candidateBinding.bindingReady
      ? "Candidate binding evidence is strong enough for readiness-sensitive decisions."
      : `Candidate binding is not ready: ${candidateBinding.reasons.join(" ") || "binding evidence is incomplete."}`,
    executionEvidence.summary,
    runtimeBoundary.reason,
    sameInputComparison.summary,
    reflectionPolicyReady
      ? "Candidate patch scope stays within shared Proposal Generator policy."
      : "Candidate patch scope crosses shared Proposal Generator policy and cannot be treated as ready.",
    markdownSectionPolicy.summary,
    silentBypassSignal
      ? "Silent bypass blocks auto-accept readiness until isolated replay can prove candidate execution."
      : "No silent bypass signal blocks this validation run.",
    ...stability.reasons,
  ];
  hardGates.push({
    name: "candidate_binding_ready",
    passed: candidateBinding.bindingReady,
    detail: candidateBinding.bindingReady
      ? "Candidate binding is ready: the candidate manifest, runtime preparation, and selected skill binding all align."
      : `Candidate binding is not ready: ${candidateBinding.reasons.join(" ") || "binding evidence is incomplete."}`,
  });
  hardGates.push({
    name: "execution_evidence_ready",
    passed: executionEvidenceReady,
    detail: executionEvidenceReady
      ? "Execution evidence is direct enough for readiness-sensitive decisions."
      : `Execution evidence is ${executionEvidence.level}, so readiness-sensitive decisions must stay blocked until stronger proof exists.`,
  });
  hardGates.push({
    name: "same_input_comparison_ready",
    passed: sameInputComparison.readiness === "ready",
    detail: sameInputComparison.summary,
  });
  hardGates.push({
    name: "reflection_policy_ready",
    passed: reflectionPolicyReady,
    detail: reflectionPolicyReady
      ? "Candidate stays within the shared PG-1 / PG-4 reflection and manifest patch policy."
      : "Candidate crosses the shared PG-1 / PG-4 reflection or manifest patch policy boundary.",
  });
  hardGates.push({
    name: "markdown_section_policy_ready",
    passed: markdownSectionPolicy.policyReady,
    detail: markdownSectionPolicy.summary,
  });

  return {
    proposalId: proposal.id,
    passed,
    baselineJobId: reflection?.jobId,
    candidateJobId: `${proposal.id}_candidate`,
    risk,
    stability,
    contract: {
      baselineSelection,
      inputEquivalence,
      hardGates,
    },
    replay: {
      mode: "record_replay",
      runtimeBoundary,
      sameInputComparison,
      provenance: {
        baselineSource: baselineRecord?.job.id ? "job_record" : reflection?.jobId ? "reflection_record" : "unavailable",
        candidateSource: replayRuntime?.runtimeSource.prepared ? "candidate_runtime_config" : "candidate_snapshot",
        baselineSelectedSkillSource: baselineSelectedSkill.source,
        candidateSelectedSkillSource: candidateSelectedSkill.source,
        candidateDir: proposal.candidateDir,
        isolated: isolatedReplay !== null,
        note: replayRuntime?.runtimeSource.prepared
          ? (isolatedReplay
            ? `${replayRuntime.runtimeSource.note} Isolated manifest replay executed against baseline job artifacts.`
            : replayRuntime.runtimeSource.note)
          : "Current validator compares the candidate snapshot against recorded baseline evidence; isolated replay is not implemented yet.",
        candidateBinding,
        executionEvidence,
        runtimeConfig: replayRuntime ? {
          prepared: replayRuntime.runtimeSource.prepared,
          builtinDir: replayRuntime.runtimeSource.builtinDir,
          candidateRoot: replayRuntime.runtimeSource.candidateRoot,
          targetFile: replayRuntime.runtimeSource.targetFile,
          skillId: replayRuntime.runtimeSource.skillId,
          workflowMaterialized: runtimeProbe?.workflowMaterialized ?? false,
          workflowTaskCount: candidateRuntimeReplay?.workflowTaskCount ?? runtimeProbe?.workflowTaskCount ?? 0,
          workflowStrategy: candidateRuntimeReplay?.workflowStrategy ?? runtimeProbe?.workflowStrategy,
          workflowExecuted: candidateRuntimeReplay?.workflowExecuted ?? false,
          replayReady: candidateRuntimeReplay?.replayReady ?? false,
          replayStatus: candidateRuntimeReplay?.status,
          replayVerified: candidateRuntimeReplay?.verified,
          replayArtifactCount: candidateRuntimeReplay?.artifactCount,
          replayTaskRunCount: candidateRuntimeReplay?.taskRunCount,
          replayTaskPayloads: candidateRuntimeReplay?.taskPayloads,
        } : undefined,
      },
      baseline: {
        jobId: baselineRecord?.job.id ?? reflection?.jobId,
        selectedSkillId: baselineSelectedSkill.selectedSkillId,
        verified: baselineVerified,
        verificationStatus: isolatedReplay?.baseline.verificationResult.status
          ?? reflection?.evidence.verificationStatus
          ?? baselineRecord?.job.verificationResult?.status
          ?? null,
        artifactCount: baselineArtifactCount,
        failedChecks: baselineFailedChecks,
        missingRequirements: baselineMissingRequirements,
        replayJob: isolatedReplayContracts ? {
          source: "isolated_manifest_replay",
          jobId: isolatedReplayContracts.baseline.jobId,
          taskRunId: isolatedReplayContracts.baseline.taskRunId,
          status: isolatedReplayContracts.baseline.status,
          verificationStatus: isolatedReplayContracts.baseline.verificationStatus,
          artifactCount: isolatedReplayContracts.baseline.artifactCount,
          stepSummary: isolatedReplayContracts.baseline.stepSummary,
          events: isolatedReplayContracts.baseline.events,
        } : undefined,
      },
      candidate: {
        proposalId: proposal.id,
        selectedSkillId: candidateSelectedSkill.selectedSkillId,
        candidateManifestPresent: !!candidateManifest,
        changedFiles,
        verified: candidateVerified,
        verificationStatus: isolatedReplay?.candidate.verificationResult.status
          ?? (candidateVerified
            ? (baselineVerified ? (reflection?.evidence.verificationStatus ?? "verified") : "verified")
            : (reflection?.evidence.verificationStatus ?? null)),
        artifactCount: candidateArtifactCount,
        failedChecks: candidateFailedChecks,
        missingRequirements: candidateMissingRequirements,
        replayJob: isolatedReplayContracts ? {
          source: "isolated_manifest_replay",
          jobId: isolatedReplayContracts.candidate.jobId,
          taskRunId: isolatedReplayContracts.candidate.taskRunId,
          status: isolatedReplayContracts.candidate.status,
          verificationStatus: isolatedReplayContracts.candidate.verificationStatus,
          artifactCount: isolatedReplayContracts.candidate.artifactCount,
          stepSummary: isolatedReplayContracts.candidate.stepSummary,
          events: isolatedReplayContracts.candidate.events,
        } : undefined,
      },
    },
    comparison: {
      candidateSelected,
      candidateVerified,
      baselineVerified,
      candidateArtifactCount,
      baselineArtifactCount,
      candidateFailedChecks,
      baselineFailedChecks,
    },
    resultTaxonomy,
    decision: {
      reasonCode,
      autoAcceptReady: passed
        && !silentBypassSignal
        && inputEquivalence.satisfied
        && candidateBinding.bindingReady
        && executionEvidenceReady
        && runtimeBoundary.trueRuntimeReplayReady
        && sameInputComparison.readiness === "ready"
        && !stability.autoAcceptBlocked,
      details: decisionDetails,
    },
    summary,
    createdAt: new Date().toISOString(),
  };
}

export async function validateSkillEvolutionProposalWithRuntimeReplay(input: {
  proposal: SkillEvolutionProposal;
  reflection: SkillReflectionRecord | null;
  baselineRecord?: StoredJobRecord | null;
  config?: OrchestratorConfig;
}): Promise<SkillDeploymentValidationReport> {
  const candidateRuntimeReplay = input.config && input.baselineRecord
    ? await runCandidateRuntimeWorkflowReplay({
      baseConfig: input.config,
      proposal: input.proposal,
      baselineRecord: input.baselineRecord,
    })
    : null;
  return validateSkillEvolutionProposal({
    ...input,
    candidateRuntimeReplay,
  });
}
