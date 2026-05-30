import { getSkillManifest } from "./skill-registry.js";
import type { TaskRun, VerificationCheck } from "./types.js";

function defaultSkillArtifactRequirementLabel(requirement: string): string {
  switch (requirement) {
    case "symbol_hits":
      return "relevant symbol hits";
    case "file_excerpt":
      return "supporting file excerpts";
    case "search_results":
      return "search result evidence";
    case "primary_source_summary":
      return "primary-source summaries";
    case "file_hits":
      return "relevant workspace file hits";
    case "config_excerpt":
      return "config or schema excerpts";
    case "integration_hits":
      return "integration boundary hits";
    case "call_path_excerpt":
      return "call path excerpts";
    default:
      return requirement.replaceAll("_", " ");
  }
}

function defaultSkillSuccessSignalLabel(signal: string | undefined): string | null {
  switch (signal) {
    case "at_least_one_relevant_entrypoint":
      return "identify at least one relevant entrypoint";
    case "at_least_two_non_empty_primary_sources":
      return "capture at least two non-empty primary sources";
    case "at_least_one_relevant_workspace_target":
      return "locate at least one relevant workspace target";
    case "at_least_one_relevant_integration_boundary":
      return "trace at least one relevant integration boundary";
    default:
      return signal ? signal.replaceAll("_", " ") : null;
  }
}

function formatSkillAwareCheckLabel(
  skillTitle: string | undefined,
  checkName: string,
  requiredArtifacts: string[],
): string {
  const prefix = skillTitle ? `${skillTitle}: ` : "";
  switch (checkName) {
    case "artifact_presence":
      return `${prefix}missing required skill artifacts${requiredArtifacts.length > 0 ? ` (${requiredArtifacts.join(", ")})` : ""}`;
    case "acceptance_criteria":
      return `${prefix}skill acceptance criteria not yet satisfied`;
    case "file_exists":
      return `${prefix}expected evidence files are missing`;
    case "schema_check":
      return `${prefix}structured evidence artifacts are invalid`;
    default:
      return `${prefix}${checkName.replaceAll("_", " ")}`;
  }
}

function formatSkillAwareMissingRequirement(
  skillTitle: string | undefined,
  detail: string,
  requiredArtifacts: string[],
  successSignalLabel: string | null,
): string {
  const skillPrefix = skillTitle ? `${skillTitle} still needs ` : "";
  if (detail.toLowerCase().includes("required skill artifacts are missing")) {
    const artifactSummary = requiredArtifacts.length > 0
      ? requiredArtifacts.join(", ")
      : "required skill evidence";
    return `${skillPrefix}evidence artifacts: ${artifactSummary}.`;
  }
  if (detail.toLowerCase().includes("expected at least")) {
    return `${skillPrefix}enough evidence artifacts to satisfy the skill contract.${successSignalLabel ? ` Goal: ${successSignalLabel}.` : ""}`;
  }
  if (detail.toLowerCase().includes("expected at least one json artifact")) {
    return `${skillPrefix}a structured JSON evidence artifact.`;
  }
  if (detail.toLowerCase().includes("expected at least one")) {
    return `${skillPrefix}${detail.charAt(0).toLowerCase()}${detail.slice(1)}`;
  }
  return `${skillPrefix}${detail}`;
}

function buildSkillSpecificNextAction(
  remediation: { insufficient?: string; failed?: string } | undefined,
  skillId: string | null,
  verificationStatus: string,
  requiredArtifacts: string[],
  successSignalLabel: string | null,
): string | null {
  if (verificationStatus === "insufficient") {
    if (remediation?.insufficient?.trim()) {
      return remediation.insufficient.trim();
    }
    switch (skillId) {
      case "find.code_symbol":
        return "Capture concrete symbol hits and supporting file excerpts, then rerun skill verification.";
      case "find.official_sources":
        return "Fetch at least two primary sources and summarize why they are official, then rerun skill verification.";
      case "find.workspace_files":
        return "Collect the relevant workspace file hits and config excerpts, then rerun skill verification.";
      case "find.integration_points":
        return "Trace integration hits and call path excerpts across the boundary, then rerun skill verification.";
      default:
        return requiredArtifacts.length > 0
          ? `Collect the missing skill evidence (${requiredArtifacts.join(", ")}) and rerun verification.${successSignalLabel ? ` Goal: ${successSignalLabel}.` : ""}`
          : "Collect the missing skill evidence and rerun verification.";
    }
  }
  if (verificationStatus === "failed") {
    if (remediation?.failed?.trim()) {
      return remediation.failed.trim();
    }
    switch (skillId) {
      case "find.code_symbol":
        return "Inspect the recorded symbol evidence and repair any missing or invalid repository excerpts before continuing.";
      case "find.official_sources":
        return "Review the fetched sources, replace weak or invalid evidence, and confirm the official-source summary before continuing.";
      case "find.workspace_files":
        return "Recheck the selected workspace files and confirm the config/schema evidence before continuing.";
      case "find.integration_points":
        return "Review the traced integration paths and repair the missing or invalid boundary evidence before continuing.";
      default:
        return "Inspect the failed verification checks before continuing.";
    }
  }
  return null;
}

export function buildSkillVerificationSummary(
  skillVerifyTaskRun: TaskRun,
  skillId: string | null,
): Record<string, unknown> {
  const manifest = skillId ? getSkillManifest(skillId) : null;
  const requiredArtifacts = manifest?.verification?.requiredArtifacts?.map((requirement) =>
    manifest.verification?.artifactLabels?.[requirement]
      ?? defaultSkillArtifactRequirementLabel(requirement)
  ) ?? [];
  const successSignalLabel = manifest?.verification?.successSignalLabel
    ?? defaultSkillSuccessSignalLabel(manifest?.verification?.successSignal);
  const verificationResult = skillVerifyTaskRun.verificationResult;
  const verificationStatus = verificationResult?.status ?? (skillVerifyTaskRun.verified ? "verified" : "unavailable");
  const failedChecks = verificationResult?.checks.filter((check) => !check.passed) ?? [];
  const failedCheckNames = failedChecks.map((check) => formatSkillAwareCheckLabel(manifest?.title, check.name, requiredArtifacts));
  const missingRequirements = failedChecks
    .filter((check) => (check.status ?? "failed") === "insufficient")
    .map((check) => formatSkillAwareMissingRequirement(manifest?.title, check.detail, requiredArtifacts, successSignalLabel));
  const statusLabel = verificationStatus === "verified"
    ? "Verified"
    : verificationStatus === "insufficient"
      ? "Needs evidence"
      : verificationStatus === "failed"
        ? "Failed"
        : "Unavailable";
  const actionRequired = verificationStatus === "insufficient" || verificationStatus === "failed";
  const outcomeSummary = verificationResult?.summary ?? (skillVerifyTaskRun.output.trim() || null);
  const nextAction = buildSkillSpecificNextAction(
    manifest?.verification?.remediation,
    skillId,
    verificationStatus,
    requiredArtifacts,
    successSignalLabel,
  );

  return {
    task_id: skillVerifyTaskRun.id,
    title: skillVerifyTaskRun.title,
    task_status: skillVerifyTaskRun.status,
    verified: skillVerifyTaskRun.verified,
    skill_id: skillId,
    skill_title: manifest?.title ?? null,
    verification_status: verificationStatus,
    verification_label: statusLabel,
    action_required: actionRequired,
    summary: outcomeSummary,
    outcome_summary: outcomeSummary,
    next_action: nextAction,
    required_artifacts: requiredArtifacts,
    success_signal_label: successSignalLabel,
    check_count: verificationResult?.checks.length ?? 0,
    failed_check_names: failedCheckNames,
    missing_requirements: missingRequirements,
    checks: verificationResult?.checks.map((check: VerificationCheck) => ({
      name: check.name,
      passed: check.passed,
      status: check.status ?? (check.passed ? "passed" : "failed"),
      detail: check.detail,
    })) ?? [],
  };
}
