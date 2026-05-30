import { randomUUID } from "node:crypto";
import type { StoredJobRecord } from "./job-store.js";
import type { SkillOutcomeSummary, SkillReflectionKind, SkillReflectionRecord } from "./skill-evolution-types.js";
import type { WorkflowUiEvent } from "./workflow-ui-events.js";

export interface SkillReflectionContext {
  record: StoredJobRecord;
  events: readonly WorkflowUiEvent[];
}

function collectRelatedArtifactIds(outcome: SkillOutcomeSummary, record: StoredJobRecord): string[] {
  return [...new Set(record.artifacts
    .filter((artifact) => {
      const taskRunId = artifact.sourceTaskRunId ?? artifact.relatedTaskRunId ?? "";
      return outcome.taskRunIds.includes(taskRunId);
    })
    .map((artifact) => artifact.id))];
}

function hasSilentBypassSignal(outcome: SkillOutcomeSummary, context: SkillReflectionContext): boolean {
  const hasVerificationTask = context.record.taskRuns.some((taskRun) => taskRun.id.endsWith("__skill_verify"));
  const hasSkillArtifacts = collectRelatedArtifactIds(outcome, context.record).length > 0;
  const hasRelatedEvents = outcome.relatedEventIds.length > 0;
  return !hasVerificationTask || (!hasSkillArtifacts && !outcome.verified) || !hasRelatedEvents;
}

function classifySuccessfulOutcome(outcome: SkillOutcomeSummary, context: SkillReflectionContext): SkillReflectionKind {
  const retryCount = context.record.taskRuns.filter((taskRun) => taskRun.attempts > 1).length;
  const retriedEventCount = context.events.filter((event) => event.phase === "retry").length;
  return retryCount > 0 || retriedEventCount > 0 ? "optimization" : "discovery";
}

function classifyFailedOutcome(
  outcome: SkillOutcomeSummary,
  context: SkillReflectionContext,
  silentBypassSignal: boolean,
): SkillReflectionKind {
  if (silentBypassSignal) {
    return "execution_lapse";
  }
  const attemptedVerification = context.record.taskRuns.some((taskRun) => taskRun.id.endsWith("__skill_verify") && !!taskRun.verificationResult);
  return attemptedVerification || outcome.failedCheckNames.length > 0 || outcome.missingRequirements.length > 0
    ? "skill_defect"
    : "execution_lapse";
}

function buildReason(
  outcome: SkillOutcomeSummary,
  reflectionKind: SkillReflectionKind,
  silentBypassSignal: boolean,
): string {
  const skillLabel = outcome.selectedSkillTitle ?? outcome.selectedSkillId;
  switch (reflectionKind) {
    case "discovery":
      return `${skillLabel} succeeded with verified evidence and exposed a reusable scenario worth capturing.`;
    case "optimization":
      return `${skillLabel} succeeded, but retries or extra recovery steps suggest the procedure can be streamlined.`;
    case "skill_defect":
      return `${skillLabel} was attempted, but the current skill contract still failed to satisfy verification.`;
    case "execution_lapse":
      return silentBypassSignal
        ? `${skillLabel} appears to have been selected without enough concrete execution evidence.`
        : `${skillLabel} looks sound, but the run missed an expected execution step or evidence handoff.`;
  }
}

function mapRecommendedAction(reflectionKind: SkillReflectionKind): SkillReflectionRecord["recommendedAction"] {
  switch (reflectionKind) {
    case "discovery":
      return "append_appendix";
    case "optimization":
      return "patch_body";
    case "skill_defect":
      return "patch_body";
    case "execution_lapse":
      return "append_appendix";
  }
}

export function classifySkillReflection(
  outcome: SkillOutcomeSummary | null,
  context: SkillReflectionContext,
): {
  reflectionKind: SkillReflectionKind;
  reason: string;
  recommendedAction: SkillReflectionRecord["recommendedAction"];
  silentBypassSignal: boolean;
} | null {
  if (!outcome) {
    return null;
  }

  const silentBypassSignal = hasSilentBypassSignal(outcome, context);
  const verifiedSuccess = outcome.verified || outcome.verificationStatus === "verified";
  const reflectionKind = verifiedSuccess
    ? classifySuccessfulOutcome(outcome, context)
    : classifyFailedOutcome(outcome, context, silentBypassSignal);

  return {
    reflectionKind,
    reason: buildReason(outcome, reflectionKind, silentBypassSignal),
    recommendedAction: mapRecommendedAction(reflectionKind),
    silentBypassSignal,
  };
}

export function buildSkillReflectionRecord(
  outcome: SkillOutcomeSummary | null,
  context: SkillReflectionContext,
): SkillReflectionRecord | null {
  const classification = classifySkillReflection(outcome, context);
  if (!outcome || !classification) {
    return null;
  }

  return {
    id: `refl_${randomUUID().slice(0, 8)}`,
    skillId: outcome.selectedSkillId,
    jobId: outcome.jobId,
    reflectionKind: classification.reflectionKind,
    reason: classification.reason,
    evidence: {
      verificationStatus: outcome.verificationStatus,
      failedCheckNames: [...outcome.failedCheckNames],
      missingRequirements: [...outcome.missingRequirements],
      eventIds: [...outcome.relatedEventIds],
      artifactIds: collectRelatedArtifactIds(outcome, context.record),
      silentBypassSignal: classification.silentBypassSignal,
    },
    recommendedAction: classification.recommendedAction,
    createdAt: new Date().toISOString(),
  };
}
