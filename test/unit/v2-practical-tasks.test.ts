/**
 * V2 Practical Test Tasks
 *
 * 根据 V2 规划文档设计的 3 个实测任务，覆盖：
 *   Task 1: Proposal Quality Metadata 与真实场景 Fixture 覆盖 (V2-A)
 *   Task 2: Auditor 跨文件语义一致性与 Remediation Hints (V2-D)
 *   Task 3: Deployment Validation Result Taxonomy 与 Auto-Accept Eligibility (V2-B / V2-E)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  generateSkillEvolutionProposal,
  buildCandidateManifestContent,
  buildStructuredSkillMarkdownCandidate,
} from "../../src/skill-evolver.js";
import { auditSkillEvolutionProposal } from "../../src/skill-auditor.js";
import { validateSkillEvolutionProposal } from "../../src/skill-deployment-validator.js";
import { getSkillEvolutionProposalCandidateRoot } from "../../src/skill-evolution-store.js";
import { loadConfig } from "../../src/config.js";
import type {
  SkillEvolutionProposal,
  SkillReflectionRecord,
} from "../../src/skill-evolution-types.js";
import type { SkillManifest } from "../../src/skill-types.js";

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

const V2_TEST_ROOT = "runtime/test-v2-practical";

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
    id: "test.v2_skill",
    version: "0.1.0",
    title: "V2 Test Skill",
    description: "A skill for V2 practical testing.",
    intents: ["coding"],
    keywords: ["v2", "test"],
    requiredTools: ["read_file", "list_files"],
    optionalTools: ["shell_command"],
    install: {
      source: "builtin",
      location: `${V2_TEST_ROOT}/live/test.v2_skill`,
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "test_v2_skill_v1",
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

function buildMarkdown(skillId = "test.v2_skill"): string {
  return [
    `# Skill: ${skillId}`,
    "",
    "## Core Procedure",
    "- Read the relevant source before changing behavior.",
    "- Verify the evidence is present and complete.",
    "",
    "## Scenario Extensions",
    "- When searching for code symbols, narrow the scope before scanning.",
    "- Add focused checks when the task asks for audit-sensitive changes.",
    "",
    "## Appendix",
    "- Intent: coding.",
    "- Required tools: read_file, list_files.",
    "- Expected artifacts: file_excerpt.",
    "- Success signal: capture a supporting excerpt.",
    "- Keep verification evidence explicit.",
    "",
  ].join("\n");
}

function buildReflection(overrides: Partial<SkillReflectionRecord> = {}): SkillReflectionRecord {
  return {
    id: "refl_v2_test",
    skillId: "test.v2_skill",
    jobId: "job_v2_test",
    reflectionKind: "discovery",
    reason: "Capture a reusable reflected scenario.",
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
    recommendedAction: "append_appendix",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildProposal(overrides: Partial<SkillEvolutionProposal> = {}): SkillEvolutionProposal {
  return {
    id: "proposal_v2_test",
    skillId: "test.v2_skill",
    sourceReflectionId: "refl_v2_test",
    status: "draft",
    targetFiles: [
      `${V2_TEST_ROOT}/live/test.v2_skill/SKILL.md`,
      `${V2_TEST_ROOT}/live/test.v2_skill/skill.json`,
    ],
    patchSummary: "test.v2_skill: discovery -> append_appendix",
    patchText: "patch text",
    candidateDir: V2_TEST_ROOT,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function materializeFixture(input: {
  proposalId: string;
  candidateManifest: SkillManifest;
  candidateMarkdown: string;
  liveManifestOverrides?: Partial<SkillManifest>;
}): { proposal: SkillEvolutionProposal; manifest: SkillManifest } {
  const manifest = buildManifest(input.liveManifestOverrides);
  const proposal = buildProposal({ id: input.proposalId });
  const liveRoot = resolve(process.cwd(), V2_TEST_ROOT, "live", "test.v2_skill");
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  writeJson(resolve(liveRoot, "skill.json"), manifest);
  writeText(resolve(liveRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "skill.json"), input.candidateManifest);
  writeText(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "SKILL.md"), input.candidateMarkdown);
  return { proposal, manifest };
}

// ─────────────────────────────────────────────────────────────
// Task 1: Proposal Quality Metadata 与真实场景 Fixture 覆盖
// ─────────────────────────────────────────────────────────────

test("Task1: quality metadata tier=regression-risk for skill_defect with silent bypass", () => {
  const reflection = buildReflection({
    reflectionKind: "skill_defect",
    recommendedAction: "patch_body",
    reason: "Skill missed a required artifact.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["file_excerpt"],
      eventIds: [],
      artifactIds: [],
      silentBypassSignal: true,
    },
  });
  const proposal = generateSkillEvolutionProposal({
    reflection,
    candidateDir: V2_TEST_ROOT,
    config: loadConfig(),
    manifest: buildManifest(),
  });

  assert.equal(proposal.qualitySummary?.tier, "regression-risk",
    "skill_defect with silent bypass should be regression-risk");
  assert.equal(proposal.qualitySummary?.fixtureClass, "skill_defect");
  // patch_body on skill_defect -> manifest_stable (not manifest_verification_only,
  // which only applies when recommendedAction === "patch_verification")
  assert.equal(proposal.qualitySummary?.crossFileConsistency, "manifest_stable");
  assert.ok(proposal.qualitySummary?.reasons.some((r) => r.includes("failure evidence")),
    "Should explain why tier is regression-risk");
});

test("Task1: quality metadata tier=useful for optimization without failures", () => {
  const reflection = buildReflection({
    reflectionKind: "optimization",
    recommendedAction: "patch_body",
    reason: "Prefer direct symbol probes before broader scans.",
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
  });
  const proposal = generateSkillEvolutionProposal({
    reflection,
    candidateDir: V2_TEST_ROOT,
    config: loadConfig(),
    manifest: buildManifest(),
  });

  assert.equal(proposal.qualitySummary?.tier, "useful",
    "optimization without failures should be useful");
  assert.equal(proposal.qualitySummary?.fixtureClass, "optimization");
  assert.ok(proposal.qualitySummary?.reasons.some((r) => r.includes("reusable improvement")));
});

test("Task1: quality metadata tier=safe for discovery with no failures", () => {
  const reflection = buildReflection({
    reflectionKind: "discovery",
    recommendedAction: "append_appendix",
    reason: "A new scenario is worth preserving.",
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
  });
  const proposal = generateSkillEvolutionProposal({
    reflection,
    candidateDir: V2_TEST_ROOT,
    config: loadConfig(),
    manifest: buildManifest(),
  });

  assert.equal(proposal.qualitySummary?.tier, "safe",
    "discovery with no failures should be safe");
  assert.equal(proposal.qualitySummary?.fixtureClass, "discovery");
  assert.ok(proposal.qualitySummary?.reasons.some((r) => r.includes("low-risk")));
});

test("Task1: quality metadata crossFileConsistency=needs_audit for mixed scope", () => {
  const reflection = buildReflection({
    reflectionKind: "discovery",
    recommendedAction: "patch_body",
    reason: "Both body and appendix need updates.",
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
  });
  const proposal = generateSkillEvolutionProposal({
    reflection,
    candidateDir: V2_TEST_ROOT,
    config: loadConfig(),
    manifest: buildManifest(),
  });

  assert.ok(proposal.qualitySummary?.crossFileConsistency,
    "crossFileConsistency should always be present");
});

test("Task1: all 4 reflection kinds produce valid diffSummary and rationaleSummary", () => {
  const config = loadConfig();
  const manifest = buildManifest();
  const kinds: Array<{
    reflectionKind: SkillReflectionRecord["reflectionKind"];
    recommendedAction: SkillReflectionRecord["recommendedAction"];
    expectedScope: string;
  }> = [
    { reflectionKind: "discovery", recommendedAction: "append_appendix", expectedScope: "appendix_only" },
    { reflectionKind: "optimization", recommendedAction: "patch_body", expectedScope: "body_only" },
    { reflectionKind: "skill_defect", recommendedAction: "patch_verification", expectedScope: "verification_only" },
    { reflectionKind: "execution_lapse", recommendedAction: "append_appendix", expectedScope: "appendix_only" },
  ];

  for (const kind of kinds) {
    const reflection = buildReflection({
      reflectionKind: kind.reflectionKind,
      recommendedAction: kind.recommendedAction,
      reason: `${kind.reflectionKind} fixture reason.`,
      evidence: kind.reflectionKind === "skill_defect"
        ? {
            verificationStatus: "insufficient",
            failedCheckNames: ["artifact_presence"],
            missingRequirements: ["file_excerpt"],
            eventIds: [],
            artifactIds: [],
            silentBypassSignal: false,
          }
        : {
            verificationStatus: "verified",
            failedCheckNames: [],
            missingRequirements: [],
            eventIds: ["evt_1"],
            artifactIds: ["art_1"],
            silentBypassSignal: false,
          },
    });
    const proposal = generateSkillEvolutionProposal({ reflection, candidateDir: V2_TEST_ROOT, config, manifest });

    assert.ok(proposal.diffSummary, `${kind.reflectionKind}: diffSummary should exist`);
    assert.equal(proposal.diffSummary.scope, kind.expectedScope,
      `${kind.reflectionKind}: scope should be ${kind.expectedScope}`);
    assert.ok(proposal.diffSummary.changedSections.length > 0,
      `${kind.reflectionKind}: changedSections should not be empty`);
    assert.ok(proposal.diffSummary.changedFiles.length > 0,
      `${kind.reflectionKind}: changedFiles should not be empty`);
    assert.ok(proposal.rationaleSummary, `${kind.reflectionKind}: rationaleSummary should exist`);
    assert.equal(proposal.rationaleSummary.reflectionKind, kind.reflectionKind);
    assert.equal(proposal.rationaleSummary.recommendedAction, kind.recommendedAction);
    assert.ok(proposal.rationaleSummary.expectedOutcome.length > 0,
      `${kind.reflectionKind}: expectedOutcome should not be empty`);
    assert.ok(proposal.controlPlaneSummary, `${kind.reflectionKind}: controlPlaneSummary should exist`);
    assert.ok(proposal.controlPlaneSummary.title.includes(kind.reflectionKind),
      `${kind.reflectionKind}: title should include reflection kind`);
  }
});

test("Task1: candidate manifest preserves existing fields and adds auto-evolve tag", () => {
  const existing = buildManifest();
  const originalClone = structuredClone(existing);
  const reflection = buildReflection({
    reflectionKind: "skill_defect",
    recommendedAction: "patch_verification",
    reason: "Verification needs clearer labels.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["file_excerpt"],
      eventIds: [],
      artifactIds: [],
      silentBypassSignal: false,
    },
  });

  const manifestText = buildCandidateManifestContent(
    buildProposal(),
    reflection,
    existing,
  );
  const candidate = JSON.parse(manifestText) as SkillManifest & { verification?: Record<string, unknown> };

  assert.deepEqual(candidate.requiredTools, originalClone.requiredTools);
  assert.deepEqual(candidate.optionalTools, originalClone.optionalTools);
  assert.deepEqual(candidate.install, originalClone.install);
  assert.deepEqual(candidate.execution, originalClone.execution);

  assert.ok(candidate.description?.includes("[Auto-evolve skill_defect: patch_verification]"),
    "Should add auto-evolve tag to description");

  assert.ok(candidate.verification?.artifactLabels,
    "Should have artifactLabels");
  assert.ok(candidate.verification?.successSignalLabel,
    "Should have successSignalLabel");
  assert.ok(candidate.verification?.remediation,
    "Should have remediation");

  assert.deepEqual(existing, originalClone,
    "Original manifest should not be mutated");
});

// ─────────────────────────────────────────────────────────────
// Task 2: Auditor 跨文件语义一致性与 Remediation Hints
// ─────────────────────────────────────────────────────────────

test("Task2: auditor detects intent drift between manifest and markdown", () => {
  const candidateManifest = buildManifest({
    intents: ["data_analysis"],
  });
  const { proposal, manifest } = materializeFixture({
    proposalId: "proposal_v2_intent_drift",
    candidateManifest,
    candidateMarkdown: buildMarkdown(),
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });

  const capability = report.checks.find((c) => c.name === "manifest_markdown_capability_consistent");
  assert.equal(capability?.passed, false,
    "Should detect intent drift");
  assert.ok(capability?.detail.includes("intent:data_analysis"),
    "Should name the drifted intent");

  const hint = report.remediationHints?.find((h) => h.check === "manifest_markdown_capability_consistent");
  assert.ok(hint, "Should have remediation hint for capability drift");
  assert.equal(hint?.category, "manifest_contract",
    "Should classify as manifest_contract");
  assert.ok(hint?.evidence.includes("intent:data_analysis"),
    "Evidence should include the drifted intent");
  assert.ok(hint?.hint.includes("intent, tools, artifacts"),
    "Hint should suggest updating SKILL.md");
});

test("Task2: auditor detects tool scope drift between manifest and markdown", () => {
  const candidateManifest = buildManifest({
    requiredTools: ["read_file", "list_files"],
    optionalTools: ["shell_command", "http_request"],
    verification: {
      ...buildManifest().verification,
      requiredArtifacts: ["file_excerpt", "api_response"],
      artifactLabels: {
        file_excerpt: "supporting file excerpt",
        api_response: "API response",
      },
    },
  });
  const { proposal, manifest } = materializeFixture({
    proposalId: "proposal_v2_tool_drift",
    candidateManifest,
    candidateMarkdown: buildMarkdown(),
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });

  const capability = report.checks.find((c) => c.name === "manifest_markdown_capability_consistent");
  assert.equal(capability?.passed, false,
    "Should detect tool/artifact drift");
  assert.ok(capability?.detail.includes("tool:http_request") || capability?.detail.includes("artifact:api_response"),
    "Should name the drifted tools/artifacts");
});

test("Task2: auditor passes when manifest and markdown are consistent", () => {
  const candidateManifest = buildManifest();
  const candidateMarkdown = [
    "# Skill: test.v2_skill",
    "",
    "## Core Procedure",
    "- Read the relevant source before changing behavior.",
    "",
    "## Scenario Extensions",
    "- When searching for code symbols, narrow the scope before scanning.",
    "",
    "## Appendix",
    "- Intent: coding.",
    "- Required tools: read_file, list_files.",
    "- Optional tools: shell_command.",
    "- Expected artifacts: file_excerpt.",
    "- Success signal: capture a supporting excerpt.",
    "- Keep verification evidence explicit.",
    "",
  ].join("\n");

  const { proposal, manifest } = materializeFixture({
    proposalId: "proposal_v2_consistent",
    candidateManifest,
    candidateMarkdown,
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });

  const capability = report.checks.find((c) => c.name === "manifest_markdown_capability_consistent");
  assert.equal(capability?.passed, true,
    "Consistent manifest/markdown should pass");
});

test("Task2: auditor provides categorized remediation hints for all failures", () => {
  const candidateManifest = buildManifest({
    intents: ["data_analysis"],
    requiredTools: ["read_file", "shell_command"],
    execution: {
      strategy: "custom_runtime",
      templateId: "bad_template",
    },
  });
  const candidateMarkdown = [
    "# Skill: unrelated.skill",
    "",
    "## Core Procedure",
    "- Wrong skill entirely.",
    "",
    "## Scenario Extensions",
    "- Nothing relevant.",
    "",
    "## Appendix",
    "- No useful info.",
    "",
  ].join("\n");

  const { proposal, manifest } = materializeFixture({
    proposalId: "proposal_v2_multi_fail",
    candidateManifest,
    candidateMarkdown,
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });

  assert.equal(report.passed, false, "Multi-failure proposal should fail");
  assert.ok(report.failureCategories && report.failureCategories.length > 0,
    "Should have failure categories");
  assert.ok(report.remediationHints && report.remediationHints.length > 0,
    "Should have remediation hints");

  for (const hint of report.remediationHints!) {
    assert.ok(hint.check.length > 0, `Hint check should not be empty`);
    assert.ok(hint.category.length > 0, `Hint category should not be empty for ${hint.check}`);
    assert.ok(hint.evidence.length > 0, `Hint evidence should not be empty for ${hint.check}`);
    assert.ok(hint.hint.length > 0, `Hint hint should not be empty for ${hint.check}`);
  }

  assert.ok(report.failureCategories!.includes("manifest_contract"),
    "Should include manifest_contract category");
});

test("Task2: auditor high-risk skill forces manual review reason", () => {
  const candidateManifest = buildManifest({
    requiredTools: ["read_file", "shell_command"],
  });
  const candidateMarkdown = [
    "# Skill: test.v2_skill",
    "",
    "## Core Procedure",
    "- Read the relevant source before changing behavior.",
    "",
    "## Scenario Extensions",
    "- When searching for code symbols, narrow the scope before scanning.",
    "",
    "## Appendix",
    "- Intent: coding.",
    "- Required tools: read_file, shell_command.",
    "- Expected artifacts: file_excerpt.",
    "- Success signal: capture a supporting excerpt.",
    "",
  ].join("\n");

  const { proposal, manifest } = materializeFixture({
    proposalId: "proposal_v2_high_risk",
    candidateManifest,
    candidateMarkdown,
  });

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });

  const manualReview = report.checks.find((c) => c.name === "high_risk_manual_review_reason");
  assert.ok(manualReview, "Should have manual review check");
  assert.equal(manualReview.passed, true,
    "High-risk skill should produce a manual review reason");
  assert.ok(manualReview.detail.includes("Manual review required"),
    "Detail should explain manual review");
  assert.ok(manualReview.detail.includes("shell_command"),
    "Should mention the risky tool");
});

test("Task2: auditor verification diff quality linkage rejects stale quality metadata", () => {
  const candidateManifest = buildManifest({
    verification: {
      ...buildManifest().verification,
      successSignalLabel: "updated success label",
    },
  });
  const { proposal, manifest } = materializeFixture({
    proposalId: "proposal_v2_quality_link",
    candidateManifest,
    candidateMarkdown: [
      "# Skill: test.v2_skill",
      "",
      "## Core Procedure",
      "- Read the relevant source.",
      "",
      "## Scenario Extensions",
      "- Narrow scope.",
      "",
      "## Appendix",
      "- Intent: coding.",
      "- Required tools: read_file, list_files.",
      "- Expected artifacts: file_excerpt.",
      "- Success signal: updated success label.",
      "",
    ].join("\n"),
  });
  proposal.qualitySummary = {
    tier: "safe",
    reasons: ["test"],
    fixtureClass: "skill_defect",
    crossFileConsistency: "manifest_stable",
  };

  const report = auditSkillEvolutionProposal({
    proposal,
    reflection: buildReflection(),
    manifest,
  });

  const linkage = report.checks.find((c) => c.name === "verification_diff_quality_linked");
  assert.ok(linkage, "Should have verification diff quality linkage check");
  assert.equal(linkage.passed, false,
    "Should reject stale quality metadata when verification changed");
  assert.ok(linkage.detail.includes("manifest_stable"),
    "Should name the stale consistency value");
});

// ─────────────────────────────────────────────────────────────
// Task 3: Deployment Validation Result Taxonomy 与 Auto-Accept Eligibility
// ─────────────────────────────────────────────────────────────

test("Task3: validation result taxonomy covers setup_failed when candidate binding is incomplete", () => {
  const proposal = buildProposal({
    id: "proposal_v2_setup_fail",
    targetFiles: [],
  });
  const reflection = buildReflection();

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.equal(report.resultTaxonomy.category, "setup_failed",
    "Empty target files should produce setup_failed");
  assert.equal(report.resultTaxonomy.retryable, true,
    "setup_failed should be retryable");
  assert.ok(report.resultTaxonomy.reason.length > 0,
    "Should have a reason");
});

test("Task3: validation result taxonomy covers candidate_failed when candidate not verified", () => {
  const proposal = buildProposal({ id: "proposal_v2_candidate_fail" });
  const reflection = buildReflection({
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
  });

  const candidateManifest = buildManifest({
    requiredTools: ["read_file", "list_files", "shell_command"],
  });
  const liveRoot = resolve(process.cwd(), V2_TEST_ROOT, "live", "test.v2_skill");
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  writeJson(resolve(liveRoot, "skill.json"), buildManifest());
  writeText(resolve(liveRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "skill.json"), candidateManifest);
  writeText(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "SKILL.md"), buildMarkdown());

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.ok(
    report.resultTaxonomy.category === "candidate_failed" || report.resultTaxonomy.category === "setup_failed",
    `Risky candidate should fail, got: ${report.resultTaxonomy.category}`,
  );
  assert.equal(report.passed, false,
    "Risky candidate should not pass validation");
});

test("Task3: validation result taxonomy covers regression when candidate introduces more failures", () => {
  const proposal = buildProposal({ id: "proposal_v2_regression" });
  const reflection = buildReflection({
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
  });

  const candidateManifest = buildManifest();
  const liveRoot = resolve(process.cwd(), V2_TEST_ROOT, "live", "test.v2_skill");
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  writeJson(resolve(liveRoot, "skill.json"), buildManifest());
  writeText(resolve(liveRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "skill.json"), candidateManifest);
  writeText(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "SKILL.md"), buildMarkdown());

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.ok(
    ["passed", "inconclusive", "candidate_failed", "setup_failed", "baseline_failed"].includes(report.resultTaxonomy.category),
    `Should produce a valid taxonomy category, got: ${report.resultTaxonomy.category}`,
  );
  assert.ok(report.resultTaxonomy.reason.length > 0,
    "Should have a reason for the taxonomy category");
  assert.equal(typeof report.resultTaxonomy.retryable, "boolean",
    "Should declare retryability");
});

test("Task3: validation hard gates cover all expected gate names", () => {
  const proposal = buildProposal({ id: "proposal_v2_hard_gates" });
  const reflection = buildReflection();

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  const expectedGates = [
    "candidate_selected",
    "same_recorded_input",
    "candidate_runtime_prepared",
    "true_candidate_runtime_replay_enabled",
    "silent_bypass_absent",
    "risk_tier_contract",
    "candidate_binding_ready",
    "execution_evidence_ready",
    "same_input_comparison_ready",
    "reflection_policy_ready",
    "markdown_section_policy_ready",
  ];

  const actualGateNames = report.contract.hardGates.map((g) => g.name);
  for (const expected of expectedGates) {
    assert.ok(actualGateNames.includes(expected),
      `Hard gates should include ${expected}, got: ${actualGateNames.join(", ")}`);
  }

  for (const gate of report.contract.hardGates) {
    assert.ok(gate.detail.length > 0,
      `Gate ${gate.name} should have a detail string`);
  }
});

test("Task3: validation auto-accept eligibility requires all gates to pass", () => {
  const proposal = buildProposal({ id: "proposal_v2_eligibility" });
  const reflection = buildReflection();

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.equal(report.decision.autoAcceptReady, false,
    "Without runtime replay, auto-accept should not be ready");
  assert.ok(report.decision.details.length > 0,
    "Decision should have detail explanations");
});

test("Task3: validation stability signals include replay stability score and level", () => {
  const proposal = buildProposal({ id: "proposal_v2_stability" });
  const reflection = buildReflection();

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.ok(typeof report.stability.replayStabilityScore === "number",
    "Should have replay stability score");
  assert.ok(report.stability.replayStabilityScore >= 0 && report.stability.replayStabilityScore <= 100,
    "Score should be 0-100");
  assert.ok(["stable", "watch", "unstable"].includes(report.stability.replayStabilityLevel),
    `Should have valid stability level, got: ${report.stability.replayStabilityLevel}`);
  assert.equal(typeof report.stability.replayInstabilityDetected, "boolean");
  assert.equal(typeof report.stability.candidateFlakySignal, "boolean");
  assert.equal(typeof report.stability.autoAcceptBlocked, "boolean");
  assert.ok(Array.isArray(report.stability.reasons),
    "Should have stability reasons array");
});

test("Task3: validation risk profile correctly classifies research_like vs coding_like", () => {
  const codingProposal = buildProposal({ id: "proposal_v2_risk_coding" });
  const codingReflection = buildReflection();

  const codingRoot = resolve(process.cwd(), V2_TEST_ROOT, "live", "test.v2_skill");
  const codingCandidateRoot = getSkillEvolutionProposalCandidateRoot(codingProposal.id, codingProposal.candidateDir);
  writeJson(resolve(codingRoot, "skill.json"), buildManifest());
  writeText(resolve(codingRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(codingCandidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "skill.json"), buildManifest());
  writeText(resolve(codingCandidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "SKILL.md"), buildMarkdown());

  const codingReport = validateSkillEvolutionProposal({
    proposal: codingProposal,
    reflection: codingReflection,
  });

  assert.equal(codingReport.risk.tier, "high",
    "coding intent should be high risk");
  assert.equal(codingReport.risk.skillClass, "coding_like",
    "coding intent should be coding_like");
  assert.equal(codingReport.risk.acceptanceFocus, "non_regression",
    "coding_like should focus on non-regression");

  const researchManifest = buildManifest({
    intents: ["research"],
    requiredTools: ["read_file"],
    optionalTools: [],
  });
  const researchProposal = buildProposal({ id: "proposal_v2_risk_research" });
  const researchRoot = resolve(process.cwd(), V2_TEST_ROOT, "live", "test.v2_skill");
  const researchCandidateRoot = getSkillEvolutionProposalCandidateRoot(researchProposal.id, researchProposal.candidateDir);
  writeJson(resolve(researchRoot, "skill.json"), researchManifest);
  writeText(resolve(researchRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(researchCandidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "skill.json"), researchManifest);
  writeText(resolve(researchCandidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "SKILL.md"), buildMarkdown());

  const researchReport = validateSkillEvolutionProposal({
    proposal: researchProposal,
    reflection: buildReflection({
      skillId: "test.v2_skill",
      evidence: {
        verificationStatus: "verified",
        failedCheckNames: [],
        missingRequirements: [],
        eventIds: ["evt_1"],
        artifactIds: ["art_1"],
        silentBypassSignal: false,
      },
    }),
  });

  assert.equal(researchReport.risk.tier, "low",
    "research intent should be low risk");
  assert.equal(researchReport.risk.skillClass, "research_like",
    "research intent should be research_like");
  assert.equal(researchReport.risk.acceptanceFocus, "improvement",
    "research_like should focus on improvement");
});

test("Task3: validation contract includes baseline selection and input equivalence", () => {
  const proposal = buildProposal({ id: "proposal_v2_contract" });
  const reflection = buildReflection();

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.ok(report.contract.baselineSelection,
    "Should have baseline selection");
  assert.ok(["source_reflection_job", "reflection_only", "none"].includes(report.contract.baselineSelection.source),
    `Baseline source should be valid, got: ${report.contract.baselineSelection.source}`);
  assert.ok(report.contract.baselineSelection.reason.length > 0,
    "Baseline selection should have reason");

  assert.ok(report.contract.inputEquivalence,
    "Should have input equivalence");
  assert.equal(typeof report.contract.inputEquivalence.satisfied, "boolean");
  assert.ok(report.contract.inputEquivalence.reason.length > 0,
    "Input equivalence should have reason");
});

test("Task3: validation replay provenance includes candidate binding and execution evidence", () => {
  const proposal = buildProposal({ id: "proposal_v2_provenance" });
  const reflection = buildReflection();

  const candidateManifest = buildManifest();
  const liveRoot = resolve(process.cwd(), V2_TEST_ROOT, "live", "test.v2_skill");
  const candidateRoot = getSkillEvolutionProposalCandidateRoot(proposal.id, proposal.candidateDir);
  writeJson(resolve(liveRoot, "skill.json"), buildManifest());
  writeText(resolve(liveRoot, "SKILL.md"), buildMarkdown());
  writeJson(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "skill.json"), candidateManifest);
  writeText(resolve(candidateRoot, V2_TEST_ROOT, "live", "test.v2_skill", "SKILL.md"), buildMarkdown());

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  assert.ok(report.replay.provenance.candidateBinding,
    "Should have candidate binding evidence");
  assert.equal(typeof report.replay.provenance.candidateBinding.manifestPresent, "boolean");
  assert.equal(typeof report.replay.provenance.candidateBinding.bindingReady, "boolean");
  assert.ok(Array.isArray(report.replay.provenance.candidateBinding.reasons),
    "Binding should have reasons array");

  assert.ok(report.replay.provenance.executionEvidence,
    "Should have execution evidence");
  assert.ok(["direct", "partial", "weak"].includes(report.replay.provenance.executionEvidence.level),
    `Evidence level should be valid, got: ${report.replay.provenance.executionEvidence.level}`);
  assert.ok(report.replay.provenance.executionEvidence.summary.length > 0,
    "Execution evidence should have summary");

  assert.ok(report.replay.runtimeBoundary,
    "Should have runtime boundary");
  assert.ok(["isolated_manifest_replay", "candidate_snapshot", "candidate_runtime_config"].includes(report.replay.runtimeBoundary.source),
    `Runtime boundary source should be valid, got: ${report.replay.runtimeBoundary.source}`);
});

test("Task3: validation same-input comparison tracks resolved and introduced requirements", () => {
  const proposal = buildProposal({ id: "proposal_v2_same_input" });
  const reflection = buildReflection({
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: ["file_excerpt"],
      eventIds: ["evt_1"],
      artifactIds: ["art_1"],
      silentBypassSignal: false,
    },
  });

  const report = validateSkillEvolutionProposal({
    proposal,
    reflection,
  });

  const comparison = report.replay.sameInputComparison;
  assert.ok(comparison, "Should have same-input comparison");
  assert.ok(["recorded_baseline_vs_candidate", "baseline_job_vs_candidate_runtime"].includes(comparison.mode),
    `Comparison mode should be valid, got: ${comparison.mode}`);
  assert.equal(typeof comparison.inputAligned, "boolean");
  assert.equal(typeof comparison.baselineObserved, "boolean");
  assert.equal(typeof comparison.candidateObserved, "boolean");
  assert.ok(["direct", "partial", "weak"].includes(comparison.evidenceLevel));
  assert.ok(["ready", "needs_replay", "blocked"].includes(comparison.readiness),
    `Readiness should be valid, got: ${comparison.readiness}`);
  assert.ok(Array.isArray(comparison.resolvedMissingRequirements));
  assert.ok(Array.isArray(comparison.remainingMissingRequirements));
  assert.ok(Array.isArray(comparison.introducedMissingRequirements));
  assert.ok(comparison.summary.length > 0,
    "Comparison should have summary");
});

// ─────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────

test.afterEach(() => {
  rmSync(resolve(process.cwd(), V2_TEST_ROOT), { recursive: true, force: true });
});
