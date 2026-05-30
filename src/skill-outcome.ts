import { getSkillManifest } from "./skill-registry.js";
import type { StoredJobRecord } from "./job-store.js";
import type { SkillOutcomeSummary } from "./skill-evolution-types.js";
import type { SelectedSkillSummary } from "./types.js";
import type { WorkflowUiEvent } from "./workflow-ui-events.js";

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function summarizeSkillOutcome(
  skillTitle: string | undefined,
  verificationStatus: SkillOutcomeSummary["verificationStatus"],
  jobStatus: string,
  verified: boolean,
): string {
  const label = skillTitle ?? "Selected skill";
  if (verificationStatus === "verified" || verified) {
    return `${label} completed with verified evidence.`;
  }
  if (verificationStatus === "insufficient") {
    return `${label} ran but still needs more evidence.`;
  }
  if (verificationStatus === "failed") {
    return `${label} ran but failed verification.`;
  }
  if (jobStatus === "completed") {
    return `${label} completed without a recorded verification result.`;
  }
  if (jobStatus === "failed" || jobStatus === "blocked") {
    return `${label} ended without a successful verified outcome.`;
  }
  return `${label} is still in progress.`;
}

function collectRelatedEventIds(
  taskRunIds: readonly string[],
  selectedSkillId: string,
  events: readonly WorkflowUiEvent[],
): string[] {
  return uniqueStrings(events.flatMap((event) => {
    const eventSkillId = typeof event.meta.skill_id === "string" ? event.meta.skill_id : typeof event.meta.selected_skill === "string" ? event.meta.selected_skill : "";
    const matchesTask = typeof event.taskRunId === "string" && taskRunIds.includes(event.taskRunId);
    const matchesSkill = eventSkillId === selectedSkillId;
    return matchesTask || matchesSkill ? [event.id] : [];
  }));
}

export function buildSkillOutcomeSummary(
  record: StoredJobRecord,
  events: readonly WorkflowUiEvent[],
  selectedSkill: SelectedSkillSummary | null,
  skillVerification: Record<string, unknown> | null,
): SkillOutcomeSummary | null {
  const selectedSkillId = typeof selectedSkill?.skill_id === "string" && selectedSkill.skill_id.trim().length > 0
    ? selectedSkill.skill_id.trim()
    : "";
  if (!selectedSkillId) {
    return null;
  }

  const manifest = getSkillManifest(selectedSkillId);
  const taskRunIds = uniqueStrings(record.taskRuns.map((taskRun) => taskRun.id));
  const verificationStatus = typeof skillVerification?.verification_status === "string"
    ? skillVerification.verification_status as SkillOutcomeSummary["verificationStatus"]
    : record.job.verificationResult?.status ?? null;
  const failedCheckNames = Array.isArray(skillVerification?.failed_check_names)
    ? uniqueStrings(skillVerification.failed_check_names.filter((value): value is string => typeof value === "string"))
    : [];
  const missingRequirements = Array.isArray(skillVerification?.missing_requirements)
    ? uniqueStrings(skillVerification.missing_requirements.filter((value): value is string => typeof value === "string"))
    : [];

  return {
    jobId: record.job.id,
    planId: record.plan.id,
    selectedSkillId,
    selectedSkillTitle: manifest?.title,
    selectedSkillVersion: manifest?.version,
    intentKind: record.job.intentRoute?.kind ?? record.plan.intentRoute?.kind,
    routeKind: record.job.intentRoute?.kind ?? record.plan.intentRoute?.kind,
    jobStatus: record.job.status,
    verified: record.job.verified || verificationStatus === "verified",
    verificationStatus,
    artifactCount: record.artifacts.length,
    failedCheckNames,
    missingRequirements,
    taskRunIds,
    relatedEventIds: collectRelatedEventIds(taskRunIds, selectedSkillId, events),
    summary: summarizeSkillOutcome(manifest?.title, verificationStatus, record.job.status, record.job.verified),
  };
}
