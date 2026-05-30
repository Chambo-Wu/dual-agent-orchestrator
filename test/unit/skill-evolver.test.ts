import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateManifestContent,
  buildStructuredSkillMarkdownCandidate,
  generateSkillEvolutionProposal,
} from "../../src/skill-evolver.js";
import {
  evaluateSkillMarkdownPatchPolicy,
  canPatchManifestWhitelist,
  hasRiskyManifestEscalation,
  isReflectionToPatchConsistent,
  PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST,
  PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY,
} from "../../src/skill-evolution-policy.js";
import { loadConfig } from "../../src/config.js";
import type { SkillEvolutionProposal } from "../../src/skill-evolution-types.js";
import type { SkillReflectionRecord } from "../../src/skill-evolution-types.js";

function buildReflection(overrides: Partial<SkillReflectionRecord> = {}): SkillReflectionRecord {
  return {
    id: "refl_test",
    skillId: "find.code_symbol",
    jobId: "job_test",
    reflectionKind: "discovery",
    reason: "Capture a reusable reflected scenario.",
    evidence: {
      verificationStatus: "verified",
      failedCheckNames: [],
      missingRequirements: [],
      eventIds: [],
      artifactIds: [],
      silentBypassSignal: false,
    },
    recommendedAction: "append_appendix",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildProposal(): SkillEvolutionProposal {
  return {
    id: "proposal_test",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_test",
    status: "draft",
    targetFiles: ["skills/find.code_symbol/SKILL.md", "skills/find.code_symbol/skill.json"],
    patchSummary: "find.code_symbol: skill_defect -> patch_verification",
    patchText: "patch",
    candidateDir: "runtime/skill-evolution",
    createdAt: new Date().toISOString(),
  };
}

function sectionBody(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`(^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"));
  return match?.[2]?.trim() ?? "";
}

function buildStructuredBaseMarkdown(): string {
  return [
    "# Skill: find.code_symbol",
    "",
    "## Core Procedure",
    "- Existing stable step.",
    "",
    "## Scenario Extensions",
    "- Existing scenario step.",
    "",
    "## Appendix",
    "- Existing appendix note.",
    "",
  ].join("\n");
}

test("discovery candidate markdown prefers scenario extensions and appendix", () => {
  const markdown = buildStructuredSkillMarkdownCandidate(buildReflection({
    reflectionKind: "discovery",
    recommendedAction: "append_appendix",
    reason: "A new scenario is worth preserving.",
  }), "# Skill: find.code_symbol\n", "find.code_symbol");

  assert.equal(/##\s+Scenario Extensions[\s\S]*Scenario extension \(discovery\): A new scenario is worth preserving\./i.test(markdown), true);
  assert.equal(/##\s+Appendix[\s\S]*Auto-evolve note \(discovery\): A new scenario is worth preserving\./i.test(markdown), true);
});

test("proposal generator v2 fixtures route reflection kinds to expected markdown sections", () => {
  const baseMarkdown = buildStructuredBaseMarkdown();
  const fixtures = [
    {
      reflectionKind: "discovery" as const,
      recommendedAction: "append_appendix" as const,
      reason: "Capture a reusable search narrowing pattern.",
      expected: {
        core: false,
        scenario: "Scenario extension (discovery): Capture a reusable search narrowing pattern.",
        appendix: "Auto-evolve note (discovery): Capture a reusable search narrowing pattern.",
      },
    },
    {
      reflectionKind: "optimization" as const,
      recommendedAction: "patch_body" as const,
      reason: "Prefer direct symbol probes before broader scans.",
      expected: {
        core: "Refine the core procedure for the optimization scenario: Prefer direct symbol probes before broader scans.",
        scenario: false,
        appendix: false,
      },
    },
    {
      reflectionKind: "skill_defect" as const,
      recommendedAction: "patch_body" as const,
      reason: "The skill missed a required file excerpt.",
      evidence: {
        verificationStatus: "insufficient" as const,
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["file_excerpt"],
        eventIds: [],
        artifactIds: [],
        silentBypassSignal: false,
      },
      expected: {
        core: "Refine the core procedure for the skill_defect scenario: The skill missed a required file excerpt.",
        scenario: false,
        appendix: "Auto-evolve note (skill_defect): The skill missed a required file excerpt.",
      },
    },
    {
      reflectionKind: "execution_lapse" as const,
      recommendedAction: "append_appendix" as const,
      reason: "The run skipped the expected evidence readback.",
      expected: {
        core: false,
        scenario: false,
        appendix: "Auto-evolve note (execution_lapse): The run skipped the expected evidence readback.",
      },
    },
  ];

  for (const fixture of fixtures) {
    const markdown = buildStructuredSkillMarkdownCandidate(buildReflection(fixture), baseMarkdown, "find.code_symbol");
    const core = sectionBody(markdown, "Core Procedure");
    const scenario = sectionBody(markdown, "Scenario Extensions");
    const appendix = sectionBody(markdown, "Appendix");

    if (fixture.expected.core) {
      assert.equal(core.includes(fixture.expected.core), true, `${fixture.reflectionKind} should update Core Procedure`);
    } else {
      assert.equal(core, sectionBody(baseMarkdown, "Core Procedure"), `${fixture.reflectionKind} should not touch Core Procedure`);
    }
    if (fixture.expected.scenario) {
      assert.equal(scenario.includes(fixture.expected.scenario), true, `${fixture.reflectionKind} should update Scenario Extensions`);
    } else {
      assert.equal(scenario, sectionBody(baseMarkdown, "Scenario Extensions"), `${fixture.reflectionKind} should not touch Scenario Extensions`);
    }
    if (fixture.expected.appendix) {
      assert.equal(appendix.includes(fixture.expected.appendix), true, `${fixture.reflectionKind} should update Appendix`);
    } else {
      assert.equal(appendix, sectionBody(baseMarkdown, "Appendix"), `${fixture.reflectionKind} should not touch Appendix`);
    }
  }
});

test("skill_defect candidate markdown targets core procedure", () => {
  const markdown = buildStructuredSkillMarkdownCandidate(buildReflection({
    reflectionKind: "skill_defect",
    recommendedAction: "patch_body",
    reason: "The core steps still miss a required evidence path.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["file_excerpt"],
      eventIds: [],
      artifactIds: [],
      silentBypassSignal: false,
    },
  }), "# Skill: find.code_symbol\n", "find.code_symbol");

  assert.equal(/##\s+Core Procedure[\s\S]*Refine the core procedure for the skill_defect scenario: The core steps still miss a required evidence path\./i.test(markdown), true);
  assert.equal(/##\s+Appendix[\s\S]*Auto-evolve note \(skill_defect\): The core steps still miss a required evidence path\./i.test(markdown), true);
});

test("execution_lapse candidate markdown only appends appendix guidance", () => {
  const baseMarkdown = [
    "# Skill: find.code_symbol",
    "",
    "## Core Procedure",
    "- Existing stable step.",
    "",
    "## Scenario Extensions",
    "- Existing scenario step.",
    "",
    "## Appendix",
    "- Existing appendix note.",
    "",
  ].join("\n");

  const markdown = buildStructuredSkillMarkdownCandidate(buildReflection({
    reflectionKind: "execution_lapse",
    recommendedAction: "append_appendix",
    reason: "The run skipped the expected evidence readback.",
  }), baseMarkdown, "find.code_symbol");

  assert.equal(/##\s+Core Procedure[\s\S]*Refine the core procedure for the execution_lapse scenario/i.test(markdown), false);
  assert.equal(/##\s+Scenario Extensions[\s\S]*Scenario extension \(execution_lapse\)/i.test(markdown), false);
  assert.equal(/##\s+Appendix[\s\S]*Auto-evolve note \(execution_lapse\): The run skipped the expected evidence readback\./i.test(markdown), true);
});

test("missing live SKILL.md scaffolds structured candidate markdown", () => {
  const markdown = buildStructuredSkillMarkdownCandidate(buildReflection({
    reflectionKind: "optimization",
    recommendedAction: "patch_body",
    reason: "Tighten the reusable core procedure.",
  }), null, "find.code_symbol");

  assert.equal(markdown.startsWith("# Skill: find.code_symbol"), true);
  assert.equal(/##\s+Core Procedure/i.test(markdown), true);
  assert.equal(/##\s+Scenario Extensions/i.test(markdown), true);
  assert.equal(/##\s+Appendix/i.test(markdown), true);
  assert.equal(/Refine the core procedure for the optimization scenario: Tighten the reusable core procedure\./i.test(markdown), true);
});

test("patch_verification candidate manifest only mutates verification whitelist fields", () => {
  const existingManifest = {
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"] as const,
    keywords: ["fix", "debug"],
    requiredTools: ["list_files", "read_file", "shell_command"],
    optionalTools: ["web_search"],
    install: {
      source: "builtin" as const,
      location: "skills/find.code_symbol",
    },
    activation: {
      mode: "intent_match" as const,
      priority: 100,
    },
    execution: {
      strategy: "workflow_template" as const,
      templateId: "find_code_symbol_v1",
    },
    verification: {
      requiredArtifacts: ["symbol_hits"],
      successSignal: "has_symbol_hits",
      artifactLabels: {
        symbol_hits: "symbol hits",
      },
      remediation: {
        insufficient: "Need more symbol hits.",
      },
    },
  };
  const originalManifest = structuredClone(existingManifest);

  const manifestText = buildCandidateManifestContent(
    buildProposal(),
    buildReflection({
      reflectionKind: "skill_defect",
      recommendedAction: "patch_verification",
      reason: "Verification needs clearer evidence labels and remediation.",
      evidence: {
        verificationStatus: "insufficient",
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["file_excerpt"],
        eventIds: [],
        artifactIds: [],
        silentBypassSignal: false,
      },
    }),
    existingManifest,
  );
  const manifest = JSON.parse(manifestText) as typeof existingManifest & {
    verification?: {
      artifactLabels?: Record<string, string>;
      successSignalLabel?: string;
      remediation?: {
        insufficient?: string;
        failed?: string;
      };
    };
  };

  assert.deepEqual(manifest.requiredTools, existingManifest.requiredTools);
  assert.deepEqual(manifest.optionalTools, existingManifest.optionalTools);
  assert.deepEqual(manifest.install, existingManifest.install);
  assert.deepEqual(manifest.execution, existingManifest.execution);
  assert.equal(manifest.description.includes("[Auto-evolve skill_defect: patch_verification]"), true);
  assert.deepEqual(manifest.verification?.requiredArtifacts, originalManifest.verification.requiredArtifacts);
  assert.equal(manifest.verification?.successSignal, originalManifest.verification.successSignal);
  assert.equal(manifest.verification?.artifactLabels?.symbol_hits, "symbol hits");
  assert.equal(manifest.verification?.artifactLabels?.auto_evolve_missing_requirement, "file_excerpt");
  assert.equal(typeof manifest.verification?.successSignalLabel, "string");
  assert.equal(manifest.verification?.remediation?.insufficient?.includes("Auto-evolve note"), true);
  assert.equal(manifest.verification?.remediation?.failed?.includes("Auto-evolve follow-up"), true);
  assert.deepEqual(existingManifest, originalManifest, "candidate manifest generation should not mutate the live manifest input");
});

test("patch_verification manifest fixture preserves forbidden fields while adding only whitelist verification guidance", () => {
  const existingManifest = {
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"] as const,
    keywords: ["fix", "debug"],
    requiredTools: ["list_files", "read_file"],
    optionalTools: ["shell_command"],
    install: {
      source: "builtin" as const,
      location: "skills/find.code_symbol",
      entry: "workflow.yml",
      checksum: "sha256:live",
    },
    activation: {
      mode: "intent_match" as const,
      priority: 100,
    },
    execution: {
      strategy: "workflow_template" as const,
      templateId: "find_code_symbol_v1",
    },
    verification: {
      requiredArtifacts: ["symbol_hits", "file_excerpt"],
      successSignal: "has_symbol_hits_and_excerpt",
      artifactLabels: {
        symbol_hits: "symbol hits",
        file_excerpt: "file excerpt",
      },
      successSignalLabel: "Existing success label",
      remediation: {
        insufficient: "Need more evidence.",
        failed: "Inspect failed checks.",
      },
    },
  };

  const manifest = JSON.parse(buildCandidateManifestContent(
    buildProposal(),
    buildReflection({
      reflectionKind: "skill_defect",
      recommendedAction: "patch_verification",
      reason: "Verification needs clearer evidence labels.",
      evidence: {
        verificationStatus: "insufficient",
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["call_path"],
        eventIds: [],
        artifactIds: [],
        silentBypassSignal: false,
      },
    }),
    existingManifest,
  )) as typeof existingManifest;

  assert.deepEqual(manifest.requiredTools, existingManifest.requiredTools);
  assert.deepEqual(manifest.optionalTools, existingManifest.optionalTools);
  assert.deepEqual(manifest.install, existingManifest.install);
  assert.deepEqual(manifest.activation, existingManifest.activation);
  assert.deepEqual(manifest.execution, existingManifest.execution);
  assert.deepEqual(manifest.verification?.requiredArtifacts, existingManifest.verification.requiredArtifacts);
  assert.equal(manifest.verification?.successSignal, existingManifest.verification.successSignal);
  assert.equal(manifest.verification?.artifactLabels?.symbol_hits, "symbol hits");
  assert.equal(manifest.verification?.artifactLabels?.file_excerpt, "file excerpt");
  assert.equal(manifest.verification?.artifactLabels?.auto_evolve_missing_requirement, "call_path");
  assert.equal(manifest.verification?.successSignalLabel, "Address reflected checks: artifact_presence");
  assert.equal(manifest.verification?.remediation?.insufficient, "Auto-evolve note: Verification needs clearer evidence labels.");
  assert.equal(manifest.verification?.remediation?.failed, "Auto-evolve follow-up: Verification needs clearer evidence labels.");
});

test("execution_lapse candidate manifest does not mutate verification contract", () => {
  const existingManifest = {
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"] as const,
    keywords: ["fix"],
    requiredTools: ["list_files"],
    install: {
      source: "builtin" as const,
      location: "skills/find.code_symbol",
    },
    activation: {
      mode: "intent_match" as const,
      priority: 100,
    },
    execution: {
      strategy: "workflow_template" as const,
      templateId: "find_code_symbol_v1",
    },
    verification: {
      requiredArtifacts: ["symbol_hits"],
      artifactLabels: {
        symbol_hits: "symbol hits",
      },
      remediation: {
        insufficient: "Need more symbol hits.",
      },
    },
  };
  const originalManifest = structuredClone(existingManifest);

  const manifestText = buildCandidateManifestContent(
    buildProposal(),
    buildReflection({
      reflectionKind: "execution_lapse",
      recommendedAction: "append_appendix",
      reason: "The run skipped evidence readback.",
      evidence: {
        verificationStatus: "insufficient",
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["file_excerpt"],
        eventIds: [],
        artifactIds: [],
        silentBypassSignal: true,
      },
    }),
    existingManifest,
  );
  const manifest = JSON.parse(manifestText) as typeof existingManifest;

  assert.equal(manifest.description.includes("[Auto-evolve execution_lapse: append_appendix]"), true);
  assert.deepEqual({
    ...manifest,
    description: originalManifest.description,
  }, originalManifest);
  assert.deepEqual(existingManifest, originalManifest, "candidate manifest generation should not mutate execution_lapse input");
});

test("proposal generator publishes explicit manifest whitelist and reflection patch policy", () => {
  assert.deepEqual(PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST, [
    "verification.artifactLabels",
    "verification.successSignalLabel",
    "verification.remediation.insufficient",
    "verification.remediation.failed",
  ]);
  assert.equal(PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY.discovery.allowScenarioExtensions, true);
  assert.equal(PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY.optimization.allowCoreProcedure, true);
  assert.equal(PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY.skill_defect.allowManifestWhitelistPatch, true);
  assert.equal(PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY.execution_lapse.allowCoreProcedure, false);
  assert.equal(PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY.execution_lapse.allowManifestWhitelistPatch, false);
});

test("shared proposal policy gates manifest patching and reflection consistency", () => {
  const verificationReflection = buildReflection({
    reflectionKind: "skill_defect",
    recommendedAction: "patch_verification",
  });
  const appendixReflection = buildReflection({
    reflectionKind: "execution_lapse",
    recommendedAction: "append_appendix",
  });

  assert.equal(canPatchManifestWhitelist(verificationReflection), true);
  assert.equal(canPatchManifestWhitelist(appendixReflection), false);
  assert.equal(isReflectionToPatchConsistent({
    reflection: verificationReflection,
    verificationTouched: true,
  }), true);
  assert.equal(isReflectionToPatchConsistent({
    reflection: appendixReflection,
    verificationTouched: true,
  }), false);
});

test("shared proposal policy detects risky manifest escalation", () => {
  const liveManifest = {
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"] as const,
    keywords: ["fix"],
    requiredTools: ["list_files"],
    optionalTools: ["read_file"],
    install: {
      source: "builtin" as const,
      location: "skills/find.code_symbol",
    },
    activation: {
      mode: "intent_match" as const,
      priority: 100,
    },
    execution: {
      strategy: "workflow_template" as const,
      templateId: "find_code_symbol_v1",
    },
  };
  const candidateManifest = {
    ...liveManifest,
    requiredTools: [...liveManifest.requiredTools, "shell_command"],
  };

  assert.equal(hasRiskyManifestEscalation(candidateManifest, liveManifest), true);
  assert.equal(hasRiskyManifestEscalation(liveManifest, liveManifest), false);
});

test("shared proposal policy detects markdown section hits and violations", () => {
  const baseMarkdown = [
    "# Skill: find.code_symbol",
    "",
    "## Core Procedure",
    "- Existing stable step.",
    "",
    "## Scenario Extensions",
    "- Existing scenario step.",
    "",
    "## Appendix",
    "- Existing appendix note.",
    "",
  ].join("\n");

  const executionLapseCandidate = [
    "# Skill: find.code_symbol",
    "",
    "## Core Procedure",
    "- Existing stable step.",
    "- Illicit core mutation.",
    "",
    "## Scenario Extensions",
    "- Existing scenario step.",
    "",
    "## Appendix",
    "- Existing appendix note.",
    "- Auto-evolve note (execution_lapse): Reminder.",
    "",
  ].join("\n");

  const discoveryCandidate = [
    "# Skill: find.code_symbol",
    "",
    "## Core Procedure",
    "- Existing stable step.",
    "",
    "## Scenario Extensions",
    "- Existing scenario step.",
    "- Scenario extension (discovery): New reusable path.",
    "",
    "## Appendix",
    "- Existing appendix note.",
    "",
  ].join("\n");

  const lapsePolicy = evaluateSkillMarkdownPatchPolicy({
    reflection: buildReflection({
      reflectionKind: "execution_lapse",
      recommendedAction: "append_appendix",
    }),
    liveMarkdown: baseMarkdown,
    candidateMarkdown: executionLapseCandidate,
  });
  const discoveryPolicy = evaluateSkillMarkdownPatchPolicy({
    reflection: buildReflection({
      reflectionKind: "discovery",
      recommendedAction: "append_appendix",
    }),
    liveMarkdown: baseMarkdown,
    candidateMarkdown: discoveryCandidate,
  });

  assert.equal(lapsePolicy.policyReady, false);
  assert.equal(lapsePolicy.touchedSections.includes("Core Procedure"), true);
  assert.equal(discoveryPolicy.policyReady, true);
  assert.equal(discoveryPolicy.touchedSections.includes("Scenario Extensions"), true);
});

test("generated proposal includes diff, rationale, and control-plane summaries", () => {
  const proposal = generateSkillEvolutionProposal({
    reflection: buildReflection({
      reflectionKind: "skill_defect",
      recommendedAction: "patch_verification",
      reason: "Verification wording should explain the required artifact more clearly.",
      evidence: {
        verificationStatus: "insufficient",
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["file_excerpt"],
        eventIds: [],
        artifactIds: [],
        silentBypassSignal: true,
      },
    }),
    candidateDir: "runtime/skill-evolution",
    config: loadConfig(),
    manifest: {
      id: "find.code_symbol",
      version: "0.1.0",
      title: "Code Symbol Discovery",
      description: "Locate repository symbols before editing.",
      intents: ["coding"],
      keywords: ["fix"],
      requiredTools: ["list_files"],
      install: {
        source: "builtin",
        location: "skills/find.code_symbol",
      },
      activation: {
        mode: "intent_match",
        priority: 100,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_code_symbol_v1",
      },
    },
  });

  assert.equal(proposal.diffSummary?.scope, "verification_only");
  assert.deepEqual(proposal.diffSummary?.changedSections, ["Core Procedure", "Appendix"]);
  assert.equal(proposal.diffSummary?.changedFiles.some((item) => item.path.endsWith("/SKILL.md")), true);
  assert.equal(proposal.diffSummary?.changedFiles.some((item) => item.summary.includes("verification whitelist fields only")), true);
  assert.equal(proposal.rationaleSummary?.reflectionKind, "skill_defect");
  assert.equal(proposal.rationaleSummary?.recommendedAction, "patch_verification");
  assert.equal(proposal.rationaleSummary?.evidenceHighlights.includes("Failed checks: artifact_presence"), true);
  assert.equal(proposal.rationaleSummary?.evidenceHighlights.includes("Missing requirements: file_excerpt"), true);
  assert.equal(proposal.rationaleSummary?.evidenceHighlights.includes("Silent bypass signal detected."), true);
  assert.equal(proposal.controlPlaneSummary?.title, "find.code_symbol: skill_defect");
  assert.equal(proposal.controlPlaneSummary?.rationaleHeadline, "Verification wording should explain the required artifact more clearly.");
  assert.equal(proposal.controlPlaneSummary?.changedFiles.length, 2);
});

test("generated proposal diffSummary maps reflection kinds to credible changed sections and files", () => {
  const config = loadConfig();
  const manifest = {
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"],
    keywords: ["fix"],
    requiredTools: ["list_files"],
    install: {
      source: "builtin",
      location: "skills/find.code_symbol",
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_code_symbol_v1",
    },
  } as const;
  const fixtures = [
    {
      reflectionKind: "discovery" as const,
      recommendedAction: "append_appendix" as const,
      expectedScope: "appendix_only",
      expectedSections: ["Scenario Extensions", "Appendix"],
      expectedSkillSummary: "Update Scenario Extensions + Appendix guidance.",
      expectedManifestSummary: "Keep manifest contract stable while aligning candidate metadata.",
    },
    {
      reflectionKind: "optimization" as const,
      recommendedAction: "patch_body" as const,
      expectedScope: "body_only",
      expectedSections: ["Core Procedure"],
      expectedSkillSummary: "Update Core Procedure guidance.",
      expectedManifestSummary: "Keep manifest contract stable while aligning candidate metadata.",
    },
    {
      reflectionKind: "skill_defect" as const,
      recommendedAction: "patch_verification" as const,
      evidence: {
        verificationStatus: "insufficient" as const,
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["file_excerpt"],
        eventIds: [],
        artifactIds: [],
        silentBypassSignal: false,
      },
      expectedScope: "verification_only",
      expectedSections: ["Core Procedure", "Appendix"],
      expectedSkillSummary: "Update Core Procedure + Appendix guidance.",
      expectedManifestSummary: "Adjust verification whitelist fields only.",
    },
    {
      reflectionKind: "execution_lapse" as const,
      recommendedAction: "append_appendix" as const,
      expectedScope: "appendix_only",
      expectedSections: ["Appendix"],
      expectedSkillSummary: "Update Appendix guidance.",
      expectedManifestSummary: "Keep manifest contract stable while aligning candidate metadata.",
    },
  ];

  for (const fixture of fixtures) {
    const reflection = buildReflection({
      reflectionKind: fixture.reflectionKind,
      recommendedAction: fixture.recommendedAction,
      reason: `${fixture.reflectionKind} fixture reason.`,
    });
    if (fixture.evidence) {
      reflection.evidence = fixture.evidence;
    }
    const proposal = generateSkillEvolutionProposal({
      reflection,
      candidateDir: "runtime/skill-evolution",
      config,
      manifest,
    });

    assert.equal(proposal.diffSummary?.scope, fixture.expectedScope, `${fixture.reflectionKind} scope`);
    assert.deepEqual(proposal.diffSummary?.changedSections, fixture.expectedSections, `${fixture.reflectionKind} changedSections`);
    assert.deepEqual(proposal.diffSummary?.changedFiles, [
      {
        path: "skills/find.code_symbol/SKILL.md",
        summary: fixture.expectedSkillSummary,
      },
      {
        path: "skills/find.code_symbol/skill.json",
        summary: fixture.expectedManifestSummary,
      },
    ], `${fixture.reflectionKind} changedFiles`);
    assert.deepEqual(proposal.controlPlaneSummary?.changedFiles, [
      "skills/find.code_symbol/SKILL.md",
      "skills/find.code_symbol/skill.json",
    ], `${fixture.reflectionKind} control plane changed files`);
  }
});

test("generated proposal resolves target files from manifest install location", () => {
  const proposal = generateSkillEvolutionProposal({
    reflection: buildReflection(),
    candidateDir: "runtime/skill-evolution",
    config: loadConfig(),
    manifest: {
      id: "find.code_symbol",
      version: "0.1.0",
      title: "Code Symbol Discovery",
      description: "Locate repository symbols before editing.",
      intents: ["coding"],
      keywords: ["fix"],
      requiredTools: ["list_files"],
      install: {
        source: "builtin",
        location: "skills/custom/find.code_symbol",
      },
      activation: {
        mode: "intent_match",
        priority: 100,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_code_symbol_v1",
      },
    },
  });

  assert.deepEqual(proposal.targetFiles, [
    "skills/custom/find.code_symbol/SKILL.md",
    "skills/custom/find.code_symbol/skill.json",
  ]);
});
