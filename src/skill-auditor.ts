import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { getSkillEvolutionProposalCandidateRoot } from "./skill-evolution-store.js";
import {
  evaluateSkillMarkdownPatchPolicy,
  hasInstallSourceEscalation,
  hasRuntimeStrategyEscalation,
  hasToolScopeEscalation,
  PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST,
  isReflectionToPatchConsistent,
} from "./skill-evolution-policy.js";
import { validateSkillManifestShape } from "./skill-manifest-schema.js";
import type { SkillAuditReport, SkillEvolutionProposal, SkillReflectionRecord } from "./skill-evolution-types.js";
import type { SkillManifest } from "./skill-types.js";

function buildCheck(name: string, passed: boolean, detail: string): SkillAuditReport["checks"][number] {
  return { name, passed, detail };
}

function resolveAllowedTargetFiles(skillId: string, manifest: SkillManifest | null): Set<string> {
  const baseLocation = manifest?.install?.location
    ? resolve(PROJECT_ROOT, manifest.install.location)
    : resolve(PROJECT_ROOT, "skills", skillId);
  return new Set([
    resolve(baseLocation, "skill.json"),
    resolve(baseLocation, "SKILL.md"),
  ]);
}

function resolveCandidatePaths(proposal: SkillEvolutionProposal): Array<{
  targetFile: string;
  livePath: string;
  candidatePath: string;
}> {
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  return proposal.targetFiles.map((targetFile) => ({
    targetFile,
    livePath: resolve(PROJECT_ROOT, targetFile),
    candidatePath: resolve(candidateRoot, targetFile),
  }));
}

function safeReadText(path: string): string {
  return readFileSync(path, "utf8");
}

function safeReadManifest(path: string): SkillManifest | null {
  try {
    return JSON.parse(safeReadText(path)) as SkillManifest;
  } catch {
    return null;
  }
}

function checkMarkdownStructure(path: string): SkillAuditReport["checks"][number] {
  if (!existsSync(path)) {
    return buildCheck(
      "skill_markdown_structure_valid",
      true,
      "No candidate SKILL.md file exists for this proposal; markdown structure enforcement is skipped.",
    );
  }
  const content = safeReadText(path);
  const hasCore = /(^|\n)##\s+Core Procedure\b/i.test(content);
  const hasScenarios = /(^|\n)##\s+Scenario Extensions\b/i.test(content);
  const hasAppendix = /(^|\n)##\s+Appendix\b/i.test(content);
  const valid = hasCore && hasScenarios && hasAppendix;
  return buildCheck(
    "skill_markdown_structure_valid",
    valid,
    valid
      ? "Candidate SKILL.md includes the expected Core Procedure, Scenario Extensions, and Appendix sections."
      : "Candidate SKILL.md is missing one or more expected sections: Core Procedure, Scenario Extensions, Appendix.",
  );
}

function countChangedFiles(paths: Array<{ livePath: string; candidatePath: string }>): number {
  let changed = 0;
  for (const pathInfo of paths) {
    if (!existsSync(pathInfo.candidatePath)) {
      continue;
    }
    const liveContent = existsSync(pathInfo.livePath) ? safeReadText(pathInfo.livePath) : "";
    const candidateContent = safeReadText(pathInfo.candidatePath);
    if (liveContent !== candidateContent) {
      changed += 1;
    }
  }
  return changed;
}

function textHasSecretOrLeakage(text: string): boolean {
  return /api[_-]?key|bearer\s+[a-z0-9_\-]+|[A-Z]:\\[^ \n\r\t]+|\/Users\/[^ \n\r\t]+|\/home\/[^ \n\r\t]+/i.test(text);
}

function manifestHasUnsupportedVerificationContract(candidate: SkillManifest | null, installed: SkillManifest | null): boolean {
  if (!candidate) {
    return false;
  }
  return candidate.execution.strategy === "custom_runtime"
    || Boolean(candidate.execution.runtimeEntry)
    || (installed?.verification === undefined && candidate.verification !== undefined && false);
}

function getVerificationAtPath(manifest: SkillManifest | null, path: string): unknown {
  if (!manifest) {
    return undefined;
  }
  const parts = path.split(".");
  let value: unknown = manifest;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !(part in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function collectVerificationDiffPaths(candidate: SkillManifest | null, installed: SkillManifest | null): string[] {
  const candidateVerification = candidate?.verification ?? null;
  const installedVerification = installed?.verification ?? null;
  if (JSON.stringify(candidateVerification) === JSON.stringify(installedVerification)) {
    return [];
  }

  const knownPaths = [
    "verification.requiredArtifacts",
    "verification.successSignal",
    "verification.artifactLabels",
    "verification.successSignalLabel",
    "verification.remediation.insufficient",
    "verification.remediation.failed",
  ];
  const changed = knownPaths.filter((path) =>
    JSON.stringify(getVerificationAtPath(candidate, path)) !== JSON.stringify(getVerificationAtPath(installed, path)),
  );
  return changed.length > 0 ? changed : ["verification"];
}

function checkVerificationContractDiffScope(candidate: SkillManifest | null, installed: SkillManifest | null): SkillAuditReport["checks"][number] {
  const changedPaths = collectVerificationDiffPaths(candidate, installed);
  const forbidden = changedPaths.filter((path) =>
    !PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST.some((allowed) => path === allowed || path.startsWith(`${allowed}.`)),
  );
  return buildCheck(
    "verification_contract_diff_scoped",
    forbidden.length === 0,
    changedPaths.length === 0
      ? "Candidate manifest does not change the verification contract."
      : forbidden.length === 0
        ? `Candidate verification changes stay within whitelist fields: ${changedPaths.join(", ")}.`
        : `Candidate verification changes forbidden contract fields: ${forbidden.join(", ")}.`,
  );
}

function checkVerificationDiffQualityLinkage(
  proposal: SkillEvolutionProposal,
  candidate: SkillManifest | null,
  installed: SkillManifest | null,
): SkillAuditReport["checks"][number] {
  const changedPaths = collectVerificationDiffPaths(candidate, installed);
  if (changedPaths.length === 0) {
    return buildCheck(
      "verification_diff_quality_linked",
      true,
      "Candidate manifest does not change verification fields, so proposal quality cross-file metadata does not need verification linkage.",
    );
  }
  if (!proposal.qualitySummary) {
    return buildCheck(
      "verification_diff_quality_linked",
      true,
      "Proposal quality metadata is unavailable; verification diff quality linkage is skipped for backward compatibility.",
    );
  }
  const consistency = proposal.qualitySummary?.crossFileConsistency ?? null;
  const linked = consistency === "manifest_verification_only" || consistency === "needs_audit";
  return buildCheck(
    "verification_diff_quality_linked",
    linked,
    linked
      ? `Verification diff is linked to proposal quality metadata (${consistency}): ${changedPaths.join(", ")}.`
      : `Verification diff is not reflected in proposal quality metadata; expected manifest_verification_only or needs_audit but found ${consistency ?? "missing"}. Changed paths: ${changedPaths.join(", ")}.`,
  );
}

function inferAuditRiskTier(manifest: SkillManifest | null): "low" | "high" {
  const intents = new Set(manifest?.intents ?? []);
  const tools = new Set([...(manifest?.requiredTools ?? []), ...(manifest?.optionalTools ?? [])]);
  return intents.has("coding") || intents.has("file_ops") || tools.has("shell_command")
    ? "high"
    : "low";
}

function buildHighRiskManualReviewReason(manifest: SkillManifest | null): string | null {
  if (inferAuditRiskTier(manifest) !== "high") {
    return null;
  }
  const reasons: string[] = [];
  const intents = new Set(manifest?.intents ?? []);
  const tools = new Set([...(manifest?.requiredTools ?? []), ...(manifest?.optionalTools ?? [])]);
  if (intents.has("coding")) {
    reasons.push("coding intent can affect repository behavior");
  }
  if (intents.has("file_ops")) {
    reasons.push("file_ops intent can change workspace files");
  }
  if (tools.has("shell_command")) {
    reasons.push("shell_command tool access can execute local commands");
  }
  if (manifest?.execution.strategy === "custom_runtime") {
    reasons.push("custom_runtime execution needs runtime boundary review");
  }
  return reasons.length > 0
    ? `Manual review required for high-risk skill because ${reasons.join("; ")}.`
    : "Manual review required for high-risk skill before validation or acceptance.";
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, " ").trim();
}

type MatchResult = "exact" | "approximate" | "none";

function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  return intersection.size / (tokensA.size + tokensB.size - intersection.size);
}

function checkManifestMarkdownConsistency(
  candidateManifest: SkillManifest | null,
  candidateMarkdownPath: string,
): SkillAuditReport["checks"][number] {
  if (!candidateManifest || !candidateMarkdownPath || !existsSync(candidateMarkdownPath)) {
    return buildCheck(
      "manifest_markdown_identity_consistent",
      true,
      "Manifest/markdown identity consistency is skipped because one side is unavailable.",
    );
  }
  const markdown = safeReadText(candidateMarkdownPath).toLowerCase();
  const id = normalizeSearchText(candidateManifest.id);
  const title = normalizeSearchText(candidateManifest.title);
  const hasIdentity = Boolean(id && markdown.includes(id)) || Boolean(title && markdown.includes(title));
  return buildCheck(
    "manifest_markdown_identity_consistent",
    hasIdentity,
    hasIdentity
      ? "Candidate SKILL.md names the same skill identity as the candidate manifest."
      : "Candidate SKILL.md does not mention the manifest id or title, which suggests manifest/markdown drift.",
  );
}

function textIncludesNormalized(
  haystack: string,
  needle: string | undefined,
  allowApproximate = false,
): MatchResult {
  const normalizedNeedle = normalizeSearchText(needle);
  if (!normalizedNeedle) return "none";
  if (haystack.includes(normalizedNeedle)) return "exact";
  if (!allowApproximate) return "none";
  if (jaccardSimilarity(haystack, normalizedNeedle) >= 0.5) return "approximate";
  return "none";
}

function checkManifestMarkdownCapabilityConsistency(
  candidateManifest: SkillManifest | null,
  installedManifest: SkillManifest | null,
  candidateMarkdownPath: string,
): SkillAuditReport["checks"][number] {
  if (!candidateManifest || !candidateMarkdownPath || !existsSync(candidateMarkdownPath)) {
    return buildCheck(
      "manifest_markdown_capability_consistent",
      true,
      "Manifest/markdown capability consistency is skipped because one side is unavailable.",
    );
  }
  const capabilityChanged = JSON.stringify({
    intents: candidateManifest.intents,
    requiredTools: candidateManifest.requiredTools,
    optionalTools: candidateManifest.optionalTools ?? [],
    verification: candidateManifest.verification ?? null,
  }) !== JSON.stringify({
    intents: installedManifest?.intents ?? [],
    requiredTools: installedManifest?.requiredTools ?? [],
    optionalTools: installedManifest?.optionalTools ?? [],
    verification: installedManifest?.verification ?? null,
  });
  if (!capabilityChanged) {
    return buildCheck(
      "manifest_markdown_capability_consistent",
      true,
      "Manifest capability fields did not change, so markdown capability drift enforcement is skipped.",
    );
  }

  const markdown = normalizeSearchText(safeReadText(candidateMarkdownPath));
  const intentsChanged = JSON.stringify(candidateManifest.intents) !== JSON.stringify(installedManifest?.intents ?? []);
  const missingIntents = intentsChanged
    ? candidateManifest.intents.filter((intent) => textIncludesNormalized(markdown, intent) !== "exact")
    : [];
  const tools = [...candidateManifest.requiredTools, ...(candidateManifest.optionalTools ?? [])];
  const installedTools = [...(installedManifest?.requiredTools ?? []), ...(installedManifest?.optionalTools ?? [])];
  const toolsChanged = JSON.stringify(tools) !== JSON.stringify(installedTools);
  const missingTools = toolsChanged
    ? tools.filter((tool) => textIncludesNormalized(markdown, tool) !== "exact")
    : [];
  const requiredArtifacts = candidateManifest.verification?.requiredArtifacts ?? [];
  const installedRequiredArtifacts = installedManifest?.verification?.requiredArtifacts ?? [];
  const artifactLabels = candidateManifest.verification?.artifactLabels ?? {};
  const artifactsChanged = JSON.stringify(requiredArtifacts) !== JSON.stringify(installedRequiredArtifacts)
    || JSON.stringify(artifactLabels) !== JSON.stringify(installedManifest?.verification?.artifactLabels ?? {});
  const changedArtifacts = artifactsChanged
    ? requiredArtifacts.filter((artifact) =>
      !installedRequiredArtifacts.includes(artifact)
      || artifactLabels[artifact] !== installedManifest?.verification?.artifactLabels?.[artifact])
    : [];
  const missingArtifacts: string[] = [];
  const approximateArtifacts: string[] = [];
  for (const artifact of changedArtifacts) {
    const artResult = textIncludesNormalized(markdown, artifact, true);
    const labelResult = textIncludesNormalized(markdown, artifactLabels[artifact], true);
    if (artResult === "none" && labelResult === "none") {
      missingArtifacts.push(artifact);
    } else if ((artResult === "approximate" && labelResult !== "exact") || (labelResult === "approximate" && artResult !== "exact")) {
      approximateArtifacts.push(artifact);
    }
  }
  const successSignal = candidateManifest.verification?.successSignal;
  const successSignalLabel = candidateManifest.verification?.successSignalLabel;
  const successSignalChanged = successSignal !== installedManifest?.verification?.successSignal
    || successSignalLabel !== installedManifest?.verification?.successSignalLabel;
  let missingSuccessSignal = false;
  let approximateSuccessSignal = false;
  if (successSignalChanged && (successSignal || successSignalLabel)) {
    const sigResult = textIncludesNormalized(markdown, successSignal, true);
    const sigLabelResult = textIncludesNormalized(markdown, successSignalLabel, true);
    if (sigResult === "none" && sigLabelResult === "none") {
      missingSuccessSignal = true;
    } else if (
      (sigResult === "approximate" && sigLabelResult !== "exact")
      || (sigLabelResult === "approximate" && sigResult !== "exact")
    ) {
      approximateSuccessSignal = true;
    }
  }

  const missing: string[] = [
    ...missingIntents.map((item) => `intent:${item}`),
    ...missingTools.map((item) => `tool:${item}`),
    ...missingArtifacts.map((item) => `artifact:${item}`),
    ...(missingSuccessSignal ? ["success_signal"] : []),
  ];

  const approximate: string[] = [
    ...approximateArtifacts.map((item) => `artifact:${item} (approximate_match)`),
    ...(approximateSuccessSignal ? ["success_signal (approximate_match)"] : []),
  ];

  const hasIssues = missing.length > 0;
  const detailParts: string[] = [];
  if (!hasIssues) {
    detailParts.push("Candidate SKILL.md reflects the manifest intents, tool requirements, and verification evidence contract.");
    if (approximate.length > 0) {
      detailParts.push(`Approximate token matches used: ${approximate.join(", ")}.`);
    }
  } else {
    detailParts.push(`Candidate SKILL.md is missing manifest capability signals: ${missing.join(", ")}.`);
    if (approximate.length > 0) {
      detailParts.push(`Approximate token matches used: ${approximate.join(", ")}.`);
    }
  }

  return buildCheck(
    "manifest_markdown_capability_consistent",
    !hasIssues,
    detailParts.join(" "),
  );
}

function buildSummary(checks: SkillAuditReport["checks"]): string {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) {
    return "Proposal passed the v1 candidate-aware skill audit checks.";
  }
  return `Proposal failed ${failed.length} audit check(s): ${failed.map((check) => check.name).join(", ")}.`;
}

function classifyAuditFailure(name: string): string {
  if (name.includes("manifest") || name.includes("verification_contract") || name.includes("verification_diff")) {
    return "manifest_contract";
  }
  if (name.includes("markdown") || name.includes("section")) {
    return "markdown_structure";
  }
  if (name.includes("tool") || name.includes("install") || name.includes("runtime") || name.includes("risk")) {
    return "risk_escalation";
  }
  if (name.includes("secret") || name.includes("leakage")) {
    return "safety";
  }
  if (name.includes("reflection")) {
    return "reflection_alignment";
  }
  if (name.includes("candidate_files") || name.includes("patch_is")) {
    return "candidate_materialization";
  }
  return "audit_policy";
}

function buildAuditRemediationHint(check: SkillAuditReport["checks"][number]): string {
  switch (check.name) {
    case "candidate_files_present":
      return "Materialize every target file into the candidate snapshot before re-running audit.";
    case "manifest_schema_valid":
      return "Fix candidate skill.json so it satisfies the skill manifest schema.";
    case "skill_markdown_structure_valid":
      return "Restore Core Procedure, Scenario Extensions, and Appendix sections in candidate SKILL.md.";
    case "patch_is_non_empty_and_scoped":
      return "Keep the proposal limited to the skill's SKILL.md and skill.json, and ensure at least one target changes.";
    case "no_tool_scope_escalation":
      return "Remove newly added required or optional tools unless a human explicitly approves a broader risk profile.";
    case "no_install_source_escalation":
      return "Keep the candidate install source aligned with the installed skill.";
    case "no_runtime_strategy_escalation":
    case "verification_contract_still_executable":
      return "Avoid introducing custom runtime behavior or verification contracts that the current runtime cannot execute.";
    case "no_secret_or_task_leakage":
      return "Remove secrets, bearer tokens, concrete local paths, and task-specific private details from candidate files.";
    case "manifest_markdown_identity_consistent":
      return "Update candidate SKILL.md so it names the same skill id or title as skill.json.";
    case "manifest_markdown_capability_consistent":
      return "Update candidate SKILL.md so its intent, tools, artifacts, and success signal match skill.json.";
    case "verification_contract_diff_scoped":
      return "Limit verification changes to artifact labels, success signal label, and remediation wording.";
    case "verification_diff_quality_linked":
      return "Regenerate proposal quality metadata so verification diffs are marked manifest_verification_only or needs_audit.";
    case "reflection_to_patch_consistency":
      return "Regenerate the proposal so touched files and verification edits match the source reflection action.";
    case "markdown_section_patch_policy":
      return "Move markdown changes into the allowed and preferred sections for the reflection kind.";
    case "risk_tier_audit_profile":
      return "For high-risk skills, keep section policy clean and avoid tool-scope expansion before validation.";
    default:
      return "Inspect the failed audit detail and regenerate the candidate with a narrower, policy-compliant change.";
  }
}

function buildAuditRemediationHints(checks: SkillAuditReport["checks"]): NonNullable<SkillAuditReport["remediationHints"]> {
  return checks
    .filter((check) => !check.passed)
    .map((check) => ({
      check: check.name,
      category: classifyAuditFailure(check.name),
      evidence: check.detail,
      hint: buildAuditRemediationHint(check),
    }));
}

export function auditSkillEvolutionProposal(input: {
  proposal: SkillEvolutionProposal;
  reflection: SkillReflectionRecord | null;
  manifest: SkillManifest | null;
}): SkillAuditReport {
  const { proposal, reflection, manifest } = input;
  const checks: SkillAuditReport["checks"] = [];
  const candidatePaths = resolveCandidatePaths(proposal);
  const allowedTargets = resolveAllowedTargetFiles(proposal.skillId, manifest);
  const candidateManifestPath = candidatePaths.find((entry) => entry.targetFile.endsWith("/skill.json") || entry.targetFile.endsWith("\\skill.json"))?.candidatePath ?? "";
  const liveManifestPath = candidatePaths.find((entry) => entry.targetFile.endsWith("/skill.json") || entry.targetFile.endsWith("\\skill.json"))?.livePath ?? "";
  const candidateMarkdownPath = candidatePaths.find((entry) => entry.targetFile.endsWith("/SKILL.md") || entry.targetFile.endsWith("\\SKILL.md"))?.candidatePath ?? "";
  const liveMarkdownPath = candidatePaths.find((entry) => entry.targetFile.endsWith("/SKILL.md") || entry.targetFile.endsWith("\\SKILL.md"))?.livePath ?? "";
  const candidateManifest = candidateManifestPath && existsSync(candidateManifestPath) ? safeReadManifest(candidateManifestPath) : null;

  checks.push(buildCheck(
    "candidate_files_present",
    candidatePaths.every((entry) => existsSync(entry.candidatePath)),
    candidatePaths.every((entry) => existsSync(entry.candidatePath))
      ? "Candidate files are materialized for every proposal target."
      : "One or more candidate files are missing for the proposal targets.",
  ));

  checks.push(buildCheck(
    "manifest_schema_valid",
    !!candidateManifest && validateSkillManifestShape(candidateManifest).length === 0,
    !candidateManifest
      ? "Candidate skill manifest could not be parsed."
      : validateSkillManifestShape(candidateManifest).length === 0
        ? "Candidate skill manifest is structurally valid."
        : validateSkillManifestShape(candidateManifest).join(" "),
  ));

  if (candidateMarkdownPath) {
    checks.push(checkMarkdownStructure(candidateMarkdownPath));
  } else {
    checks.push(buildCheck(
      "skill_markdown_structure_valid",
      true,
      "No candidate SKILL.md file exists for this proposal; markdown structure enforcement is skipped.",
    ));
  }

  const scoped = proposal.targetFiles.length > 0
    && proposal.targetFiles.every((targetFile) => allowedTargets.has(resolve(PROJECT_ROOT, targetFile)));
  checks.push(buildCheck(
    "patch_is_non_empty_and_scoped",
    scoped && countChangedFiles(candidatePaths) > 0,
    !scoped
      ? "Proposal targets files outside the allowed skill scope."
      : countChangedFiles(candidatePaths) > 0
        ? "Candidate proposal changes only the allowed skill files."
        : "Candidate proposal does not materially change the target skill files.",
  ));

  checks.push(buildCheck(
    "no_tool_scope_escalation",
    !hasToolScopeEscalation(candidateManifest, manifest),
    hasToolScopeEscalation(candidateManifest, manifest)
      ? "Candidate manifest expands required or optional tool scope beyond the installed skill."
      : "Candidate manifest does not expand tool scope.",
  ));

  checks.push(buildCheck(
    "no_install_source_escalation",
    !hasInstallSourceEscalation(candidateManifest, manifest),
    hasInstallSourceEscalation(candidateManifest, manifest)
      ? "Candidate manifest escalates install.source to a disallowed remote source."
      : "Candidate manifest preserves the existing install source.",
  ));

  checks.push(buildCheck(
    "no_runtime_strategy_escalation",
    !hasRuntimeStrategyEscalation(candidateManifest, manifest),
    hasRuntimeStrategyEscalation(candidateManifest, manifest)
      ? "Candidate manifest escalates execution.strategy to custom_runtime."
      : "Candidate manifest preserves a safe runtime strategy.",
  ));

  const candidateTexts = candidatePaths
    .filter((entry) => existsSync(entry.candidatePath))
    .map((entry) => safeReadText(entry.candidatePath))
    .join("\n");
  checks.push(buildCheck(
    "no_secret_or_task_leakage",
    !textHasSecretOrLeakage(candidateTexts),
    textHasSecretOrLeakage(candidateTexts)
      ? "Candidate files appear to contain secrets, tokens, or concrete local paths."
      : "No obvious secret or path leakage signal was detected in candidate files.",
  ));

  const liveManifest = liveManifestPath && existsSync(liveManifestPath) ? safeReadManifest(liveManifestPath) : null;
  checks.push(checkManifestMarkdownConsistency(candidateManifest, candidateMarkdownPath));
  checks.push(checkManifestMarkdownCapabilityConsistency(candidateManifest, liveManifest ?? manifest, candidateMarkdownPath));
  checks.push(checkVerificationContractDiffScope(candidateManifest, liveManifest ?? manifest));
  checks.push(checkVerificationDiffQualityLinkage(proposal, candidateManifest, liveManifest ?? manifest));

  const sectionPolicy = evaluateSkillMarkdownPatchPolicy({
    reflection,
    liveMarkdown: liveMarkdownPath && existsSync(liveMarkdownPath) ? safeReadText(liveMarkdownPath) : "",
    candidateMarkdown: candidateMarkdownPath && existsSync(candidateMarkdownPath) ? safeReadText(candidateMarkdownPath) : "",
  });
  const verificationTouched = JSON.stringify(candidateManifest?.verification ?? null) !== JSON.stringify(liveManifest?.verification ?? null);
  const reflectionConsistent = isReflectionToPatchConsistent({
    reflection,
    verificationTouched,
  });
  checks.push(buildCheck(
    "reflection_to_patch_consistency",
    reflectionConsistent,
    !reflection
      ? "Source reflection could not be resolved for this proposal."
      : reflectionConsistent
        ? "Candidate changes are consistent with the reflection kind and recommended action."
        : "Reflection patch scope crosses the shared PG-1 / PG-4 policy boundary for this proposal.",
  ));
  checks.push(buildCheck(
    "markdown_section_patch_policy",
    sectionPolicy.policyReady,
    sectionPolicy.summary,
  ));

  checks.push(buildCheck(
    "verification_contract_still_executable",
    !manifestHasUnsupportedVerificationContract(candidateManifest, manifest),
    manifestHasUnsupportedVerificationContract(candidateManifest, manifest)
      ? "Candidate manifest introduces a verification/runtime contract the current runtime cannot execute safely."
      : "Candidate manifest preserves an automatically executable verification contract.",
  ));

  const auditRiskTier = inferAuditRiskTier(candidateManifest ?? manifest);
  const manualReviewReason = buildHighRiskManualReviewReason(candidateManifest ?? manifest);
  checks.push(buildCheck(
    "high_risk_manual_review_reason",
    auditRiskTier === "low" || Boolean(manualReviewReason),
    auditRiskTier === "low"
      ? "Low-risk audit profile does not require an explicit manual-review reason."
      : manualReviewReason ?? "High-risk audit profile is missing a manual-review reason.",
  ));
  checks.push(buildCheck(
    "risk_tier_audit_profile",
    auditRiskTier === "low" || (sectionPolicy.policyReady && !hasToolScopeEscalation(candidateManifest, manifest)),
    auditRiskTier === "low"
      ? "Low-risk audit profile completed with baseline structural checks."
      : "High-risk audit profile requires section policy compliance and no tool-scope escalation.",
  ));

  const passed = checks.every((check) => check.passed);
  const remediationHints = buildAuditRemediationHints(checks);
  return {
    proposalId: proposal.id,
    passed,
    checks,
    failureCategories: [...new Set(remediationHints.map((hint) => hint.category))],
    remediationHints,
    summary: buildSummary(checks),
    createdAt: new Date().toISOString(),
  };
}
