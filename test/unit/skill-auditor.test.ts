import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditSkillEvolutionProposal } from "../../src/skill-auditor.js";
import { getSkillEvolutionProposalCandidateRoot } from "../../src/skill-evolution-store.js";
import type { SkillEvolutionProposal, SkillReflectionRecord } from "../../src/skill-evolution-types.js";
import type { SkillManifest } from "../../src/skill-types.js";

const AUDITOR_TEST_ROOT = "runtime/test-skill-auditor";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function buildManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: "test.audit_skill",
    version: "0.1.0",
    title: "Audit Test Skill",
    description: "Exercise auditor policy checks.",
    intents: ["coding"],
    keywords: ["audit"],
    requiredTools: ["read_file"],
    install: {
      source: "builtin",
      location: `${AUDITOR_TEST_ROOT}/live/test.audit_skill`,
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "test_audit_skill_v1",
    },
    verification: {
      requiredArtifacts: ["file_excerpt"],
      successSignal: "excerpt_present",
      artifactLabels: {
        file_excerpt: "supporting file excerpt",
      },
      successSignalLabel: "capture a supporting excerpt",
      remediation: {
        insufficient: "Capture the missing excerpt.",
        failed: "Repair invalid evidence.",
      },
    },
    ...overrides,
  };
}

function buildMarkdown(title = "test.audit_skill"): string {
  return [
    `# Skill: ${title}`,
    "",
    "## Core Procedure",
    "- Read the relevant source before changing behavior.",
    "",
    "## Scenario Extensions",
    "- Add focused checks when the task asks for audit-sensitive changes.",
    "",
    "## Appendix",
    "- Intent: coding.",
    "- Required tools: read_file.",
    "- Expected artifacts: file_excerpt.",
    "- Success signal: capture a supporting excerpt.",
    "- Keep verification evidence explicit.",
    "",
  ].join("\n");
}

function buildReflection(overrides: Partial<SkillReflectionRecord> = {}): SkillReflectionRecord {
  return {
    id: "refl_auditor_test",
    skillId: "test.audit_skill",
    jobId: "job_auditor_test",
    reflectionKind: "skill_defect",
    reason: "Verification wording needs a safe update.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["file_excerpt"],
      eventIds: [],
      artifactIds: [],
    },
    recommendedAction: "patch_verification",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildProposal(id: string): SkillEvolutionProposal {
  return {
    id,
    skillId: "test.audit_skill",
    sourceReflectionId: "refl_auditor_test",
    status: "draft",
    targetFiles: [
      `${AUDITOR_TEST_ROOT}/live/test.audit_skill/SKILL.md`,
      `${AUDITOR_TEST_ROOT}/live/test.audit_skill/skill.json`,
    ],
    patchSummary: "test.audit_skill: skill_defect -> patch_verification",
    patchText: "patch",
    candidateDir: AUDITOR_TEST_ROOT,
    createdAt: new Date().toISOString(),
    qualitySummary: {
      tier: "safe",
      reasons: ["test fixture"],
      fixtureClass: "skill_defect",
      crossFileConsistency: "manifest_verification_only",
    },
  };
}

function materializeAuditFixture(input: {
  proposalId: string;
  candidateManifest: SkillManifest;
  candidateMarkdown: string;
}): {
  proposal: SkillEvolutionProposal;
  manifest: SkillManifest;
} {
  const manifest = buildManifest();
  const proposal = buildProposal(input.proposalId);
  const liveRoot = resolve(process.cwd(), AUDITOR_TEST_ROOT, "live", "test.audit_skill");
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  writeJson(resolve(liveRoot, "skill.json"), manifest);
  writeText(resolve(liveRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(candidateRoot, AUDITOR_TEST_ROOT, "live", "test.audit_skill", "skill.json"), input.candidateManifest);
  writeText(resolve(candidateRoot, AUDITOR_TEST_ROOT, "live", "test.audit_skill", "SKILL.md"), input.candidateMarkdown);
  return { proposal, manifest };
}

test.afterEach(() => {
  rmSync(resolve(process.cwd(), AUDITOR_TEST_ROOT), { recursive: true, force: true });
});

test("auditor gate v2 rejects forbidden verification contract diffs", () => {
  const candidateManifest = buildManifest({
    verification: {
      ...buildManifest().verification,
      requiredArtifacts: ["file_excerpt", "extra_trace"],
    },
  });
  const { proposal, manifest } = materializeAuditFixture({
    proposalId: "proposal_auditor_forbidden_verification",
    candidateManifest,
    candidateMarkdown: buildMarkdown(),
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });
  const verificationScope = report.checks.find((check) => check.name === "verification_contract_diff_scoped");

  assert.equal(report.passed, false);
  assert.equal(verificationScope?.passed, false);
  assert.equal(verificationScope?.detail.includes("verification.requiredArtifacts"), true);
  assert.equal(report.failureCategories?.includes("manifest_contract"), true);
  assert.equal(report.remediationHints?.some((hint) =>
    hint.check === "verification_contract_diff_scoped"
    && hint.category === "manifest_contract"
    && hint.evidence.includes("verification.requiredArtifacts")
    && hint.hint.includes("Limit verification changes")
  ), true);
});

test("auditor gate v2 rejects manifest and markdown identity drift", () => {
  const { proposal, manifest } = materializeAuditFixture({
    proposalId: "proposal_auditor_identity_drift",
    candidateManifest: buildManifest(),
    candidateMarkdown: buildMarkdown("unrelated.skill"),
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });
  const identity = report.checks.find((check) => check.name === "manifest_markdown_identity_consistent");

  assert.equal(report.passed, false);
  assert.equal(identity?.passed, false);
  assert.equal(report.remediationHints?.some((hint) =>
    hint.check === "manifest_markdown_identity_consistent"
    && hint.category === "manifest_contract"
    && hint.hint.includes("same skill id or title")
  ), true);
});

test("auditor gate v2 rejects manifest and markdown capability drift", () => {
  const candidateManifest = buildManifest({
    intents: ["data_analysis"],
    requiredTools: ["read_file"],
    optionalTools: ["web_search"],
    verification: {
      ...buildManifest().verification,
      requiredArtifacts: ["chart_summary"],
      artifactLabels: {
        chart_summary: "chart summary",
      },
      successSignal: "chart_summary_ready",
      successSignalLabel: "produce a chart summary",
    },
  });
  const { proposal, manifest } = materializeAuditFixture({
    proposalId: "proposal_auditor_capability_drift",
    candidateManifest,
    candidateMarkdown: buildMarkdown(),
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });
  const capability = report.checks.find((check) => check.name === "manifest_markdown_capability_consistent");

  assert.equal(report.passed, false);
  assert.equal(capability?.passed, false);
  assert.equal(capability?.detail.includes("intent:data_analysis"), true);
  assert.equal(capability?.detail.includes("tool:web_search"), true);
  assert.equal(capability?.detail.includes("artifact:chart_summary"), true);
  assert.equal(capability?.detail.includes("success_signal"), true);
  assert.equal(report.failureCategories?.includes("manifest_contract"), true);
  assert.equal(report.remediationHints?.some((hint) =>
    hint.check === "manifest_markdown_capability_consistent"
    && hint.evidence.includes("intent:data_analysis")
    && hint.hint.includes("intent, tools, artifacts")
  ), true);
});

test("auditor gate v2 records a manual review reason for high-risk skills", () => {
  const { proposal, manifest } = materializeAuditFixture({
    proposalId: "proposal_auditor_high_risk_manual_review_reason",
    candidateManifest: buildManifest({
      requiredTools: ["read_file", "shell_command"],
    }),
    candidateMarkdown: [
      "# Skill: test.audit_skill",
      "",
      "## Core Procedure",
      "- Read the relevant source before changing behavior.",
      "",
      "## Scenario Extensions",
      "- Add focused checks when the task asks for audit-sensitive changes.",
      "",
      "## Appendix",
      "- Intent: coding.",
      "- Required tools: read_file, shell_command.",
      "- Expected artifacts: file_excerpt.",
      "- Success signal: capture a supporting excerpt.",
      "- Keep verification evidence explicit.",
      "",
    ].join("\n"),
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });
  const manualReview = report.checks.find((check) => check.name === "high_risk_manual_review_reason");

  assert.equal(manualReview?.passed, true);
  assert.equal(manualReview?.detail.includes("Manual review required for high-risk skill"), true);
  assert.equal(manualReview?.detail.includes("coding intent"), true);
  assert.equal(manualReview?.detail.includes("shell_command"), true);
  assert.equal(report.remediationHints?.some((hint) =>
    hint.check === "no_tool_scope_escalation"
    && hint.category === "risk_escalation"
    && hint.hint.includes("Remove newly added")
  ), true);
});

test("auditor gate v2 links verification diffs to proposal quality metadata", () => {
  const candidateManifest = buildManifest({
    verification: {
      ...buildManifest().verification,
      successSignalLabel: "capture an explicit supporting excerpt",
    },
  });
  const { proposal, manifest } = materializeAuditFixture({
    proposalId: "proposal_auditor_verification_quality_linkage",
    candidateManifest,
    candidateMarkdown: [
      "# Skill: test.audit_skill",
      "",
      "## Core Procedure",
      "- Read the relevant source before changing behavior.",
      "",
      "## Scenario Extensions",
      "- Add focused checks when the task asks for audit-sensitive changes.",
      "",
      "## Appendix",
      "- Intent: coding.",
      "- Required tools: read_file.",
      "- Expected artifacts: file_excerpt.",
      "- Success signal: capture an explicit supporting excerpt.",
      "- Keep verification evidence explicit.",
      "",
    ].join("\n"),
  });
  proposal.qualitySummary = {
    tier: "safe",
    reasons: ["incorrect test fixture"],
    fixtureClass: "skill_defect",
    crossFileConsistency: "manifest_stable",
  };

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });
  const linkage = report.checks.find((check) => check.name === "verification_diff_quality_linked");

  assert.equal(report.passed, false);
  assert.equal(linkage?.passed, false);
  assert.equal(linkage?.detail.includes("manifest_stable"), true);
  assert.equal(report.remediationHints?.some((hint) =>
    hint.check === "verification_diff_quality_linked"
    && hint.category === "manifest_contract"
    && hint.hint.includes("verification diffs")
  ), true);
});
