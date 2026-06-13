import type { VerificationResult } from "./types.js";

export type SkillReflectionKind =
  | "discovery"
  | "optimization"
  | "skill_defect"
  | "execution_lapse";

export type SkillProposalStatus =
  | "draft"
  | "auditing"
  | "audit_failed"
  | "validated"
  | "validation_failed"
  | "accepted"
  | "rejected";

export interface SkillOutcomeSummary {
  jobId: string;
  planId?: string;
  selectedSkillId: string;
  selectedSkillTitle?: string;
  selectedSkillVersion?: string;
  intentKind?: string;
  routeKind?: string;
  jobStatus: string;
  verified: boolean;
  verificationStatus?: VerificationResult["status"] | null;
  artifactCount: number;
  failedCheckNames: string[];
  missingRequirements: string[];
  taskRunIds: string[];
  relatedEventIds: string[];
  summary: string;
}

export interface SkillReflectionRecord {
  id: string;
  skillId: string;
  jobId: string;
  reflectionKind: SkillReflectionKind;
  reason: string;
  evidence: {
    verificationStatus?: VerificationResult["status"] | null;
    failedCheckNames: string[];
    missingRequirements: string[];
    eventIds: string[];
    artifactIds: string[];
    silentBypassSignal?: boolean;
  };
  recommendedAction:
    | "append_appendix"
    | "patch_body"
    | "patch_verification"
    | "no_change";
  createdAt: string;
}

export interface SkillEvolutionProposal {
  id: string;
  skillId: string;
  sourceReflectionId: string;
  status: SkillProposalStatus;
  targetFiles: string[];
  diffSummary?: {
    scope: "appendix_only" | "body_only" | "verification_only" | "body_and_appendix" | "mixed";
    changedSections: string[];
    changedFiles: Array<{
      path: string;
      summary: string;
    }>;
  };
  rationaleSummary?: {
    reflectionKind: SkillReflectionKind;
    recommendedAction: SkillReflectionRecord["recommendedAction"];
    reason: string;
    evidenceHighlights: string[];
    expectedOutcome: string;
  };
  controlPlaneSummary?: {
    title: string;
    changeHeadline: string;
    rationaleHeadline: string;
    changedFiles: string[];
  };
  qualitySummary?: {
    tier: "safe" | "useful" | "regression-risk";
    reasons: string[];
    fixtureClass: SkillReflectionKind;
    crossFileConsistency: "manifest_stable" | "manifest_verification_only" | "needs_audit";
  };
  patchSummary: string;
  patchText: string;
  candidateDir: string;
  auditReportPath?: string;
  validationReportPath?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface SkillEvolutionAutomationBlockSummary {
  reason: "automation_ceiling";
  eventType: "system.skill_evolution_automation_blocked";
  jobId: string;
  eventSeq: number;
  eventTime: string;
  summary: string;
  riskTier: "low" | "medium" | "high";
  blockedStage: "auto_reflect" | "auto_propose" | "auto_audit" | "auto_validate" | "auto_accept";
  automationCeiling: "auto_reflect" | "auto_propose" | "auto_audit" | "auto_validate" | "auto_accept";
}

export interface SkillAuditReport {
  proposalId: string;
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
  failureCategories?: string[];
  remediationHints?: Array<{
    check: string;
    category: string;
    evidence: string;
    hint: string;
  }>;
  summary: string;
  createdAt: string;
}

export interface SkillDeploymentValidationReport {
  proposalId: string;
  passed: boolean;
  baselineJobId?: string;
  candidateJobId?: string;
  risk: {
    tier: "low" | "high";
    skillClass: "research_like" | "coding_like";
    summary: string;
    acceptanceFocus: "improvement" | "non_regression";
  };
  stability: {
    replayInstabilityDetected: boolean;
    candidateFlakySignal: boolean;
    autoAcceptBlocked: boolean;
    replayStabilityScore: number;
    replayStabilityLevel: "stable" | "watch" | "unstable";
    reasons: string[];
  };
  contract: {
    baselineSelection: {
      source: "source_reflection_job" | "reflection_only" | "none";
      jobId?: string;
      reflectionId?: string;
      reason: string;
    };
    inputEquivalence: {
      mode: "same_recorded_input";
      satisfied: boolean;
      reason: string;
    };
    hardGates: Array<{
      name: string;
      passed: boolean;
      detail: string;
    }>;
  };
  replay: {
    mode: "record_replay";
    runtimeBoundary: {
      source: "isolated_manifest_replay" | "candidate_snapshot" | "candidate_runtime_config";
      contract: "manifest_replay_only" | "candidate_runtime_workflow_materialized" | "true_candidate_runtime_replay";
      stage: "snapshot_only" | "config_prepared" | "workflow_materialized" | "executed";
      candidateRuntimeConfigPrepared: boolean;
      candidateWorkflowMaterialized: boolean;
      candidateWorkflowTaskCount: number;
      trueRuntimeReplayEnabled: boolean;
      trueRuntimeReplayReady: boolean;
      autoAcceptEligible: boolean;
      reason: string;
    };
    sameInputComparison: {
      mode: "recorded_baseline_vs_candidate" | "baseline_job_vs_candidate_runtime";
      inputAligned: boolean;
      baselineObserved: boolean;
      candidateObserved: boolean;
      baselineSelected: boolean;
      candidateSelected: boolean;
      baselineVerified: boolean;
      candidateVerified: boolean;
      artifactDelta: number;
      failedChecksDelta: number;
      resolvedMissingRequirements: string[];
      remainingMissingRequirements: string[];
      introducedMissingRequirements: string[];
      evidenceLevel: "direct" | "partial" | "weak";
      readiness: "ready" | "needs_replay" | "blocked";
      summary: string;
    };
    provenance: {
      baselineSource: "job_record" | "reflection_record" | "unavailable";
      candidateSource: "candidate_snapshot" | "candidate_runtime_config";
      baselineSelectedSkillSource: "job_selected_skill" | "plan_selected_skill" | "reflection_record" | "unavailable";
      candidateSelectedSkillSource: "candidate_manifest" | "reflection_record" | "unavailable";
      candidateDir: string;
      isolated: boolean;
      note: string;
      candidateBinding: {
        manifestPresent: boolean;
        runtimePrepared: boolean;
        targetFileCount: number;
        changedFileCount: number;
        selectedSkillMatchesProposal: boolean;
        selectedSkillMatchesReflection: boolean;
        bindingReady: boolean;
        reasons: string[];
      };
      executionEvidence: {
        reflectionEventIds: string[];
        reflectionArtifactIds: string[];
        baselineHadArtifacts: boolean;
        silentBypassSignal: boolean;
        candidateManifestPresent: boolean;
        candidateChangedFiles: string[];
        candidateVerified: boolean;
        level: "direct" | "partial" | "weak";
        summary: string;
      };
      runtimeConfig?: {
        prepared: boolean;
        builtinDir?: string;
        candidateRoot?: string;
        targetFile?: string;
        skillId: string;
        workflowMaterialized?: boolean;
        workflowTaskCount?: number;
        workflowStrategy?: string;
        workflowExecuted?: boolean;
        replayReady?: boolean;
        replayStatus?: string;
        replayVerified?: boolean;
        replayArtifactCount?: number;
        replayTaskRunCount?: number;
        replayTaskPayloads?: SkillRuntimeReplayTaskPayload[];
      };
    };
    baseline: {
      jobId?: string;
      selectedSkillId?: string | null;
      verified: boolean;
      verificationStatus?: VerificationResult["status"] | null;
      artifactCount: number;
      failedChecks: string[];
      missingRequirements: string[];
      replayJob?: {
        source: "isolated_manifest_replay";
        jobId: string;
        taskRunId: string;
        status: string;
        verificationStatus: VerificationResult["status"];
        artifactCount: number;
        stepSummary: SkillIsolatedReplayStepSummary;
        events: SkillIsolatedReplayEvent[];
      };
    };
    candidate: {
      proposalId: string;
      selectedSkillId?: string | null;
      candidateManifestPresent: boolean;
      changedFiles: string[];
      verified: boolean;
      verificationStatus?: VerificationResult["status"] | null;
      artifactCount: number;
      failedChecks: string[];
      missingRequirements: string[];
      replayJob?: {
        source: "isolated_manifest_replay";
        jobId: string;
        taskRunId: string;
        status: string;
        verificationStatus: VerificationResult["status"];
        artifactCount: number;
        stepSummary: SkillIsolatedReplayStepSummary;
        events: SkillIsolatedReplayEvent[];
      };
    };
  };
  comparison: {
    candidateSelected: boolean;
    candidateVerified: boolean;
    baselineVerified: boolean;
    candidateArtifactCount: number;
    baselineArtifactCount: number;
    candidateFailedChecks: string[];
    baselineFailedChecks: string[];
  };
  resultTaxonomy: {
    category:
      | "passed"
      | "setup_failed"
      | "candidate_failed"
      | "baseline_failed"
      | "inconclusive"
      | "regression";
    reason: string;
    retryable: boolean;
  };
  decision: {
    reasonCode:
      | "passed"
      | "candidate_not_selected"
      | "silent_bypass"
      | "candidate_not_verified"
      | "baseline_regression"
      | "insufficient_improvement";
    autoAcceptReady: boolean;
    details: string[];
  };
  summary: string;
  createdAt: string;
}

export interface SkillRuntimeReplayTaskPayload {
  taskRunId: string;
  title: string;
  status: string;
  verified: boolean;
  artifactCount: number;
  attempts: number;
  assignee?: string | null;
  dependsOn: string[];
  outputPreview: string;
}

export interface SkillIsolatedReplayStepSummary {
  replaySource: "recorded_baseline_artifacts";
  totalSteps: number;
  completedSteps: number;
  blockedSteps: number;
  verificationSteps: number;
  evidenceArtifactCount: number;
  requiredArtifactCount: number;
  failedChecks: string[];
  missingRequirements: string[];
  terminalEventType: SkillIsolatedReplayEvent["type"];
  terminalStatus: SkillIsolatedReplayEvent["status"];
  summary: string;
}

export interface SkillIsolatedReplayEvent {
  seq: number;
  type:
    | "replay_job_created"
    | "artifacts_loaded"
    | "manifest_resolved"
    | "verification_started"
    | "checks_evaluated"
    | "verification_completed"
    | "replay_job_completed"
    | "replay_job_blocked";
  step: "prepare" | "manifest" | "verification" | "complete";
  status: "running" | "completed" | "blocked";
  summary: string;
  detail?: string;
  verificationStatus?: VerificationResult["status"];
  stepPayload?: {
    taskRunId: string;
    replaySource: "recorded_baseline_artifacts";
    manifestId?: string;
    manifestTitle?: string;
    artifactCount?: number;
    requiredArtifacts?: string[];
    requiredArtifactCount?: number;
    checkCount?: number;
    passedCheckNames?: string[];
    failedCheckNames?: string[];
    missingRequirements?: string[];
    terminal?: boolean;
  };
}

export interface SkillEvolutionDecisionRecord {
  proposalId: string;
  skillId: string;
  decision: "accepted" | "rejected";
  reason?: string;
  createdAt: string;
}
