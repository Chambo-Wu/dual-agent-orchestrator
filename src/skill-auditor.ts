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

function inferAuditRiskTier(manifest: SkillManifest | null): "low" | "high" {
  const intents = new Set(manifest?.intents ?? []);
  const tools = new Set([...(manifest?.requiredTools ?? []), ...(manifest?.optionalTools ?? [])]);
  return intents.has("coding") || intents.has("file_ops") || tools.has("shell_command")
    ? "high"
    : "low";
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, " ").trim();
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

function buildSummary(checks: SkillAuditReport["checks"]): string {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) {
    return "Proposal passed the v1 candidate-aware skill audit checks.";
  }
  return `Proposal failed ${failed.length} audit check(s): ${failed.map((check) => check.name).join(", ")}.`;
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
  checks.push(checkVerificationContractDiffScope(candidateManifest, liveManifest ?? manifest));

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
  checks.push(buildCheck(
    "risk_tier_audit_profile",
    auditRiskTier === "low" || (sectionPolicy.policyReady && !hasToolScopeEscalation(candidateManifest, manifest)),
    auditRiskTier === "low"
      ? "Low-risk audit profile completed with baseline structural checks."
      : "High-risk audit profile requires section policy compliance and no tool-scope escalation.",
  ));

  const passed = checks.every((check) => check.passed);
  return {
    proposalId: proposal.id,
    passed,
    checks,
    summary: buildSummary(checks),
    createdAt: new Date().toISOString(),
  };
}
