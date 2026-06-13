import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WORKSPACE_ROOT } from "./paths.js";
import type { OrchestratorConfig } from "./types.js";
import type { SkillEvolutionProposal, SkillReflectionRecord } from "./skill-evolution-types.js";
import type { SkillManifest } from "./skill-types.js";
import {
  canPatchManifestWhitelist,
  PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST,
  PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY,
  resolveExpectedSkillMarkdownSectionsForReflection,
  SKILL_MARKDOWN_SECTION_TITLES,
} from "./skill-evolution-policy.js";

function describeProposalIntent(reflection: SkillReflectionRecord): string {
  switch (reflection.recommendedAction) {
    case "append_appendix":
      return "Append a scenario-specific appendix with clearer execution guidance and evidence expectations.";
    case "patch_verification":
      return "Adjust verification guidance so the skill contract is clearer and easier to satisfy consistently.";
    case "patch_body":
      return "Revise the core procedure to better match the reflected failure mode and evidence pattern.";
    default:
      return "No direct skill patch is recommended yet.";
  }
}

function buildProposalPatchText(reflection: SkillReflectionRecord): string {
  const bodyChange = reflection.recommendedAction === "append_appendix"
    ? "Keep the stable body unchanged and extend only the appendix guidance."
    : reflection.recommendedAction === "patch_verification"
      ? "Tighten the body-level verification guidance and evidence expectations."
      : "Revise the core body procedure so the skill better handles the reflected scenario.";
  const appendixChange = "Record the reflected scenario and evidence expectations in S_appendix so future runs can avoid the same failure mode.";
  const lines = [
    `# Skill Evolution Proposal for ${reflection.skillId}`,
    `# Source reflection: ${reflection.id}`,
    `# Kind: ${reflection.reflectionKind}`,
    `# Recommended action: ${reflection.recommendedAction}`,
    "",
    "## Summary",
    reflection.reason,
  ];
  if (reflection.evidence.missingRequirements.length > 0) {
    lines.push("", "## Missing Requirements", ...reflection.evidence.missingRequirements.map((item) => `- ${item}`));
  }
  if (reflection.evidence.failedCheckNames.length > 0) {
    lines.push("", "## Failed Checks", ...reflection.evidence.failedCheckNames.map((item) => `- ${item}`));
  }
  lines.push(
    "",
    "## Proposed S_body Change",
    `- ${bodyChange}`,
    "",
    "## Proposed S_appendix Change",
    `- ${appendixChange}`,
    "",
    "## Proposed Change",
    `- ${describeProposalIntent(reflection)}`,
  );
  return lines.join("\n");
}

function buildProposalDiffSummary(
  reflection: SkillReflectionRecord,
  targetFiles: string[],
): NonNullable<SkillEvolutionProposal["diffSummary"]> {
  const changedSections = resolveExpectedSkillMarkdownSectionsForReflection(reflection)
    .map((id) => SKILL_MARKDOWN_SECTION_TITLES[id]);
  const scope = reflection.recommendedAction === "append_appendix"
    ? "appendix_only"
    : reflection.recommendedAction === "patch_verification"
      ? "verification_only"
      : reflection.reflectionKind === "discovery"
        ? "body_and_appendix"
        : "body_only";

  return {
    scope,
    changedSections,
    changedFiles: targetFiles.map((path) => ({
      path,
      summary: path.endsWith("/SKILL.md")
        ? `Update ${changedSections.join(" + ")} guidance.`
        : path.endsWith("/skill.json")
          ? reflection.recommendedAction === "patch_verification"
            ? "Adjust verification whitelist fields only."
            : "Keep manifest contract stable while aligning candidate metadata."
          : "Candidate file updated.",
    })),
  };
}

function buildRationaleEvidenceHighlights(reflection: SkillReflectionRecord): string[] {
  const highlights: string[] = [];
  if (reflection.evidence.failedCheckNames.length > 0) {
    highlights.push(`Failed checks: ${reflection.evidence.failedCheckNames.join(", ")}`);
  }
  if (reflection.evidence.missingRequirements.length > 0) {
    highlights.push(`Missing requirements: ${reflection.evidence.missingRequirements.join(", ")}`);
  }
  if (reflection.evidence.silentBypassSignal) {
    highlights.push("Silent bypass signal detected.");
  }
  if (highlights.length === 0 && reflection.evidence.verificationStatus) {
    highlights.push(`Verification status: ${reflection.evidence.verificationStatus}`);
  }
  return highlights;
}

function describeExpectedOutcome(reflection: SkillReflectionRecord): string {
  switch (reflection.recommendedAction) {
    case "append_appendix":
      return "Make the reflected scenario easier to recognize and handle without destabilizing the core body.";
    case "patch_verification":
      return "Make verification expectations easier to satisfy and easier for validators to inspect.";
    case "patch_body":
      return "Reduce repeated failures by tightening the reusable core procedure.";
    default:
      return "Preserve the live skill until stronger evidence supports a change.";
  }
}

function buildProposalRationaleSummary(
  reflection: SkillReflectionRecord,
): NonNullable<SkillEvolutionProposal["rationaleSummary"]> {
  return {
    reflectionKind: reflection.reflectionKind,
    recommendedAction: reflection.recommendedAction,
    reason: reflection.reason,
    evidenceHighlights: buildRationaleEvidenceHighlights(reflection),
    expectedOutcome: describeExpectedOutcome(reflection),
  };
}

function buildProposalControlPlaneSummary(
  skillId: string,
  diffSummary: NonNullable<SkillEvolutionProposal["diffSummary"]>,
  rationaleSummary: NonNullable<SkillEvolutionProposal["rationaleSummary"]>,
): NonNullable<SkillEvolutionProposal["controlPlaneSummary"]> {
  return {
    title: `${skillId}: ${rationaleSummary.reflectionKind}`,
    changeHeadline: diffSummary.changedFiles.map((item) => item.summary).join(" "),
    rationaleHeadline: rationaleSummary.reason,
    changedFiles: diffSummary.changedFiles.map((item) => item.path),
  };
}

function buildProposalQualitySummary(
  reflection: SkillReflectionRecord,
  diffSummary: NonNullable<SkillEvolutionProposal["diffSummary"]>,
): NonNullable<SkillEvolutionProposal["qualitySummary"]> {
  const reasons: string[] = [];
  let tier: NonNullable<SkillEvolutionProposal["qualitySummary"]>["tier"] = "safe";
  let crossFileConsistency: NonNullable<SkillEvolutionProposal["qualitySummary"]>["crossFileConsistency"] = "manifest_stable";

  if (reflection.reflectionKind === "skill_defect" || reflection.reflectionKind === "optimization") {
    tier = "useful";
    reasons.push("Reflection indicates a reusable improvement to core skill behavior.");
  } else {
    reasons.push("Proposal keeps changes scoped to low-risk scenario guidance.");
  }

  if (reflection.evidence.silentBypassSignal || reflection.evidence.failedCheckNames.length > 0) {
    tier = "regression-risk";
    reasons.push("Reflection includes failure evidence that requires auditor and validation scrutiny.");
  }

  if (reflection.recommendedAction === "patch_verification") {
    crossFileConsistency = "manifest_verification_only";
    reasons.push("Manifest changes must stay within the verification whitelist.");
  } else if (diffSummary.scope === "mixed") {
    crossFileConsistency = "needs_audit";
    tier = "regression-risk";
    reasons.push("Mixed patch scope requires explicit audit before validation.");
  }

  const bodyScopeKinds = new Set(["body_only", "body_and_appendix"]);
  if (
    crossFileConsistency !== "needs_audit" &&
    bodyScopeKinds.has(diffSummary.scope) &&
    (reflection.reflectionKind === "skill_defect" ||
      reflection.evidence.failedCheckNames.length > 0 ||
      reflection.evidence.silentBypassSignal)
  ) {
    crossFileConsistency = "needs_audit";
    reasons.push("Body-scope patch with verification concerns requires cross-file audit before validation.");
  }

  return {
    tier,
    reasons,
    fixtureClass: reflection.reflectionKind,
    crossFileConsistency,
  };
}

function buildProposalTargetFiles(
  skillId: string,
  config: OrchestratorConfig,
  manifest: SkillManifest | null,
): string[] {
  const baseLocation = manifest?.install?.location?.trim().length
    ? manifest.install.location
    : join(config.skills.builtinDir, skillId);
  const baseAbsolutePath = isAbsolute(baseLocation)
    ? resolve(baseLocation)
    : resolve(WORKSPACE_ROOT, baseLocation);
  const relativeBasePath = relative(WORKSPACE_ROOT, baseAbsolutePath);
  if (!relativeBasePath || relativeBasePath.startsWith("..")) {
    throw new Error(`Skill ${skillId} resolves outside the workspace and cannot be evolved safely.`);
  }

  return [
    join(relativeBasePath, "SKILL.md").replace(/\\/g, "/"),
    join(relativeBasePath, "skill.json").replace(/\\/g, "/"),
  ];
}

function appendBulletToMarkdownSection(markdown: string, heading: string, bullet: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingMatcher = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const headingIndex = lines.findIndex((line) => headingMatcher.test(line.trim()));
  if (headingIndex === -1) {
    return `${markdown.trimEnd()}\n\n## ${heading}\n${bullet}\n`;
  }
  let insertIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      insertIndex = index;
      break;
    }
  }
  lines.splice(insertIndex, 0, bullet);
  return `${lines.join("\n").trimEnd()}\n`;
}

function ensureStructuredSkillMarkdown(markdown: string, skillId: string): string {
  let next = markdown.trim().length > 0
    ? markdown
    : [
      `# Skill: ${skillId}`,
      "",
      "## Core Procedure",
      "- Start from the most relevant repository evidence before taking downstream action.",
      "",
      "## Scenario Extensions",
      "- Add scenario-specific guidance here when repeated runs expose a reusable pattern.",
      "",
      "## Appendix",
      "- Capture recurring pitfalls, evidence expectations, and reminders here.",
      "",
    ].join("\n");

  if (!/^#\s+Skill:/im.test(next)) {
    next = `# Skill: ${skillId}\n\n${next.trimStart()}`;
  }
  if (!/^##\s+Core Procedure\s*$/im.test(next)) {
    next = `${next.trimEnd()}\n\n## Core Procedure\n- Establish the stable body steps for this skill.\n`;
  }
  if (!/^##\s+Scenario Extensions\s*$/im.test(next)) {
    next = `${next.trimEnd()}\n\n## Scenario Extensions\n- Add scenario-specific extensions here.\n`;
  }
  if (!/^##\s+Appendix\s*$/im.test(next)) {
    next = `${next.trimEnd()}\n\n## Appendix\n- Capture recurring pitfalls and reminders here.\n`;
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function buildCoreProcedureBullet(reflection: SkillReflectionRecord): string {
  return reflection.recommendedAction === "patch_verification"
    ? `- Clarify the verification-critical steps for the ${reflection.reflectionKind} scenario: ${reflection.reason}`
    : `- Refine the core procedure for the ${reflection.reflectionKind} scenario: ${reflection.reason}`;
}

function buildScenarioExtensionBullet(reflection: SkillReflectionRecord): string {
  return `- Scenario extension (${reflection.reflectionKind}): ${reflection.reason}`;
}

function buildAppendixBullet(reflection: SkillReflectionRecord): string {
  return `- Auto-evolve note (${reflection.reflectionKind}): ${reflection.reason}`;
}

export function buildStructuredSkillMarkdownCandidate(
  reflection: SkillReflectionRecord,
  existingMarkdown: string | null,
  skillId: string,
): string {
  let markdown = ensureStructuredSkillMarkdown(existingMarkdown ?? "", skillId);
  const appendixBullet = buildAppendixBullet(reflection);

  switch (reflection.reflectionKind) {
    case "discovery":
      markdown = appendBulletToMarkdownSection(markdown, "Scenario Extensions", buildScenarioExtensionBullet(reflection));
      if (reflection.recommendedAction !== "append_appendix") {
        markdown = appendBulletToMarkdownSection(markdown, "Core Procedure", buildCoreProcedureBullet(reflection));
      }
      markdown = appendBulletToMarkdownSection(markdown, "Appendix", appendixBullet);
      return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
    case "optimization":
    case "skill_defect":
      markdown = appendBulletToMarkdownSection(markdown, "Core Procedure", buildCoreProcedureBullet(reflection));
      if (reflection.reflectionKind === "skill_defect" && reflection.evidence.failedCheckNames.length > 0) {
        markdown = appendBulletToMarkdownSection(markdown, "Appendix", appendixBullet);
      }
      return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
    case "execution_lapse":
      markdown = appendBulletToMarkdownSection(markdown, "Appendix", appendixBullet);
      return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
    default:
      markdown = appendBulletToMarkdownSection(markdown, "Appendix", appendixBullet);
      return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  }
}

export function buildCandidateManifestContent(
  proposal: SkillEvolutionProposal,
  reflection: SkillReflectionRecord | null,
  existingManifest: SkillManifest | null,
): string {
  const manifest: SkillManifest = existingManifest ? structuredClone(existingManifest) : {
    id: proposal.skillId,
    version: "0.1.0",
    title: proposal.skillId,
    description: "Auto-generated candidate skill manifest.",
    intents: ["coding"],
    keywords: [],
    requiredTools: [],
    install: {
      source: "builtin",
      location: `skills/${proposal.skillId}`,
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "auto_generated",
    },
  };

  const description = typeof manifest.description === "string" ? manifest.description.trim() : "";
  const reflectionTag = reflection ? `[Auto-evolve ${reflection.reflectionKind}: ${reflection.recommendedAction}]` : "[Auto-evolve candidate]";
  manifest.description = `${description}${description ? " " : ""}${reflectionTag}`;

  if (!reflection || !canPatchManifestWhitelist(reflection)) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
  }

  const currentVerification = manifest.verification ?? {};
  const currentArtifactLabels = currentVerification.artifactLabels ?? {};
  const currentRemediation = currentVerification.remediation ?? {};

  const nextVerification = {
    ...currentVerification,
    artifactLabels: { ...currentArtifactLabels },
    remediation: { ...currentRemediation },
  };

  if (reflection.evidence.missingRequirements.length > 0) {
    nextVerification.artifactLabels = {
      ...nextVerification.artifactLabels,
      auto_evolve_missing_requirement: reflection.evidence.missingRequirements.join("; "),
    };
  }
  if (reflection.evidence.failedCheckNames.length > 0) {
    nextVerification.successSignalLabel = `Address reflected checks: ${reflection.evidence.failedCheckNames.join(", ")}`;
    nextVerification.remediation = {
      ...nextVerification.remediation,
      insufficient: `Auto-evolve note: ${reflection.reason}`,
      failed: `Auto-evolve follow-up: ${reflection.reason}`,
    };
  } else {
    nextVerification.remediation = {
      ...nextVerification.remediation,
      insufficient: `Auto-evolve note: ${reflection.reason}`,
    };
  }

  manifest.verification = nextVerification;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function generateSkillEvolutionProposal(input: {
  reflection: SkillReflectionRecord;
  candidateDir: string;
  config: OrchestratorConfig;
  manifest: SkillManifest | null;
}): SkillEvolutionProposal {
  const { reflection, candidateDir, config, manifest } = input;
  const proposalId = `proposal_${randomUUID().slice(0, 8)}`;
  const targetFiles = buildProposalTargetFiles(reflection.skillId, config, manifest);
  const diffSummary = buildProposalDiffSummary(reflection, targetFiles);
  const rationaleSummary = buildProposalRationaleSummary(reflection);
  const controlPlaneSummary = buildProposalControlPlaneSummary(reflection.skillId, diffSummary, rationaleSummary);
  const qualitySummary = buildProposalQualitySummary(reflection, diffSummary);
  return {
    id: proposalId,
    skillId: reflection.skillId,
    sourceReflectionId: reflection.id,
    status: "draft",
    targetFiles,
    diffSummary,
    rationaleSummary,
    controlPlaneSummary,
    qualitySummary,
    patchSummary: `${reflection.skillId}: ${reflection.reflectionKind} -> ${reflection.recommendedAction}`,
    patchText: buildProposalPatchText(reflection),
    candidateDir,
    createdAt: new Date().toISOString(),
  };
}
