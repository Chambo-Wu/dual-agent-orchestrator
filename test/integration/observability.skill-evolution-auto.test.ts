import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../src/job-event-bus.js";
import { __testables } from "../../src/index.js";
import {
  persistSkillEvolutionProposal,
  persistSkillAuditReport,
} from "../../src/skill-evolution-store.js";
import { createUiEvent } from "../../src/workflow-ui-events.js";
import {
  buildMinimalConfig,
  MockResponse,
  buildAuthorizedRequest,
  buildAuthorizedJsonRequest,
  persistObservabilityJob,
} from "../helpers/observability-helpers.js";

test("skill evolution auto pipeline validates but does not accept without true runtime replay", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-auto-evolve-"));
  const builtinRoot = join(tempRoot, "skills");
  const candidateDir = join(tempRoot, "runtime", "skill-evolution");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"],
    keywords: ["fix", "debug", "route"],
    requiredTools: ["list_files", "read_file", "shell_command"],
    install: {
      source: "builtin",
      location: join(tempRoot, "skills", "find.code_symbol").replace(/\\/g, "/"),
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_code_symbol_v1",
    },
    verification: {
      requiredArtifacts: ["symbol_hits"],
      remediation: {
        insufficient: "Capture concrete symbol hits.",
      },
    },
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.autoPropose = true;
  config.skillEvolution.autoAudit = true;
  config.skillEvolution.autoValidate = true;
  config.skillEvolution.autoAccept = true;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_auto_pipeline", "Automatically evolve a successful skill run");
    appendEvent(createUiEvent({
      jobId: "job_observability_auto_pipeline",
      seq: 1,
      type: "planner.decision",
      title: "Planner selected code symbol skill",
      summary: "Selected find.code_symbol for repository discovery.",
      status: "success",
      agent: "planner",
      meta: {
        selected_skill: "find.code_symbol",
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
      },
    }));
    const recordModule = await import("../../src/job-store.js");
    const record = recordModule.readJobRecord("job_observability_auto_pipeline");
    assert.equal(Boolean(record), true);

    __testables.runAutomaticSkillEvolutionForRecord(record!, config);

    const reflectionRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skills/find.code_symbol/reflections"), reflectionRes);
    const reflectionBody = JSON.parse(reflectionRes.body) as {
      data?: Array<{ jobId?: string }>;
    };
    assert.equal(reflectionBody.data?.some((entry) => entry.jobId === "job_observability_auto_pipeline"), true);

    const proposalsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), proposalsRes);
    const proposalsBody = JSON.parse(proposalsRes.body) as {
      data?: Array<{
        id?: string;
        skillId?: string;
        status?: string;
        validationReportPath?: string;
        auditReportPath?: string;
      }>;
    };
    const autoProposal = proposalsBody.data?.find((proposal) => proposal.skillId === "find.code_symbol" && proposal.status === "validated");
    assert.equal(Boolean(autoProposal), true);
    assert.equal(typeof autoProposal?.auditReportPath, "string");
    assert.equal(typeof autoProposal?.validationReportPath, "string");

    const liveManifest = JSON.parse(readFileSync(join(skillDir, "skill.json"), "utf8")) as { description?: string };
    assert.equal(liveManifest.description?.includes("[Auto-evolve"), false);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_auto_pipeline/events"), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type?: string; meta?: { proposal_id?: string } }>;
    };
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_proposed"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_audit_passed"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_validation_passed"), true);
    assert.equal(eventsBody.events.some((event) =>
      event.type === "system.skill_evolution_accepted"
      && event.meta?.proposal_id === autoProposal?.id
    ), false);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution auto pipeline can opt into deterministic runtime replay validation", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-auto-runtime-replay-"));
  const builtinRoot = join(tempRoot, "skills");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"],
    keywords: ["fix", "debug", "route"],
    requiredTools: ["list_files", "read_file", "shell_command"],
    install: {
      source: "builtin",
      location: join(tempRoot, "skills", "find.code_symbol").replace(/\\/g, "/"),
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_code_symbol_v1",
    },
    verification: {
      requiredArtifacts: ["symbol_hits"],
      successSignal: "at_least_one_relevant_entrypoint",
    },
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.autoPropose = true;
  config.skillEvolution.autoAudit = true;
  config.skillEvolution.autoValidate = true;
  config.skillEvolution.autoAccept = false;
  config.skillEvolution.runtimeReplayInAutoPipeline = true;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_auto_runtime_replay", "Automatically validate with runtime replay");
    const recordModule = await import("../../src/job-store.js");
    const record = recordModule.readJobRecord("job_observability_auto_runtime_replay");
    assert.equal(Boolean(record), true);

    await __testables.runAutomaticSkillEvolutionForRecord(record!, config);

    const proposalsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), proposalsRes);
    const proposalsBody = JSON.parse(proposalsRes.body) as {
      data?: Array<{
        id?: string;
        skillId?: string;
        status?: string;
        validation_summary?: {
          auto_accept_ready?: boolean;
          same_input_readiness?: string;
          replay_stability_score?: number | null;
          replay_stability_level?: string | null;
          runtime_replay_task_payloads?: Array<Record<string, unknown>>;
          runtime_boundary?: {
            stage?: string;
            contract?: string;
            trueRuntimeReplayReady?: boolean;
          };
        };
      }>;
    };
    const autoProposal = proposalsBody.data?.find((proposal) => proposal.skillId === "find.code_symbol" && proposal.status === "validated");

    assert.equal(Boolean(autoProposal), true);
    assert.equal(autoProposal?.validation_summary?.same_input_readiness, "ready");
    assert.equal(autoProposal?.validation_summary?.auto_accept_ready, true);
    assert.equal(autoProposal?.validation_summary?.runtime_boundary?.stage, "executed");
    assert.equal(autoProposal?.validation_summary?.runtime_boundary?.contract, "true_candidate_runtime_replay");
    assert.equal(autoProposal?.validation_summary?.runtime_boundary?.trueRuntimeReplayReady, true);
    assert.equal(autoProposal?.validation_summary?.replay_stability_score, 100);
    assert.equal(autoProposal?.validation_summary?.replay_stability_level, "stable");
    assert.equal((autoProposal?.validation_summary?.runtime_replay_task_payloads?.length ?? 0) > 0, true);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_auto_runtime_replay/events"), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type?: string }>;
    };
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_validation_passed"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_accepted"), false);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution auto-accept helper blocks low-risk flaky validated proposals", () => {
  const config = buildMinimalConfig();
  config.skillEvolution.autoAccept = true;

  const allowed = __testables.shouldAutoAcceptSkillEvolution({
    proposalId: "proposal_flaky_lowrisk",
    passed: true,
    baselineJobId: "job_flaky_lowrisk",
    candidateJobId: "proposal_flaky_lowrisk_candidate",
    risk: {
      tier: "low",
      skillClass: "research_like",
      summary: "Low-risk research-like skill.",
      acceptanceFocus: "improvement",
    },
    stability: {
      replayInstabilityDetected: true,
      candidateFlakySignal: true,
      autoAcceptBlocked: true,
      replayStabilityScore: 0,
      replayStabilityLevel: "unstable",
      reasons: [
        "Baseline replay provenance is incomplete, so repeated validation may be unstable.",
        "Candidate improvement currently relies on lightweight heuristic signals and may be flaky before isolated replay exists.",
      ],
    },
    contract: {
      baselineSelection: {
        source: "reflection_only",
        reflectionId: "refl_flaky_lowrisk",
        reason: "Baseline falls back to reflection evidence.",
      },
      inputEquivalence: {
        mode: "same_recorded_input",
        satisfied: true,
        reason: "Validation falls back to reflection evidence, so same-input is inferred rather than fully replayed.",
      },
      hardGates: [],
    },
    replay: {
      mode: "record_replay",
      sameInputComparison: {
        mode: "recorded_baseline_vs_candidate",
        inputAligned: true,
        baselineObserved: true,
        candidateObserved: true,
        baselineSelected: true,
        candidateSelected: true,
        baselineVerified: false,
        candidateVerified: true,
        artifactDelta: 1,
        failedChecksDelta: -1,
        resolvedMissingRequirements: ["symbol_hits"],
        remainingMissingRequirements: [],
        introducedMissingRequirements: [],
        evidenceLevel: "partial",
        readiness: "needs_replay",
        summary: "Baseline and candidate can be compared on the same recorded input, but stronger replay evidence is still needed before readiness-sensitive decisions.",
      },
      provenance: {
        baselineSource: "reflection_record",
        candidateSource: "candidate_runtime_config",
        baselineSelectedSkillSource: "reflection_record",
        candidateSelectedSkillSource: "candidate_manifest",
        candidateDir: "runtime/skill-evolution",
        isolated: false,
        note: "Candidate runtime config prepared.",
        candidateBinding: {
          manifestPresent: true,
          runtimePrepared: true,
          targetFileCount: 1,
          changedFileCount: 1,
          selectedSkillMatchesProposal: true,
          selectedSkillMatchesReflection: true,
          bindingReady: true,
          reasons: [],
        },
        executionEvidence: {
          reflectionEventIds: ["evt_flaky_lowrisk_1"],
          reflectionArtifactIds: ["artifact_flaky_lowrisk_1"],
          baselineHadArtifacts: true,
          silentBypassSignal: false,
          candidateManifestPresent: true,
          candidateChangedFiles: ["skills/find.code_symbol/SKILL.md"],
          candidateVerified: true,
          level: "partial",
          summary: "Validation has partial execution evidence from reflection artifacts/events and the candidate snapshot, but isolated replay proof is still incomplete.",
        },
      },
      baseline: {
        jobId: "job_flaky_lowrisk",
        selectedSkillId: "find.code_symbol",
        verified: false,
        verificationStatus: "insufficient",
        artifactCount: 1,
        failedChecks: ["artifact_presence"],
        missingRequirements: ["symbol_hits"],
      },
      candidate: {
        proposalId: "proposal_flaky_lowrisk",
        selectedSkillId: "find.code_symbol",
        candidateManifestPresent: true,
        changedFiles: ["skills/find.code_symbol/SKILL.md"],
        verified: true,
        verificationStatus: "verified",
        artifactCount: 2,
        failedChecks: [],
        missingRequirements: [],
      },
    },
    comparison: {
      candidateSelected: true,
      candidateVerified: true,
      baselineVerified: false,
      candidateArtifactCount: 2,
      baselineArtifactCount: 1,
      candidateFailedChecks: [],
      baselineFailedChecks: ["artifact_presence"],
    },
    decision: {
      reasonCode: "passed",
      autoAcceptReady: false,
      details: [
        "Validation passed, but stability signals block auto-accept.",
      ],
    },
    summary: "Candidate proposal passes validation but is not stable enough for auto-accept.",
    createdAt: new Date().toISOString(),
  }, config);

  assert.equal(allowed, false);
});

test("skill evolution low-risk pilot can auto-validate without enabling global auto_validate", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-low-risk-pilot-"));
  const builtinRoot = join(tempRoot, "skills");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Research Symbol Discovery",
    description: "Find repository symbols for low-risk research tasks.",
    intents: ["research"],
    keywords: ["research", "symbol", "source"],
    requiredTools: ["list_files", "read_file"],
    install: {
      source: "builtin",
      location: join(tempRoot, "skills", "find.code_symbol").replace(/\\/g, "/"),
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_official_sources_v1",
    },
    verification: {
      requiredArtifacts: ["symbol_hits"],
      successSignal: "at_least_one_relevant_entrypoint",
    },
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.autoPropose = true;
  config.skillEvolution.autoAudit = true;
  config.skillEvolution.autoValidate = false;
  config.skillEvolution.autoAccept = false;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  config.skillEvolution.riskTiering.enabled = true;
  config.skillEvolution.riskTiering.defaultTier = "low";
  config.skillEvolution.riskTiering.automationCeilings.low = "auto_accept";
  config.skillEvolution.riskTiering.lowRiskPilotSkills = ["find.code_symbol"];
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_low_risk_pilot", "Use official sources for a research answer");
    appendEvent(createUiEvent({
      jobId: "job_observability_low_risk_pilot",
      seq: 1,
      type: "planner.decision",
      title: "Planner selected research skill",
      summary: "Selected find.official_sources for official source discovery.",
      status: "success",
      agent: "planner",
      meta: {
        selected_skill: "find.code_symbol",
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
      },
    }));
    const recordModule = await import("../../src/job-store.js");
    const record = recordModule.readJobRecord("job_observability_low_risk_pilot");
    assert.equal(Boolean(record), true);

    await __testables.runAutomaticSkillEvolutionForRecord(record!, config);

    const proposalsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), proposalsRes);
    const proposalsBody = JSON.parse(proposalsRes.body) as {
      data?: Array<{
        skillId?: string;
        status?: string;
        validationReportPath?: string;
      }>;
    };
    const proposal = proposalsBody.data?.find((entry) => entry.skillId === "find.code_symbol");

    assert.equal(proposal?.status, "validated");
    assert.equal(typeof proposal?.validationReportPath, "string");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_low_risk_pilot/events"), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type?: string; meta?: { blocked_stage?: string; low_risk_pilot?: boolean } }>;
    };
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_validation_passed"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_accepted"), false);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution auto pipeline blocks high-risk skills at the proposal ceiling when risk tiering is enabled", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-auto-evolve-highrisk-ceiling-"));
  const builtinRoot = join(tempRoot, "skills");
  const candidateDir = join(tempRoot, "runtime", "skill-evolution");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate repository symbols before editing.",
    intents: ["coding"],
    keywords: ["fix", "debug"],
    requiredTools: ["list_files", "read_file", "shell_command"],
    install: {
      source: "builtin",
      location: join(tempRoot, "skills", "find.code_symbol").replace(/\\/g, "/"),
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_code_symbol_v1",
    },
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.autoPropose = true;
  config.skillEvolution.autoAudit = true;
  config.skillEvolution.autoValidate = true;
  config.skillEvolution.autoAccept = true;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  config.skillEvolution.riskTiering.enabled = true;
  config.skillEvolution.riskTiering.defaultTier = "low";
  config.skillEvolution.riskTiering.automationCeilings.high = "auto_propose";
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_auto_pipeline_highrisk_ceiling", "Keep high-risk skills below audit");
    appendEvent(createUiEvent({
      jobId: "job_observability_auto_pipeline_highrisk_ceiling",
      seq: 1,
      type: "planner.decision",
      title: "Planner selected coding skill",
      summary: "Selected find.code_symbol for coding discovery.",
      status: "success",
      agent: "planner",
      meta: {
        selected_skill: "find.code_symbol",
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
      },
    }));
    const recordModule = await import("../../src/job-store.js");
    const record = recordModule.readJobRecord("job_observability_auto_pipeline_highrisk_ceiling");
    assert.equal(Boolean(record), true);

    __testables.runAutomaticSkillEvolutionForRecord(record!, config);

    const proposalsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), proposalsRes);
    const proposalsBody = JSON.parse(proposalsRes.body) as {
      data?: Array<{
        skillId?: string;
        status?: string;
        auditReportPath?: string;
        validationReportPath?: string;
        automation_block?: {
          riskTier?: string;
          blockedStage?: string;
          automationCeiling?: string;
          reason?: string;
        } | null;
      }>;
    };
    const proposal = proposalsBody.data?.find((entry) => entry.skillId === "find.code_symbol");
    assert.equal(Boolean(proposal), true);
    assert.equal(proposal?.status, "draft");
    assert.equal(proposal?.auditReportPath ?? null, null);
    assert.equal(proposal?.validationReportPath ?? null, null);
    assert.equal(proposal?.automation_block?.reason, "automation_ceiling");
    assert.equal(proposal?.automation_block?.riskTier, "high");
    assert.equal(proposal?.automation_block?.blockedStage, "auto_audit");
    assert.equal(proposal?.automation_block?.automationCeiling, "auto_propose");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_auto_pipeline_highrisk_ceiling/events"), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type?: string; meta?: { blocked_stage?: string; risk_tier?: string } }>;
    };
    const blockedEvent = eventsBody.events.find((event) => event.type === "system.skill_evolution_automation_blocked");
    assert.equal(blockedEvent?.meta?.blocked_stage, "auto_audit");
    assert.equal(blockedEvent?.meta?.risk_tier, "high");
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_audit_passed"), false);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_validation_passed"), false);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_accepted"), false);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
    rmSync(candidateDir, { recursive: true, force: true });
  }
});

test("skill evolution auto pipeline applies dynamic ceiling before audit after recent audit failures", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-dynamic-pre-audit-"));
  const builtinRoot = join(tempRoot, "skills");
  const candidateDir = join(tempRoot, "runtime", "skill-evolution");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Research Symbol Discovery",
    description: "Locate repository symbols for research workflows.",
    intents: ["research"],
    keywords: ["research", "source"],
    requiredTools: ["list_files", "read_file"],
    install: {
      source: "builtin",
      location: join(tempRoot, "skills", "find.code_symbol").replace(/\\/g, "/"),
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_code_symbol_v1",
    },
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.autoPropose = true;
  config.skillEvolution.autoAudit = true;
  config.skillEvolution.autoValidate = true;
  config.skillEvolution.autoAccept = true;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  config.skillEvolution.riskTiering.enabled = true;
  config.skillEvolution.riskTiering.defaultTier = "low";
  config.skillEvolution.riskTiering.automationCeilings.low = "auto_accept";
  __testables.setConfigOverrideForTests(config);

  try {
    persistSkillEvolutionProposal({
      id: "proposal_prior_audit_failure_dynamic",
      skillId: "find.code_symbol",
      sourceReflectionId: "refl_prior_audit_failure_dynamic",
      status: "audit_failed",
      targetFiles: ["skills/find.code_symbol/SKILL.md"],
      patchSummary: "Prior audit failure",
      patchText: "patch",
      candidateDir: config.skillEvolution.candidateDir,
      createdAt: new Date().toISOString(),
    }, config.skillEvolution.candidateDir);
    persistSkillAuditReport({
      proposalId: "proposal_prior_audit_failure_dynamic",
      passed: false,
      checks: [{ name: "markdown_section_patch_policy", passed: false, detail: "section drift" }],
      summary: "Prior audit failed.",
      createdAt: new Date().toISOString(),
    }, config.skillEvolution.candidateDir);
    const preflightDynamicRisk = __testables.buildSkillEvolutionDynamicRiskSummary({
      id: "proposal_preflight_dynamic",
      skillId: "find.code_symbol",
      sourceReflectionId: "refl_preflight_dynamic",
      status: "draft",
      targetFiles: ["skills/find.code_symbol/SKILL.md"],
      patchSummary: "Preflight dynamic risk",
      patchText: "patch",
      candidateDir: config.skillEvolution.candidateDir,
      createdAt: new Date().toISOString(),
    }, null, config) as {
      automation_ceiling?: string;
    };
    assert.equal(preflightDynamicRisk.automation_ceiling, "auto_propose");

    persistObservabilityJob("job_observability_dynamic_pre_audit", "Stop before audit after audit failures");
    appendEvent(createUiEvent({
      jobId: "job_observability_dynamic_pre_audit",
      seq: 1,
      type: "planner.decision",
      title: "Planner selected research skill",
      summary: "Selected find.code_symbol for research discovery.",
      status: "success",
      agent: "planner",
      meta: {
        selected_skill: "find.code_symbol",
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
      },
    }));
    const recordModule = await import("../../src/job-store.js");
    const record = recordModule.readJobRecord("job_observability_dynamic_pre_audit");
    assert.equal(Boolean(record), true);

    __testables.runAutomaticSkillEvolutionForRecord(record!, config);

    const proposalsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), proposalsRes);
    const proposalsBody = JSON.parse(proposalsRes.body) as {
      data?: Array<{
        id?: string;
        skillId?: string;
        status?: string;
        auditReportPath?: string;
        automation_block?: {
          blockedStage?: string;
          automationCeiling?: string;
        } | null;
      }>;
    };
    const proposal = proposalsBody.data?.find((entry) =>
      entry.skillId === "find.code_symbol"
      && entry.id !== "proposal_prior_audit_failure_dynamic"
    );
    assert.equal(proposal?.status, "draft");
    assert.equal(proposal?.auditReportPath ?? null, null);
    assert.equal(proposal?.automation_block?.blockedStage, "auto_audit");
    assert.equal(proposal?.automation_block?.automationCeiling, "auto_propose");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_dynamic_pre_audit/events"), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type?: string; meta?: { blocked_stage?: string; dynamic_risk?: boolean; automation_ceiling?: string } }>;
    };
    const blockedEvent = eventsBody.events.find((event) => event.type === "system.skill_evolution_automation_blocked");
    assert.equal(blockedEvent?.meta?.blocked_stage, "auto_audit");
    assert.equal(blockedEvent?.meta?.dynamic_risk, true);
    assert.equal(blockedEvent?.meta?.automation_ceiling, "auto_propose");
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
    rmSync(candidateDir, { recursive: true, force: true });
  }
});

test("skill evolution auto pipeline keeps medium-tier skills validated but not accepted when ceiling stops at validate", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-auto-evolve-medium-ceiling-"));
  const builtinRoot = join(tempRoot, "skills");
  const candidateDir = join(tempRoot, "runtime", "skill-evolution");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Research Symbol Discovery",
    description: "Locate repository symbols for research workflows.",
    intents: ["research"],
    keywords: ["research", "source"],
    requiredTools: ["list_files", "read_file"],
    install: {
      source: "builtin",
      location: join(tempRoot, "skills", "find.code_symbol").replace(/\\/g, "/"),
    },
    activation: {
      mode: "intent_match",
      priority: 100,
    },
    execution: {
      strategy: "workflow_template",
      templateId: "find_code_symbol_v1",
    },
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.autoPropose = true;
  config.skillEvolution.autoAudit = true;
  config.skillEvolution.autoValidate = true;
  config.skillEvolution.autoAccept = true;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  config.skillEvolution.riskTiering.enabled = true;
  config.skillEvolution.riskTiering.defaultTier = "medium";
  config.skillEvolution.riskTiering.automationCeilings.medium = "auto_validate";
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_auto_pipeline_medium_ceiling", "Stop low-impact skills at validated");
    appendEvent(createUiEvent({
      jobId: "job_observability_auto_pipeline_medium_ceiling",
      seq: 1,
      type: "planner.decision",
      title: "Planner selected research skill",
      summary: "Selected find.code_symbol for research discovery.",
      status: "success",
      agent: "planner",
      meta: {
        selected_skill: "find.code_symbol",
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
      },
    }));
    const recordModule = await import("../../src/job-store.js");
    const record = recordModule.readJobRecord("job_observability_auto_pipeline_medium_ceiling");
    assert.equal(Boolean(record), true);

    __testables.runAutomaticSkillEvolutionForRecord(record!, config);

    const proposalsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), proposalsRes);
    const proposalsBody = JSON.parse(proposalsRes.body) as {
      data?: Array<{
        id?: string;
        skillId?: string;
        status?: string;
        validationReportPath?: string;
        automation_block?: {
          riskTier?: string;
          blockedStage?: string;
          automationCeiling?: string;
        } | null;
      }>;
    };
    const proposal = proposalsBody.data?.find((entry) =>
      entry.skillId === "find.code_symbol"
      && entry.status === "validated"
      && typeof entry.validationReportPath === "string",
    );
    assert.equal(Boolean(proposal), true);
    assert.equal(proposal?.automation_block?.blockedStage, "auto_accept");
    assert.equal(proposal?.automation_block?.automationCeiling, "auto_validate");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_auto_pipeline_medium_ceiling/events"), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type?: string; meta?: { blocked_stage?: string; proposal_id?: string; risk_tier?: string; dynamic_risk?: boolean; automation_ceiling?: string } }>;
    };
    const blockedEvent = eventsBody.events.find((event) =>
      event.type === "system.skill_evolution_automation_blocked"
      && event.meta?.proposal_id === proposal?.id
    );
    assert.equal(blockedEvent?.meta?.blocked_stage, "auto_accept");
    assert.equal(blockedEvent?.meta?.dynamic_risk, true);
    assert.equal(blockedEvent?.meta?.automation_ceiling, "auto_validate");
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_validation_passed"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "system.skill_evolution_accepted"), false);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
    rmSync(candidateDir, { recursive: true, force: true });
  }
});
