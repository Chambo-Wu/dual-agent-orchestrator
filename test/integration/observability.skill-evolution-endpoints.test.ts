import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { __testables } from "../../src/index.js";
import {
  persistSkillEvolutionProposal,
  persistSkillReflectionRecord,
  updateSkillEvolutionProposal,
  persistSkillAuditReport,
  persistSkillDeploymentValidationReport,
} from "../../src/skill-evolution-store.js";
import {
  buildMinimalConfig,
  MockResponse,
  buildAuthorizedRequest,
  buildAuthorizedJsonRequest,
  findCandidateManifestPath,
  persistObservabilityJob,
  persistObservabilityJobWithOptions,
} from "../helpers/observability-helpers.js";

test("skill reflect endpoint creates a reflection for an explicit job", async () => {
  persistObservabilityJob("job_observability_reflect_explicit", "Create reflection from explicit job");

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_reflect_explicit",
  }), res);
  const body = JSON.parse(res.body) as {
    skill_id?: string;
    job_id?: string;
    reflection?: {
      skillId?: string;
      jobId?: string;
      reflectionKind?: string;
    };
    path?: string;
  };

  assert.equal(res.statusCode, 201);
  assert.equal(body.skill_id, "find.code_symbol");
  assert.equal(body.job_id, "job_observability_reflect_explicit");
  assert.equal(body.reflection?.skillId, "find.code_symbol");
  assert.equal(body.reflection?.jobId, "job_observability_reflect_explicit");
  assert.equal(typeof body.reflection?.reflectionKind, "string");
  assert.equal(typeof body.path, "string");
});

test("skill reflect endpoint falls back to the latest matching skill job", async () => {
  persistObservabilityJob("job_observability_reflect_latest", "Create reflection from latest matching job");

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {}), res);
  const body = JSON.parse(res.body) as {
    skill_id?: string;
    job_id?: string;
    reflection?: {
      skillId?: string;
      jobId?: string;
    };
  };

  assert.equal(res.statusCode, 201);
  assert.equal(body.skill_id, "find.code_symbol");
  assert.equal(body.reflection?.skillId, "find.code_symbol");
  assert.equal(body.job_id, body.reflection?.jobId);
});

test("skill propose endpoint creates a draft proposal from a reflection", async () => {
  persistObservabilityJob("job_observability_propose", "Create proposal from reflection");

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_propose",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
      skillId?: string;
    };
  };

  const proposeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/propose", {
    reflection_id: reflectBody.reflection?.id,
  }), proposeRes);
  const proposeBody = JSON.parse(proposeRes.body) as {
    skill_id?: string;
    reflection_id?: string;
    proposal?: {
      skillId?: string;
      sourceReflectionId?: string;
      status?: string;
      patchSummary?: string;
      patchText?: string;
    };
    path?: string;
    candidate_path?: string;
  };

  assert.equal(proposeRes.statusCode, 201);
  assert.equal(proposeBody.skill_id, "find.code_symbol");
  assert.equal(proposeBody.reflection_id, reflectBody.reflection?.id);
  assert.equal(proposeBody.proposal?.skillId, "find.code_symbol");
  assert.equal(proposeBody.proposal?.sourceReflectionId, reflectBody.reflection?.id);
  assert.equal(proposeBody.proposal?.status, "draft");
  assert.equal(typeof proposeBody.proposal?.patchSummary, "string");
  assert.equal(typeof proposeBody.proposal?.patchText, "string");
  assert.equal(typeof proposeBody.path, "string");
  assert.equal(typeof proposeBody.candidate_path, "string");
  assert.equal(existsSync(`${proposeBody.candidate_path}\\skills\\find.code_symbol\\skill.json`), true);
  const candidateManifest = JSON.parse(readFileSync(`${proposeBody.candidate_path}\\skills\\find.code_symbol\\skill.json`, "utf8")) as {
    id?: string;
    title?: string;
    description?: string;
  };
  assert.equal(candidateManifest.id, "find.code_symbol");
  assert.equal(typeof candidateManifest.title, "string");
  assert.equal(typeof candidateManifest.description, "string");

  const candidateMarkdownPath = `${proposeBody.candidate_path}\\skills\\find.code_symbol\\SKILL.md`;
  assert.equal(existsSync(candidateMarkdownPath), true);
  const candidateMarkdown = readFileSync(candidateMarkdownPath, "utf8");
  assert.equal(/(^|\n)##\s+Core Procedure\b/i.test(candidateMarkdown), true);
  assert.equal(/(^|\n)##\s+Appendix\b/i.test(candidateMarkdown), true);
});

test("skill propose endpoint scaffolds candidate SKILL.md when the live skill has no markdown yet", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-propose-scaffold-"));
  const builtinRoot = join(tempRoot, "skills");
  const candidateRoot = join(tempRoot, "runtime", "skill-evolution");
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
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_propose_scaffold", "Create proposal scaffold from reflection");

    const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
      job_id: "job_observability_propose_scaffold",
    }), reflectRes);
    const reflectBody = JSON.parse(reflectRes.body) as {
      reflection?: { id?: string };
    };

    const proposeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/propose", {
      reflection_id: reflectBody.reflection?.id,
    }), proposeRes);
    const proposeBody = JSON.parse(proposeRes.body) as {
      candidate_path?: string;
      proposal?: {
        targetFiles?: string[];
      };
    };

    assert.equal(proposeRes.statusCode, 201);
    const candidateMarkdownTarget = proposeBody.proposal?.targetFiles?.find((target) =>
      target.endsWith("/SKILL.md") || target.endsWith("\\SKILL.md")
    );
    assert.equal(typeof candidateMarkdownTarget, "string");
    const candidateMarkdownPath = join(String(proposeBody.candidate_path), candidateMarkdownTarget!);
    assert.equal(existsSync(candidateMarkdownPath), true);
    const candidateMarkdown = readFileSync(candidateMarkdownPath, "utf8");
    assert.equal(/(^|\n)#\s+Skill:/i.test(candidateMarkdown), true);
    assert.equal(/(^|\n)##\s+Core Procedure\b/i.test(candidateMarkdown), true);
    assert.equal(/(^|\n)##\s+Scenario Extensions\b/i.test(candidateMarkdown), true);
    assert.equal(/(^|\n)##\s+Appendix\b/i.test(candidateMarkdown), true);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(candidateRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill propose reflect-to-propose chain captures skill_defect candidate body changes", async () => {
  persistObservabilityJobWithOptions("job_observability_propose_skill_defect", "Create proposal from insufficient verification", {
    jobStatus: "completed",
    verified: false,
    verificationStatus: "insufficient",
    failedCheckNames: ["artifact_presence"],
    missingRequirements: ["file_excerpt"],
    includeArtifact: true,
    includeRelatedEvent: true,
  });

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_propose_skill_defect",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
      reflectionKind?: string;
      recommendedAction?: string;
      evidence?: {
        silentBypassSignal?: boolean;
      };
    };
  };

  const proposeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/propose", {
    reflection_id: reflectBody.reflection?.id,
  }), proposeRes);
  const proposeBody = JSON.parse(proposeRes.body) as {
    proposal?: {
      rationaleSummary?: {
        reflectionKind?: string;
      };
      diffSummary?: {
        scope?: string;
      };
      controlPlaneSummary?: {
        rationaleHeadline?: string;
      };
    };
    candidate_path?: string;
  };

  assert.equal(reflectRes.statusCode, 201);
  assert.equal(reflectBody.reflection?.reflectionKind, "skill_defect");
  assert.equal(reflectBody.reflection?.recommendedAction, "patch_body");
  assert.equal(reflectBody.reflection?.evidence?.silentBypassSignal, false);
  assert.equal(proposeRes.statusCode, 201);
  assert.equal(proposeBody.proposal?.rationaleSummary?.reflectionKind, "skill_defect");
  assert.equal(proposeBody.proposal?.diffSummary?.scope, "body_only");
  assert.equal(typeof proposeBody.proposal?.controlPlaneSummary?.rationaleHeadline, "string");

  const candidateMarkdownPath = join(String(proposeBody.candidate_path), "skills", "find.code_symbol", "SKILL.md");
  const candidateMarkdown = readFileSync(candidateMarkdownPath, "utf8");
  assert.equal(/Refine the core procedure for the skill_defect scenario/i.test(candidateMarkdown), true);
  assert.equal(/Auto-evolve note \(skill_defect\)/i.test(candidateMarkdown), true);
});

test("skill propose reflect-to-propose chain captures execution_lapse appendix-only changes", async () => {
  persistObservabilityJobWithOptions("job_observability_propose_execution_lapse", "Create proposal from silent bypass", {
    jobStatus: "failed",
    verified: false,
    verificationStatus: "failed",
    failedCheckNames: ["artifact_presence"],
    missingRequirements: ["file_excerpt"],
    includeArtifact: false,
    includeRelatedEvent: false,
  });

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_propose_execution_lapse",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
      reflectionKind?: string;
      recommendedAction?: string;
      evidence?: {
        silentBypassSignal?: boolean;
      };
    };
  };

  const proposeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/propose", {
    reflection_id: reflectBody.reflection?.id,
  }), proposeRes);
  const proposeBody = JSON.parse(proposeRes.body) as {
    proposal?: {
      rationaleSummary?: {
        reflectionKind?: string;
      };
      diffSummary?: {
        scope?: string;
      };
    };
    candidate_path?: string;
  };

  assert.equal(reflectRes.statusCode, 201);
  assert.equal(reflectBody.reflection?.reflectionKind, "execution_lapse");
  assert.equal(reflectBody.reflection?.recommendedAction, "append_appendix");
  assert.equal(reflectBody.reflection?.evidence?.silentBypassSignal, true);
  assert.equal(proposeRes.statusCode, 201);
  assert.equal(proposeBody.proposal?.rationaleSummary?.reflectionKind, "execution_lapse");
  assert.equal(proposeBody.proposal?.diffSummary?.scope, "appendix_only");

  const candidateMarkdownPath = join(String(proposeBody.candidate_path), "skills", "find.code_symbol", "SKILL.md");
  const candidateMarkdown = readFileSync(candidateMarkdownPath, "utf8");
  assert.equal(/Auto-evolve note \(execution_lapse\)/i.test(candidateMarkdown), true);
  assert.equal(/Refine the core procedure for the execution_lapse scenario/i.test(candidateMarkdown), false);
  assert.equal(/Scenario extension \(execution_lapse\)/i.test(candidateMarkdown), false);
});

test("shared markdown section patch policy blocks execution_lapse proposals that mutate core procedure", async () => {
  persistObservabilityJob("job_observability_section_policy", "Keep execution_lapse patches out of core procedure");
  persistSkillReflectionRecord({
    id: "refl_section_policy_1",
    skillId: "find.code_symbol",
    jobId: "job_observability_section_policy",
    reflectionKind: "execution_lapse",
    reason: "This kind should stay in appendix-only guidance.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["file_excerpt"],
      eventIds: [],
      artifactIds: ["job_observability_section_policy_artifact"],
      silentBypassSignal: false,
    },
    recommendedAction: "append_appendix",
    createdAt: new Date().toISOString(),
  });

  const proposeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/propose", {
    reflection_id: "refl_section_policy_1",
  }), proposeRes);
  const proposeBody = JSON.parse(proposeRes.body) as {
    proposal?: {
      id?: string;
    };
    candidate_path?: string;
  };
  const proposalId = proposeBody.proposal?.id ?? "";
  const candidateMarkdownPath = join(String(proposeBody.candidate_path), "skills", "find.code_symbol", "SKILL.md");
  const candidateMarkdown = readFileSync(candidateMarkdownPath, "utf8");
  writeFileSync(
    candidateMarkdownPath,
    candidateMarkdown.replace(/(##\s+Core Procedure\s*\n)/i, "$1- Illicit core mutation for execution_lapse.\n"),
    "utf8",
  );

  const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);
  const auditBody = JSON.parse(auditRes.body) as {
    proposal?: {
      status?: string;
    };
    audit?: {
      passed?: boolean;
      checks?: Array<{
        name?: string;
        passed?: boolean;
      }>;
    };
  };

  assert.equal(proposeRes.statusCode, 201);
  assert.equal(auditRes.statusCode, 200);
  assert.equal(auditBody.proposal?.status, "audit_failed");
  assert.equal(auditBody.audit?.passed, false);
  assert.equal(auditBody.audit?.checks?.find((check) => check.name === "markdown_section_patch_policy")?.passed, false);

  updateSkillEvolutionProposal(proposalId, (proposal) => ({
    ...proposal,
    status: "validated",
  }), "runtime/skill-evolution");

  const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/validate`, {}), validateRes);
  const validateBody = JSON.parse(validateRes.body) as {
    proposal?: {
      status?: string;
    };
    validation?: {
      passed?: boolean;
      contract?: {
        hardGates?: Array<{
          name?: string;
          passed?: boolean;
        }>;
      };
      decision?: {
        reasonCode?: string;
      };
    };
  };

  assert.equal(validateRes.statusCode, 200);
  assert.equal(validateBody.proposal?.status, "validation_failed");
  assert.equal(validateBody.validation?.passed, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "markdown_section_policy_ready")?.passed, false);
  assert.equal(validateBody.validation?.decision?.reasonCode, "candidate_not_verified");
});

test("skill evolution proposal control plane lists and fetches persisted proposals", async () => {
  persistObservabilityJob("job_observability_proposal_list", "List skill evolution proposals");

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_proposal_list",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
    };
  };

  const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
    reflection_id: reflectBody.reflection?.id,
  }), createRes);
  const createBody = JSON.parse(createRes.body) as {
    proposal?: {
      id?: string;
      skillId?: string;
      sourceReflectionId?: string;
      status?: string;
    };
  };

  const listRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals"), listRes);
  const listBody = JSON.parse(listRes.body) as {
    object?: string;
    summary?: {
      total_proposals?: number;
      queue_count?: number;
      statuses?: Record<string, number>;
      funnel?: Record<string, number>;
      aging_buckets?: Record<string, number>;
      dynamic_risk?: Record<string, number>;
      eligibility?: Record<string, number>;
      stuck_count?: number;
    };
    filters?: {
      skills?: string[];
      statuses?: string[];
      risk_tiers?: string[];
      queue_states?: string[];
      next_actions?: string[];
    };
    data?: Array<{
      id?: string;
      skillId?: string;
      sourceReflectionId?: string;
      status?: string;
      ops_summary?: {
        queue_state?: string;
        funnel_stage?: string;
        age_bucket?: string;
        next_action?: string;
        queue_category?: string;
        actionable?: boolean;
        auto_accept_eligible?: boolean;
        dynamic_risk_tier?: string;
        stuck_state?: {
          stuck?: boolean;
          reasons?: string[];
        };
      };
      dynamic_risk?: {
        tier?: string;
        reasons?: string[];
      };
      eligibility?: {
        eligible?: boolean;
        reasons?: string[];
        contract?: {
          state?: string;
          gates?: Record<string, boolean>;
          required_action?: string;
        };
      };
    }>;
  };

  const getRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/skill-evolution/proposals/${createBody.proposal?.id}`), getRes);
  const getBody = JSON.parse(getRes.body) as {
    id?: string;
    skillId?: string;
    sourceReflectionId?: string;
    status?: string;
    validation_summary?: Record<string, unknown> | null;
    ops_summary?: {
      queue_state?: string;
      funnel_stage?: string;
      age_bucket?: string;
      next_action?: string;
      queue_category?: string;
      actionable?: boolean;
      auto_accept_eligible?: boolean;
      dynamic_risk_tier?: string;
      stuck_state?: {
        stuck?: boolean;
        reasons?: string[];
      };
    };
    dynamic_risk?: {
      tier?: string;
      reasons?: string[];
    };
    eligibility?: {
      eligible?: boolean;
      reasons?: string[];
      contract?: {
        state?: string;
        gates?: Record<string, boolean>;
        required_action?: string;
      };
    };
    rollback_guide?: Record<string, unknown> | null;
  };
  const listedProposal = listBody.data?.find((proposal) => proposal.id === createBody.proposal?.id);

  assert.equal(createRes.statusCode, 201);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listBody.object, "list");
  assert.equal((listBody.summary?.queue_count ?? 0) >= 1, true);
  assert.equal((listBody.summary?.statuses?.draft ?? 0) >= 1, true);
  assert.equal((listBody.summary?.funnel?.proposal_created ?? 0) >= 1, true);
  assert.equal(typeof listBody.summary?.aging_buckets?.under_1h, "number");
  assert.equal(typeof listBody.summary?.dynamic_risk?.low, "number");
  assert.equal(typeof listBody.summary?.eligibility?.blocked, "number");
  assert.equal(typeof listBody.summary?.stuck_count, "number");
  assert.equal(listBody.filters?.skills?.includes("find.code_symbol"), true);
  assert.equal(Array.isArray(listBody.filters?.statuses), true);
  assert.equal(Array.isArray(listBody.filters?.risk_tiers), true);
  assert.equal(Array.isArray(listBody.filters?.queue_states), true);
  assert.equal(Array.isArray(listBody.filters?.next_actions), true);
  assert.equal(listedProposal?.skillId, "find.code_symbol");
  assert.equal(listedProposal?.ops_summary?.queue_state, "proposal_queue");
  assert.equal(listedProposal?.ops_summary?.funnel_stage, "proposal_created");
  assert.equal(listedProposal?.ops_summary?.age_bucket, "under_1h");
  assert.equal(typeof listedProposal?.ops_summary?.next_action, "string");
  assert.equal(typeof listedProposal?.ops_summary?.queue_category, "string");
  assert.equal(listedProposal?.ops_summary?.actionable, true);
  assert.equal(listedProposal?.ops_summary?.auto_accept_eligible, false);
  assert.equal(typeof listedProposal?.ops_summary?.dynamic_risk_tier, "string");
  assert.equal(typeof listedProposal?.ops_summary?.stuck_state?.stuck, "boolean");
  assert.equal(typeof listedProposal?.dynamic_risk?.tier, "string");
  assert.equal(listedProposal?.eligibility?.eligible, false);
  assert.equal(listedProposal?.eligibility?.contract?.state, "pending_validation");
  assert.equal(listedProposal?.eligibility?.contract?.required_action, "run_validation");
  assert.equal(getRes.statusCode, 200);
  assert.equal(getBody.id, createBody.proposal?.id);
  assert.equal(getBody.skillId, "find.code_symbol");
  assert.equal(getBody.sourceReflectionId, reflectBody.reflection?.id);
  assert.equal(getBody.status, "draft");
  assert.equal(getBody.validation_summary ?? null, null);
  assert.equal(getBody.ops_summary?.queue_state, "proposal_queue");
  assert.equal(getBody.ops_summary?.funnel_stage, "proposal_created");
  assert.equal(typeof getBody.ops_summary?.next_action, "string");
  assert.equal(typeof getBody.ops_summary?.queue_category, "string");
  assert.equal(getBody.ops_summary?.actionable, true);
  assert.equal(getBody.ops_summary?.auto_accept_eligible, false);
  assert.equal(typeof getBody.ops_summary?.dynamic_risk_tier, "string");
  assert.equal(typeof getBody.ops_summary?.stuck_state?.stuck, "boolean");
  assert.equal(typeof getBody.dynamic_risk?.tier, "string");
  assert.equal(getBody.eligibility?.eligible, false);
  assert.equal(getBody.eligibility?.contract?.state, "pending_validation");
  assert.equal(getBody.eligibility?.contract?.gates?.proposal_status_validated, false);
  assert.equal(getBody.rollback_guide ?? null, null);
});

test("skill evolution ops exposes dynamic risk downgrade and eligibility reasons", async () => {
  const now = new Date().toISOString();
  persistSkillReflectionRecord({
    id: "refl_dynamic_risk_current",
    skillId: "find.code_symbol",
    jobId: "job_dynamic_risk_current",
    reflectionKind: "skill_defect",
    reason: "Current proposal should explain dynamic risk.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["symbol_hits"],
      eventIds: [],
      artifactIds: ["artifact_dynamic_risk_current"],
      silentBypassSignal: false,
    },
    recommendedAction: "patch_body",
    createdAt: now,
  });
  persistSkillReflectionRecord({
    id: "refl_dynamic_risk_prior",
    skillId: "find.code_symbol",
    jobId: "job_dynamic_risk_prior",
    reflectionKind: "skill_defect",
    reason: "Prior proposal failed validation.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["symbol_hits"],
      eventIds: [],
      artifactIds: [],
      silentBypassSignal: false,
    },
    recommendedAction: "patch_body",
    createdAt: now,
  });
  persistSkillEvolutionProposal({
    id: "proposal_dynamic_risk_prior",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_dynamic_risk_prior",
    status: "validation_failed",
    targetFiles: ["skills/find.code_symbol/SKILL.md"],
    patchSummary: "Prior validation failure",
    patchText: "patch",
    candidateDir: "runtime/skill-evolution",
    createdAt: now,
  });
  persistSkillEvolutionProposal({
    id: "proposal_dynamic_risk_current",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_dynamic_risk_current",
    status: "validated",
    targetFiles: ["skills/find.code_symbol/SKILL.md"],
    patchSummary: "Current validation needs manual review",
    patchText: "patch",
    candidateDir: "runtime/skill-evolution",
    createdAt: now,
  });
  persistSkillAuditReport({
    proposalId: "proposal_dynamic_risk_current",
    passed: true,
    checks: [{ name: "safe", passed: true, detail: "safe" }],
    summary: "Audit passed.",
    createdAt: now,
  });
  persistSkillDeploymentValidationReport({
    proposalId: "proposal_dynamic_risk_prior",
    passed: false,
    risk: { tier: "high", skillClass: "coding_like", summary: "High risk.", acceptanceFocus: "non_regression" },
    stability: {
      replayInstabilityDetected: true,
      candidateFlakySignal: true,
      autoAcceptBlocked: true,
      replayStabilityScore: 0,
      replayStabilityLevel: "unstable",
      reasons: ["prior validation failed"],
    },
    contract: {
      baselineSelection: { source: "reflection_only", reflectionId: "refl_dynamic_risk_prior", reason: "reflection only" },
      inputEquivalence: { mode: "same_recorded_input", satisfied: true, reason: "same recorded input" },
      hardGates: [],
    },
    replay: {
      mode: "record_replay",
      runtimeBoundary: {
        source: "candidate_snapshot",
        contract: "manifest_replay_only",
        candidateRuntimeConfigPrepared: false,
        trueRuntimeReplayEnabled: false,
        trueRuntimeReplayReady: false,
        autoAcceptEligible: false,
        reason: "Prior validation did not reach true runtime replay.",
      },
      sameInputComparison: {
        mode: "recorded_baseline_vs_candidate",
        inputAligned: true,
        baselineObserved: true,
        candidateObserved: false,
        baselineSelected: true,
        candidateSelected: false,
        baselineVerified: false,
        candidateVerified: false,
        artifactDelta: 0,
        failedChecksDelta: 1,
        resolvedMissingRequirements: [],
        remainingMissingRequirements: ["symbol_hits"],
        introducedMissingRequirements: [],
        evidenceLevel: "weak",
        readiness: "blocked",
        summary: "Prior proposal was blocked.",
      },
      provenance: {
        baselineSource: "reflection_record",
        candidateSource: "candidate_snapshot",
        baselineSelectedSkillSource: "reflection_record",
        candidateSelectedSkillSource: "candidate_manifest",
        candidateDir: "runtime/skill-evolution",
        isolated: false,
        note: "blocked",
        candidateBinding: {
          manifestPresent: true,
          runtimePrepared: false,
          targetFileCount: 1,
          changedFileCount: 1,
          selectedSkillMatchesProposal: true,
          selectedSkillMatchesReflection: true,
          bindingReady: false,
          reasons: ["runtime not prepared"],
        },
        executionEvidence: {
          reflectionEventIds: [],
          reflectionArtifactIds: [],
          baselineHadArtifacts: false,
          silentBypassSignal: false,
          candidateManifestPresent: true,
          candidateChangedFiles: ["skills/find.code_symbol/SKILL.md"],
          candidateVerified: false,
          level: "weak",
          summary: "weak",
        },
      },
      baseline: {
        selectedSkillId: "find.code_symbol",
        verified: false,
        artifactCount: 0,
        failedChecks: ["artifact_presence"],
        missingRequirements: ["symbol_hits"],
      },
      candidate: {
        proposalId: "proposal_dynamic_risk_prior",
        selectedSkillId: "find.code_symbol",
        candidateManifestPresent: true,
        changedFiles: ["skills/find.code_symbol/SKILL.md"],
        verified: false,
        artifactCount: 0,
        failedChecks: ["artifact_presence"],
        missingRequirements: ["symbol_hits"],
      },
    },
    comparison: {
      candidateSelected: false,
      candidateVerified: false,
      baselineVerified: false,
      candidateArtifactCount: 0,
      baselineArtifactCount: 0,
      candidateFailedChecks: ["artifact_presence"],
      baselineFailedChecks: ["artifact_presence"],
    },
    decision: {
      reasonCode: "candidate_not_verified",
      autoAcceptReady: false,
      details: ["candidate not verified"],
    },
    summary: "Prior validation failed.",
    createdAt: now,
  });
  persistSkillDeploymentValidationReport({
    proposalId: "proposal_dynamic_risk_current",
    passed: true,
    risk: { tier: "high", skillClass: "coding_like", summary: "High risk.", acceptanceFocus: "non_regression" },
    stability: {
      replayInstabilityDetected: false,
      candidateFlakySignal: false,
      autoAcceptBlocked: false,
      replayStabilityScore: 60,
      replayStabilityLevel: "watch",
      reasons: [],
    },
    contract: {
      baselineSelection: { source: "source_reflection_job", jobId: "job_dynamic_risk_current", reason: "job selected" },
      inputEquivalence: { mode: "same_recorded_input", satisfied: true, reason: "same input" },
      hardGates: [],
    },
    replay: {
      mode: "record_replay",
      runtimeBoundary: {
        source: "isolated_manifest_replay",
        contract: "manifest_replay_only",
        candidateRuntimeConfigPrepared: true,
        trueRuntimeReplayEnabled: false,
        trueRuntimeReplayReady: false,
        autoAcceptEligible: false,
        reason: "Isolated manifest replay did not execute true runtime.",
      },
      sameInputComparison: {
        mode: "baseline_job_vs_candidate_runtime",
        inputAligned: true,
        baselineObserved: true,
        candidateObserved: true,
        baselineSelected: true,
        candidateSelected: true,
        baselineVerified: true,
        candidateVerified: true,
        artifactDelta: 1,
        failedChecksDelta: -1,
        resolvedMissingRequirements: ["symbol_hits"],
        remainingMissingRequirements: [],
        introducedMissingRequirements: [],
        evidenceLevel: "direct",
        readiness: "needs_replay",
        summary: "Needs true runtime replay.",
      },
      provenance: {
        baselineSource: "job_record",
        candidateSource: "candidate_runtime_config",
        baselineSelectedSkillSource: "job_selected_skill",
        candidateSelectedSkillSource: "candidate_manifest",
        candidateDir: "runtime/skill-evolution",
        isolated: true,
        note: "isolated replay only",
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
          reflectionEventIds: [],
          reflectionArtifactIds: ["artifact_dynamic_risk_current"],
          baselineHadArtifacts: true,
          silentBypassSignal: false,
          candidateManifestPresent: true,
          candidateChangedFiles: ["skills/find.code_symbol/SKILL.md"],
          candidateVerified: true,
          level: "direct",
          summary: "direct",
        },
      },
      baseline: {
        jobId: "job_dynamic_risk_current",
        selectedSkillId: "find.code_symbol",
        verified: true,
        artifactCount: 1,
        failedChecks: [],
        missingRequirements: [],
      },
      candidate: {
        proposalId: "proposal_dynamic_risk_current",
        selectedSkillId: "find.code_symbol",
        candidateManifestPresent: true,
        changedFiles: ["skills/find.code_symbol/SKILL.md"],
        verified: true,
        artifactCount: 2,
        failedChecks: [],
        missingRequirements: [],
      },
    },
    comparison: {
      candidateSelected: true,
      candidateVerified: true,
      baselineVerified: true,
      candidateArtifactCount: 2,
      baselineArtifactCount: 1,
      candidateFailedChecks: [],
      baselineFailedChecks: [],
    },
    decision: {
      reasonCode: "passed",
      autoAcceptReady: false,
      details: ["true runtime replay is not ready"],
    },
    summary: "Current validation passed but needs true runtime replay.",
    createdAt: now,
  });

  const getRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/proposals/proposal_dynamic_risk_current"), getRes);
  const getBody = JSON.parse(getRes.body) as {
    dynamic_risk?: {
      tier?: string;
      auto_accept_blocked?: boolean;
      automation_ceiling?: string;
      validation_failure_count?: number;
      replay_instability_count?: number;
      failure_rate?: number;
      failure_rate_sample_count?: number;
      failure_rate_failure_count?: number;
      failure_rate_downgrade?: boolean;
      cooldown_active?: boolean;
      cooldown_until?: string | null;
      window_hours?: number;
      failure_clusters?: Array<{
        category?: string;
        count?: number;
        active?: boolean;
        window_hours?: number;
        downgrade_stage?: string | null;
      }>;
      recovery_policy?: {
        strategy?: string;
        window_hours?: number;
        cooldown_active?: boolean;
        cooldown_until?: string | null;
        recovery_condition?: string;
        restored_ceiling?: string;
      };
      gate_summary?: Array<{
        stage?: string;
        allowed_by_ceiling?: boolean;
        allowed_by_config?: boolean;
        blocked_by_dynamic_risk?: boolean;
        reason?: string;
      }>;
      reasons?: string[];
    };
    eligibility?: {
      eligible?: boolean;
      reasons?: string[];
      contract?: {
        state?: string;
        gates?: Record<string, boolean>;
        required_action?: string;
      };
    };
    ops_summary?: {
      auto_accept_eligible?: boolean;
      dynamic_risk_tier?: string;
      dynamic_risk_cooldown_active?: boolean;
      dynamic_risk_cooldown_until?: string | null;
      stuck_state?: {
        stuck?: boolean;
        primary_category?: string | null;
        severity?: string | null;
        action_hint?: string | null;
        reasons?: string[];
        categories?: Array<{
          category?: string;
          severity?: string;
          action_hint?: string;
        }>;
      };
    };
  };

  const opsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/ops"), opsRes);
  const opsBody = JSON.parse(opsRes.body) as {
    summary?: {
      dynamic_risk?: Record<string, number>;
      eligibility?: Record<string, number>;
      stuck_count?: number;
      stuck_categories?: Record<string, number>;
    };
  };

  assert.equal(getRes.statusCode, 200);
  assert.equal(getBody.dynamic_risk?.tier, "high");
  assert.equal(getBody.dynamic_risk?.automation_ceiling, "auto_audit");
  assert.equal(getBody.dynamic_risk?.auto_accept_blocked, true);
  assert.equal((getBody.dynamic_risk?.validation_failure_count ?? 0) >= 1, true);
  assert.equal((getBody.dynamic_risk?.replay_instability_count ?? 0) >= 1, true);
  assert.equal((getBody.dynamic_risk?.failure_rate ?? 0) >= 0.5, true);
  assert.equal((getBody.dynamic_risk?.failure_rate_sample_count ?? 0) >= 2, true);
  assert.equal((getBody.dynamic_risk?.failure_rate_failure_count ?? 0) >= 1, true);
  assert.equal(getBody.dynamic_risk?.failure_rate_downgrade, true);
  assert.equal(getBody.dynamic_risk?.cooldown_active, true);
  assert.equal(typeof getBody.dynamic_risk?.cooldown_until, "string");
  assert.equal(getBody.dynamic_risk?.window_hours, 24);
  assert.equal(getBody.dynamic_risk?.failure_clusters?.some((cluster) =>
    cluster.category === "validation_failure"
    && cluster.active === true
    && cluster.downgrade_stage === "auto_audit"
    && cluster.window_hours === 24
  ), true);
  assert.equal(getBody.dynamic_risk?.failure_clusters?.some((cluster) =>
    cluster.category === "replay_instability"
    && cluster.active === true
  ), true);
  assert.equal(getBody.dynamic_risk?.recovery_policy?.strategy, "cooldown_window_clear");
  assert.equal(getBody.dynamic_risk?.recovery_policy?.cooldown_active, true);
  assert.equal(getBody.dynamic_risk?.recovery_policy?.window_hours, 24);
  assert.equal(typeof getBody.dynamic_risk?.recovery_policy?.recovery_condition, "string");
  assert.equal(getBody.dynamic_risk?.gate_summary?.some((gate) =>
    gate.stage === "auto_validate"
    && gate.allowed_by_ceiling === false
    && gate.blocked_by_dynamic_risk === true
  ), true);
  assert.equal(getBody.dynamic_risk?.gate_summary?.some((gate) =>
    gate.stage === "auto_accept"
    && gate.allowed_by_ceiling === false
  ), true);
  assert.equal(getBody.eligibility?.eligible, false);
  assert.equal(getBody.eligibility?.reasons?.some((reason) => reason.includes("dynamic risk")), true);
  assert.equal(getBody.eligibility?.contract?.state, "blocked");
  assert.equal(getBody.eligibility?.contract?.gates?.dynamic_risk_allows_auto_accept, false);
  assert.equal(getBody.ops_summary?.auto_accept_eligible, false);
  assert.equal(getBody.ops_summary?.dynamic_risk_tier, "high");
  assert.equal(getBody.ops_summary?.dynamic_risk_cooldown_active, true);
  assert.equal(typeof getBody.ops_summary?.dynamic_risk_cooldown_until, "string");
  assert.equal(getBody.ops_summary?.stuck_state?.stuck, true);
  assert.equal(getBody.ops_summary?.stuck_state?.primary_category, "dynamic_risk_blocked");
  assert.equal(getBody.ops_summary?.stuck_state?.severity, "critical");
  assert.equal(getBody.ops_summary?.next_action, "wait_or_manual_review");
  assert.equal(getBody.ops_summary?.queue_category, "dynamic_risk_blocked");
  assert.equal(getBody.ops_summary?.stuck_state?.next_action, "wait_or_manual_review");
  assert.equal(typeof getBody.ops_summary?.stuck_state?.action_hint, "string");
  assert.equal(getBody.ops_summary?.stuck_state?.categories?.some((item) => item.category === "manual_accept_required"), true);
  assert.equal(opsRes.statusCode, 200);
  assert.equal((opsBody.summary?.dynamic_risk?.high ?? 0) >= 1, true);
  assert.equal((opsBody.summary?.eligibility?.blocked ?? 0) >= 1, true);
  assert.equal((opsBody.summary?.stuck_count ?? 0) >= 1, true);
  assert.equal((opsBody.summary?.stuck_categories?.dynamic_risk_blocked ?? 0) >= 1, true);
});

test("skill evolution proposal audit endpoint validates a safe draft proposal", async () => {
  persistObservabilityJob("job_observability_audit_pass", "Audit a safe skill evolution proposal");

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_audit_pass",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
    };
  };

  const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
    reflection_id: reflectBody.reflection?.id,
  }), createRes);
  const createBody = JSON.parse(createRes.body) as {
    proposal?: {
      id?: string;
      targetFiles?: string[];
    };
    candidate_path?: string;
  };
  const candidateManifestPath = findCandidateManifestPath(createBody);
  const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as Record<string, unknown>;
  candidateManifest.description = "Candidate procedure adds clearer evidence guidance.";
  writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

  const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${createBody.proposal?.id}/audit`, {}), auditRes);
  const auditBody = JSON.parse(auditRes.body) as {
    proposal?: {
      id?: string;
      status?: string;
      auditReportPath?: string;
    };
    audit?: {
      passed?: boolean;
      checks?: Array<{ passed?: boolean }>;
    };
    path?: string;
  };

  assert.equal(auditRes.statusCode, 200);
  assert.equal(auditBody.proposal?.id, createBody.proposal?.id);
  assert.equal(auditBody.proposal?.status, "validated");
  assert.equal(auditBody.audit?.passed, true);
  assert.equal(auditBody.audit?.checks?.every((check) => check.passed === true), true);
  assert.equal(typeof auditBody.proposal?.auditReportPath, "string");
  assert.equal(typeof auditBody.path, "string");
});

test("skill evolution proposal audit endpoint fails a risky draft proposal", async () => {
  persistObservabilityJob("job_observability_audit_fail", "Audit a risky candidate proposal");

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_audit_fail",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
    };
  };

  const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
    reflection_id: reflectBody.reflection?.id,
  }), createRes);
  const createBody = JSON.parse(createRes.body) as {
    proposal?: {
      id?: string;
      targetFiles?: string[];
    };
    candidate_path?: string;
  };
  const proposalId = createBody.proposal?.id;
  const candidateManifestPath = findCandidateManifestPath(createBody);
  const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as {
    requiredTools?: string[];
    description?: string;
  };
  candidateManifest.requiredTools = [...(candidateManifest.requiredTools ?? []), "dangerous_tool"];
  candidateManifest.description = `${candidateManifest.description ?? ""} D:\\private\\secret.txt`;
  writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

  const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);
  const auditBody = JSON.parse(auditRes.body) as {
    proposal?: {
      id?: string;
      status?: string;
    };
    audit?: {
      passed?: boolean;
      checks?: Array<{ name?: string; passed?: boolean }>;
    };
  };

  assert.equal(auditRes.statusCode, 200);
  assert.equal(auditBody.proposal?.id, proposalId);
  assert.equal(auditBody.proposal?.status, "audit_failed");
  assert.equal(auditBody.audit?.passed, false);
  assert.equal(auditBody.audit?.checks?.some((check) => check.name === "no_tool_scope_escalation" && check.passed === false), true);
  assert.equal(auditBody.audit?.checks?.some((check) => check.name === "no_secret_or_task_leakage" && check.passed === false), true);
});

test("skill evolution proposal validate endpoint passes an improving validated proposal", async () => {
  persistObservabilityJob("job_observability_validate_pass", "Validate an improving proposal");

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_validate_pass",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
    };
  };

  const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
    reflection_id: reflectBody.reflection?.id,
  }), createRes);
  const createBody = JSON.parse(createRes.body) as {
    proposal?: {
      id?: string;
      targetFiles?: string[];
    };
    candidate_path?: string;
  };
  const proposalId = createBody.proposal?.id;
  const candidateManifestPath = findCandidateManifestPath(createBody);
  const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as {
    description?: string;
  };
  candidateManifest.description = "Improved candidate skill guidance for evidence capture.";
  writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

  const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);

  const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/validate`, {}), validateRes);
  const validateBody = JSON.parse(validateRes.body) as {
    proposal?: {
      id?: string;
      status?: string;
      validationReportPath?: string;
    };
    validation?: {
      passed?: boolean;
      risk?: {
        tier?: string;
        skillClass?: string;
        acceptanceFocus?: string;
        summary?: string;
      };
      stability?: {
        replayInstabilityDetected?: boolean;
        candidateFlakySignal?: boolean;
        autoAcceptBlocked?: boolean;
        reasons?: string[];
      };
      contract?: {
        baselineSelection?: {
          source?: string;
        };
        inputEquivalence?: {
          satisfied?: boolean;
        };
        hardGates?: Array<{
          name?: string;
          passed?: boolean;
        }>;
      };
      comparison?: {
        candidateSelected?: boolean;
        candidateVerified?: boolean;
        baselineVerified?: boolean;
      };
      decision?: {
        reasonCode?: string;
        autoAcceptReady?: boolean;
      };
      replay?: {
        mode?: string;
        runtimeBoundary?: {
          source?: string;
          contract?: string;
          stage?: string;
          candidateRuntimeConfigPrepared?: boolean;
          candidateWorkflowMaterialized?: boolean;
          candidateWorkflowTaskCount?: number;
          trueRuntimeReplayEnabled?: boolean;
          trueRuntimeReplayReady?: boolean;
          autoAcceptEligible?: boolean;
          reason?: string;
        };
        sameInputComparison?: {
          inputAligned?: boolean;
          baselineObserved?: boolean;
          candidateObserved?: boolean;
          baselineSelected?: boolean;
          candidateSelected?: boolean;
          artifactDelta?: number;
          failedChecksDelta?: number;
          resolvedMissingRequirements?: string[];
          remainingMissingRequirements?: string[];
          introducedMissingRequirements?: string[];
          evidenceLevel?: string;
          readiness?: string;
          summary?: string;
        };
        provenance?: {
          baselineSource?: string;
          candidateSource?: string;
          baselineSelectedSkillSource?: string;
          candidateSelectedSkillSource?: string;
          candidateBinding?: {
            manifestPresent?: boolean;
            runtimePrepared?: boolean;
            targetFileCount?: number;
            changedFileCount?: number;
            selectedSkillMatchesProposal?: boolean;
            selectedSkillMatchesReflection?: boolean;
            bindingReady?: boolean;
            reasons?: string[];
          };
          executionEvidence?: {
            reflectionEventIds?: string[];
            reflectionArtifactIds?: string[];
            baselineHadArtifacts?: boolean;
            silentBypassSignal?: boolean;
            candidateManifestPresent?: boolean;
            candidateChangedFiles?: string[];
            candidateVerified?: boolean;
            level?: string;
            summary?: string;
          };
          isolated?: boolean;
          runtimeConfig?: {
            prepared?: boolean;
            builtinDir?: string;
            skillId?: string;
            workflowExecuted?: boolean;
            replayReady?: boolean;
          };
        };
        baseline?: {
          jobId?: string;
          replayJob?: {
            source?: string;
            jobId?: string;
            taskRunId?: string;
            status?: string;
            verificationStatus?: string;
            artifactCount?: number;
            stepSummary?: {
              replaySource?: string;
              totalSteps?: number;
              completedSteps?: number;
              blockedSteps?: number;
              verificationSteps?: number;
              evidenceArtifactCount?: number;
              requiredArtifactCount?: number;
              failedChecks?: string[];
              missingRequirements?: string[];
              terminalEventType?: string;
              terminalStatus?: string;
              summary?: string;
            };
            events?: Array<{
              seq?: number;
              type?: string;
              step?: string;
              status?: string;
              summary?: string;
              verificationStatus?: string;
              stepPayload?: {
                taskRunId?: string;
                replaySource?: string;
                manifestId?: string;
                artifactCount?: number;
                requiredArtifactCount?: number;
                checkCount?: number;
                passedCheckNames?: string[];
                failedCheckNames?: string[];
                missingRequirements?: string[];
                terminal?: boolean;
              };
            }>;
          };
          artifactCount?: number;
        };
        candidate?: {
          proposalId?: string;
          candidateManifestPresent?: boolean;
          changedFiles?: string[];
          replayJob?: {
            source?: string;
            jobId?: string;
            taskRunId?: string;
            status?: string;
            verificationStatus?: string;
            artifactCount?: number;
            stepSummary?: {
              replaySource?: string;
              totalSteps?: number;
              completedSteps?: number;
              blockedSteps?: number;
              verificationSteps?: number;
              evidenceArtifactCount?: number;
              requiredArtifactCount?: number;
              failedChecks?: string[];
              missingRequirements?: string[];
              terminalEventType?: string;
              terminalStatus?: string;
              summary?: string;
            };
            events?: Array<{
              seq?: number;
              type?: string;
              step?: string;
              status?: string;
              summary?: string;
              verificationStatus?: string;
              stepPayload?: {
                taskRunId?: string;
                replaySource?: string;
                manifestId?: string;
                artifactCount?: number;
                requiredArtifactCount?: number;
                checkCount?: number;
                passedCheckNames?: string[];
                failedCheckNames?: string[];
                missingRequirements?: string[];
                terminal?: boolean;
              };
            }>;
          };
        };
      };
    };
    path?: string;
  };
  const proposalDetailRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/skill-evolution/proposals/${proposalId}`), proposalDetailRes);
  const proposalDetailBody = JSON.parse(proposalDetailRes.body) as {
    id?: string;
    validation_summary?: {
      passed?: boolean;
      reason_code?: string;
      auto_accept_ready?: boolean;
      isolated_replay?: boolean;
      same_input_readiness?: string;
      replay_headline?: string;
      candidate_replay?: {
        status?: string;
        verification_status?: string;
        event_count?: number;
        terminal_event_type?: string;
      } | null;
    } | null;
  };
  const jobsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs"), jobsRes);
  const jobsBody = JSON.parse(jobsRes.body) as {
    data?: Array<{
      id?: string;
      workflow_summary?: {
        skill_evolution?: {
          latest_validation_summary?: {
            passed?: boolean;
            reason_code?: string;
            auto_accept_ready?: boolean;
            isolated_replay?: boolean;
            same_input_readiness?: string;
            candidate_replay?: {
              terminal_event_type?: string;
              event_count?: number;
            } | null;
          } | null;
        } | null;
      } | null;
    }>;
  };
  const validatedJob = jobsBody.data?.find((entry) => entry.id === "job_observability_validate_pass");

  assert.equal(validateRes.statusCode, 200);
  assert.equal(proposalDetailRes.statusCode, 200);
  assert.equal(validateBody.proposal?.id, proposalId);
  assert.equal(validateBody.proposal?.status, "validated");
  assert.equal(validateBody.validation?.passed, true);
  assert.equal(validateBody.validation?.risk?.tier, "high");
  assert.equal(validateBody.validation?.risk?.skillClass, "coding_like");
  assert.equal(validateBody.validation?.risk?.acceptanceFocus, "non_regression");
  assert.equal(typeof validateBody.validation?.risk?.summary, "string");
  assert.equal(validateBody.validation?.stability?.replayInstabilityDetected, false);
  assert.equal(validateBody.validation?.stability?.candidateFlakySignal, false);
  assert.equal(validateBody.validation?.stability?.autoAcceptBlocked, false);
  assert.equal(validateBody.validation?.contract?.baselineSelection?.source, "source_reflection_job");
  assert.equal(validateBody.validation?.contract?.inputEquivalence?.satisfied, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.every((gate) => gate.passed === true), true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "true_candidate_runtime_replay_enabled")?.passed, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "same_input_comparison_ready")?.passed, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "risk_tier_contract")?.passed, true);
  assert.equal(validateBody.validation?.comparison?.candidateSelected, true);
  assert.equal(validateBody.validation?.comparison?.candidateVerified, true);
  assert.equal(validateBody.validation?.resultTaxonomy?.category, "passed");
  assert.equal(validateBody.validation?.resultTaxonomy?.retryable, false);
  assert.equal(validateBody.validation?.decision?.reasonCode, "passed");
  assert.equal(validateBody.validation?.decision?.autoAcceptReady, true);
  assert.equal(validateBody.validation?.replay?.mode, "record_replay");
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.source, "candidate_runtime_config");
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.contract, "true_candidate_runtime_replay");
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.stage, "executed");
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.candidateRuntimeConfigPrepared, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.candidateWorkflowMaterialized, true);
  assert.equal((validateBody.validation?.replay?.runtimeBoundary?.candidateWorkflowTaskCount ?? 0) >= 2, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.trueRuntimeReplayEnabled, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.trueRuntimeReplayReady, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.autoAcceptEligible, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.reason?.includes("Candidate runtime workflow executed"), true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.mode, "baseline_job_vs_candidate_runtime");
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.inputAligned, true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.baselineObserved, true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.candidateObserved, true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.baselineSelected, true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.candidateSelected, true);
  assert.equal(typeof validateBody.validation?.replay?.sameInputComparison?.artifactDelta, "number");
  assert.equal((validateBody.validation?.replay?.sameInputComparison?.artifactDelta ?? 0) >= 0, true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.failedChecksDelta, 0);
  assert.equal(Array.isArray(validateBody.validation?.replay?.sameInputComparison?.resolvedMissingRequirements), true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.evidenceLevel, "direct");
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.readiness, "ready");
  assert.equal(typeof validateBody.validation?.replay?.sameInputComparison?.summary, "string");
  assert.equal(validateBody.validation?.replay?.provenance?.baselineSource, "job_record");
  assert.equal(validateBody.validation?.replay?.provenance?.candidateSource, "candidate_runtime_config");
  assert.equal(validateBody.validation?.replay?.provenance?.baselineSelectedSkillSource, "job_selected_skill");
  assert.equal(validateBody.validation?.replay?.provenance?.candidateSelectedSkillSource, "candidate_manifest");
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.workflowExecuted, true);
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.replayReady, true);
  assert.equal(validateBody.validation?.replay?.provenance?.candidateBinding?.manifestPresent, true);
  assert.equal(validateBody.validation?.replay?.provenance?.candidateBinding?.runtimePrepared, true);
  assert.equal(validateBody.validation?.replay?.provenance?.candidateBinding?.selectedSkillMatchesProposal, true);
  assert.equal(validateBody.validation?.replay?.provenance?.candidateBinding?.selectedSkillMatchesReflection, true);
  assert.equal(validateBody.validation?.replay?.provenance?.candidateBinding?.bindingReady, true);
  assert.equal(validateBody.validation?.replay?.provenance?.executionEvidence?.baselineHadArtifacts, true);
  assert.equal(validateBody.validation?.replay?.provenance?.executionEvidence?.silentBypassSignal, false);
  assert.equal(validateBody.validation?.replay?.provenance?.executionEvidence?.candidateManifestPresent, true);
  assert.equal(validateBody.validation?.replay?.provenance?.executionEvidence?.candidateVerified, true);
  assert.equal(validateBody.validation?.replay?.provenance?.executionEvidence?.level, "direct");
  assert.equal(Array.isArray(validateBody.validation?.replay?.provenance?.executionEvidence?.reflectionEventIds), true);
  assert.equal(Array.isArray(validateBody.validation?.replay?.provenance?.executionEvidence?.reflectionArtifactIds), true);
  assert.equal(Array.isArray(validateBody.validation?.replay?.provenance?.executionEvidence?.candidateChangedFiles), true);
  assert.equal(typeof validateBody.validation?.replay?.provenance?.executionEvidence?.summary, "string");
  assert.equal(validateBody.validation?.replay?.provenance?.isolated, true);
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.prepared, true);
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.skillId, "find.code_symbol");
  assert.equal(typeof validateBody.validation?.replay?.provenance?.runtimeConfig?.builtinDir, "string");
  assert.equal(validateBody.validation?.replay?.baseline?.jobId, "job_observability_validate_pass");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.source, "isolated_manifest_replay");
  assert.equal(typeof validateBody.validation?.replay?.baseline?.replayJob?.jobId, "string");
  assert.equal(typeof validateBody.validation?.replay?.baseline?.replayJob?.taskRunId, "string");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.status, "completed");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.verificationStatus, "verified");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.replaySource, "recorded_baseline_artifacts");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.totalSteps, validateBody.validation?.replay?.baseline?.replayJob?.events?.length);
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.terminalEventType, "replay_job_completed");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.terminalStatus, "completed");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.blockedSteps, 0);
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.failedChecks?.length, 0);
  assert.equal(typeof validateBody.validation?.replay?.baseline?.replayJob?.stepSummary?.summary, "string");
  assert.equal(Array.isArray(validateBody.validation?.replay?.baseline?.replayJob?.events), true);
  assert.equal((validateBody.validation?.replay?.baseline?.replayJob?.events?.length ?? 0) >= 6, true);
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.[0]?.type, "replay_job_created");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.[0]?.stepPayload?.taskRunId, validateBody.validation?.replay?.baseline?.replayJob?.taskRunId);
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.[0]?.stepPayload?.replaySource, "recorded_baseline_artifacts");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.[0]?.stepPayload?.manifestId, "find.code_symbol");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.at(-1)?.type, "replay_job_completed");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.at(-1)?.status, "completed");
  assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.events?.at(-1)?.stepPayload?.terminal, true);
  assert.equal(validateBody.validation?.replay?.baseline?.selectedSkillId, "find.code_symbol");
  assert.equal(typeof validateBody.validation?.replay?.baseline?.artifactCount, "number");
  assert.equal(validateBody.validation?.replay?.candidate?.proposalId, proposalId);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.source, "isolated_manifest_replay");
  assert.equal(typeof validateBody.validation?.replay?.candidate?.replayJob?.jobId, "string");
  assert.equal(typeof validateBody.validation?.replay?.candidate?.replayJob?.taskRunId, "string");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.status, "completed");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.verificationStatus, "verified");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.replaySource, "recorded_baseline_artifacts");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.totalSteps, validateBody.validation?.replay?.candidate?.replayJob?.events?.length);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.verificationSteps, 3);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.evidenceArtifactCount, validateBody.validation?.replay?.baseline?.artifactCount);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.terminalEventType, "replay_job_completed");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.terminalStatus, "completed");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.blockedSteps, 0);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.failedChecks?.length, 0);
  assert.equal(Array.isArray(validateBody.validation?.replay?.candidate?.replayJob?.events), true);
  assert.equal((validateBody.validation?.replay?.candidate?.replayJob?.events?.length ?? 0) >= 6, true);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.[0]?.type, "replay_job_created");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.[0]?.stepPayload?.taskRunId, validateBody.validation?.replay?.candidate?.replayJob?.taskRunId);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.[0]?.stepPayload?.replaySource, "recorded_baseline_artifacts");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.[0]?.stepPayload?.manifestId, "find.code_symbol");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.some((event) => event.type === "checks_evaluated" && event.stepPayload?.checkCount === 2), true);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.at(-1)?.type, "replay_job_completed");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.at(-1)?.verificationStatus, "verified");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.at(-1)?.stepPayload?.terminal, true);
  assert.equal(validateBody.validation?.replay?.candidate?.selectedSkillId, "find.code_symbol");
  assert.equal(validateBody.validation?.replay?.candidate?.candidateManifestPresent, true);
  assert.equal(Array.isArray(validateBody.validation?.replay?.candidate?.changedFiles), true);
  assert.equal(typeof validateBody.proposal?.validationReportPath, "string");
  assert.equal(typeof validateBody.path, "string");
  assert.equal(proposalDetailBody.id, proposalId);
  assert.equal(proposalDetailBody.validation_summary?.passed, true);
  assert.equal(proposalDetailBody.validation_summary?.reason_code, "passed");
  assert.equal(proposalDetailBody.validation_summary?.result_category, "passed");
  assert.equal(proposalDetailBody.validation_summary?.result_retryable, false);
  assert.equal(proposalDetailBody.validation_summary?.auto_accept_ready, true);
  assert.equal(proposalDetailBody.validation_summary?.isolated_replay, true);
  assert.equal(proposalDetailBody.validation_summary?.same_input_readiness, "ready");
  assert.equal(proposalDetailBody.validation_summary?.candidate_replay?.status, "completed");
  assert.equal(proposalDetailBody.validation_summary?.candidate_replay?.verification_status, "verified");
  assert.equal(proposalDetailBody.validation_summary?.candidate_replay?.terminal_event_type, "replay_job_completed");
  assert.equal((proposalDetailBody.validation_summary?.candidate_replay?.event_count ?? 0) >= 6, true);
  assert.equal(typeof proposalDetailBody.validation_summary?.replay_stability_score, "number");
  assert.equal(typeof proposalDetailBody.validation_summary?.replay_stability_level, "string");
  assert.equal(typeof proposalDetailBody.validation_summary?.replay_headline, "string");
  assert.equal(validatedJob?.workflow_summary?.skill_evolution?.latest_validation_summary?.passed, true);
  assert.equal(validatedJob?.workflow_summary?.skill_evolution?.latest_validation_summary?.reason_code, "passed");
  assert.equal(validatedJob?.workflow_summary?.skill_evolution?.latest_validation_summary?.same_input_readiness, "ready");
  assert.equal(validatedJob?.workflow_summary?.skill_evolution?.latest_validation_summary?.candidate_replay?.terminal_event_type, "replay_job_completed");
  assert.equal((validatedJob?.workflow_summary?.skill_evolution?.latest_validation_summary?.candidate_replay?.event_count ?? 0) >= 6, true);
});

test("skill evolution proposal validate endpoint executes isolated replay against stricter candidate verification requirements", async () => {
  persistObservabilityJob("job_observability_validate_isolated_replay", "Validate isolated replay against stricter candidate requirements");

  const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
    job_id: "job_observability_validate_isolated_replay",
  }), reflectRes);
  const reflectBody = JSON.parse(reflectRes.body) as {
    reflection?: {
      id?: string;
    };
  };

  const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
    reflection_id: reflectBody.reflection?.id,
  }), createRes);
  const createBody = JSON.parse(createRes.body) as {
    proposal?: {
      id?: string;
      targetFiles?: string[];
    };
    candidate_path?: string;
  };
  const proposalId = createBody.proposal?.id;
  const candidateManifestPath = findCandidateManifestPath(createBody);
  const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as {
    verification?: {
      requiredArtifacts?: string[];
    };
    description?: string;
  };
  candidateManifest.description = "Candidate keeps audit-safe wording before isolated replay mutation.";
  writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

  const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);

  const auditedCandidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as {
    verification?: {
      requiredArtifacts?: string[];
    };
    description?: string;
  };
  auditedCandidateManifest.description = "Candidate asks isolated replay to require an extra config excerpt.";
  auditedCandidateManifest.verification = {
    ...auditedCandidateManifest.verification,
    requiredArtifacts: [...(auditedCandidateManifest.verification?.requiredArtifacts ?? []), "config_excerpt"],
  };
  writeFileSync(candidateManifestPath, JSON.stringify(auditedCandidateManifest, null, 2), "utf8");

  const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/validate`, {}), validateRes);
  const validateBody = JSON.parse(validateRes.body) as {
    proposal?: {
      status?: string;
    };
    validation?: {
      passed?: boolean;
      comparison?: {
        candidateVerified?: boolean;
      };
      contract?: {
        hardGates?: Array<{
          name?: string;
          passed?: boolean;
        }>;
      };
      decision?: {
        reasonCode?: string;
        autoAcceptReady?: boolean;
      };
      replay?: {
        runtimeBoundary?: {
          source?: string;
          contract?: string;
          stage?: string;
          candidateRuntimeConfigPrepared?: boolean;
          candidateWorkflowMaterialized?: boolean;
          candidateWorkflowTaskCount?: number;
          trueRuntimeReplayEnabled?: boolean;
          trueRuntimeReplayReady?: boolean;
          autoAcceptEligible?: boolean;
          reason?: string;
        };
        sameInputComparison?: {
          mode?: string;
          introducedMissingRequirements?: string[];
          readiness?: string;
        };
        provenance?: {
          isolated?: boolean;
          runtimeConfig?: {
            workflowExecuted?: boolean;
            replayReady?: boolean;
          };
        };
        candidate?: {
          verificationStatus?: string;
          missingRequirements?: string[];
          replayJob?: {
            source?: string;
            status?: string;
            verificationStatus?: string;
            stepSummary?: {
              replaySource?: string;
              totalSteps?: number;
              blockedSteps?: number;
              failedChecks?: string[];
              missingRequirements?: string[];
              terminalEventType?: string;
              terminalStatus?: string;
            };
            events?: Array<{
              type?: string;
              status?: string;
              verificationStatus?: string;
              stepPayload?: {
                taskRunId?: string;
                replaySource?: string;
                manifestId?: string;
                failedCheckNames?: string[];
                missingRequirements?: string[];
                terminal?: boolean;
              };
            }>;
          };
        };
      };
    };
  };

  assert.equal(validateRes.statusCode, 200);
  assert.equal(validateBody.proposal?.status, "validation_failed");
  assert.equal(validateBody.validation?.passed, false);
  assert.equal(validateBody.validation?.comparison?.candidateVerified, false);
  assert.equal(validateBody.validation?.resultTaxonomy?.category, "candidate_failed");
  assert.equal(validateBody.validation?.resultTaxonomy?.retryable, true);
  assert.equal(validateBody.validation?.decision?.reasonCode, "candidate_not_verified");
  assert.equal(validateBody.validation?.decision?.autoAcceptReady, false);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.source, "candidate_runtime_config");
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.stage, "executed");
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.candidateWorkflowMaterialized, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.trueRuntimeReplayEnabled, true);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.trueRuntimeReplayReady, false);
  assert.equal(validateBody.validation?.replay?.runtimeBoundary?.autoAcceptEligible, false);
  assert.equal(validateBody.validation?.replay?.provenance?.isolated, true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.mode, "baseline_job_vs_candidate_runtime");
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.readiness, "needs_replay");
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.workflowExecuted, true);
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.replayReady, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "execution_evidence_ready")?.passed, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "same_input_comparison_ready")?.passed, false);
  assert.equal(validateBody.validation?.replay?.candidate?.verificationStatus, "insufficient");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.source, "isolated_manifest_replay");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.status, "blocked");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.verificationStatus, "insufficient");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.replaySource, "recorded_baseline_artifacts");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.terminalEventType, "replay_job_blocked");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.terminalStatus, "blocked");
  assert.equal((validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.blockedSteps ?? 0) > 0, true);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.failedChecks?.includes("artifact_presence"), true);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.stepSummary?.missingRequirements?.includes("config_excerpt"), true);
  assert.equal(Array.isArray(validateBody.validation?.replay?.candidate?.replayJob?.events), true);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.some((event) =>
    event.type === "checks_evaluated"
    && event.status === "blocked"
    && event.stepPayload?.failedCheckNames?.includes("artifact_presence") === true
    && event.stepPayload?.missingRequirements?.includes("config_excerpt") === true
  ), true);
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.at(-1)?.type, "replay_job_blocked");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.at(-1)?.verificationStatus, "insufficient");
  assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.events?.at(-1)?.stepPayload?.terminal, true);
  assert.equal(validateBody.validation?.replay?.candidate?.missingRequirements?.includes("config_excerpt"), true);
  assert.equal(validateBody.validation?.replay?.sameInputComparison?.introducedMissingRequirements?.includes("config_excerpt"), true);
});

test("skill evolution proposal validate endpoint lets isolated baseline replay override historical verified status", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-validate-baseline-replay-"));
  const builtinRoot = join(tempRoot, "skills");
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
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_validate_baseline_replay", "Validate with a stricter live baseline contract");
    persistSkillReflectionRecord({
      id: "refl_validate_baseline_replay_1",
      skillId: "find.code_symbol",
      jobId: "job_observability_validate_baseline_replay",
      reflectionKind: "skill_defect",
      reason: "The live verification contract changed and must be re-evaluated against recorded evidence.",
      evidence: {
        verificationStatus: "verified",
        failedCheckNames: [],
        missingRequirements: [],
        eventIds: ["evt_validate_baseline_replay_1"],
        artifactIds: ["job_observability_validate_baseline_replay_artifact"],
        silentBypassSignal: false,
      },
      recommendedAction: "patch_verification",
      createdAt: new Date().toISOString(),
    }, config.skillEvolution.candidateDir);

    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
      reflection_id: "refl_validate_baseline_replay_1",
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      proposal?: {
        id?: string;
      };
      candidate_path?: string;
    };
    const proposalId = createBody.proposal?.id ?? "";
    const candidateManifestPath = findCandidateManifestPath(createBody);
    const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as {
      description?: string;
      verification?: {
        requiredArtifacts?: string[];
        artifactLabels?: Record<string, string>;
        remediation?: {
          insufficient?: string;
          failed?: string;
        };
        successSignalLabel?: string;
      };
    };
    candidateManifest.description = "Candidate keeps the original verification contract but updates guidance.";
    candidateManifest.verification = {
      ...(candidateManifest.verification ?? {}),
      requiredArtifacts: ["symbol_hits"],
      artifactLabels: {
        ...(candidateManifest.verification?.artifactLabels ?? {}),
      },
      remediation: {
        ...(candidateManifest.verification?.remediation ?? {}),
      },
    };
    writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

    const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);

    const liveManifestPath = join(skillDir, "skill.json");
    const liveManifest = JSON.parse(readFileSync(liveManifestPath, "utf8")) as {
      verification?: {
        requiredArtifacts?: string[];
      };
    };
    liveManifest.verification = {
      ...liveManifest.verification,
      requiredArtifacts: [...(liveManifest.verification?.requiredArtifacts ?? []), "config_excerpt"],
    };
    writeFileSync(liveManifestPath, JSON.stringify(liveManifest, null, 2), "utf8");

    const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/validate`, {}), validateRes);
    const validateBody = JSON.parse(validateRes.body) as {
      proposal?: {
        status?: string;
      };
      validation?: {
        passed?: boolean;
        comparison?: {
          baselineVerified?: boolean;
          candidateVerified?: boolean;
        };
        replay?: {
          baseline?: {
            verified?: boolean;
            verificationStatus?: string;
            missingRequirements?: string[];
            replayJob?: {
              status?: string;
              verificationStatus?: string;
            };
          };
          candidate?: {
            verified?: boolean;
            verificationStatus?: string;
            replayJob?: {
              status?: string;
              verificationStatus?: string;
            };
          };
        };
      };
    };

    assert.equal(validateRes.statusCode, 200);
    assert.equal(validateBody.proposal?.status, "validated");
    assert.equal(validateBody.validation?.passed, true);
    assert.equal(validateBody.validation?.comparison?.baselineVerified, false);
    assert.equal(validateBody.validation?.comparison?.candidateVerified, true);
    assert.equal(validateBody.validation?.replay?.baseline?.verified, false);
    assert.equal(validateBody.validation?.replay?.baseline?.verificationStatus, "insufficient");
    assert.equal(validateBody.validation?.replay?.baseline?.missingRequirements?.includes("config_excerpt"), true);
    assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.status, "blocked");
    assert.equal(validateBody.validation?.replay?.baseline?.replayJob?.verificationStatus, "insufficient");
    assert.equal(validateBody.validation?.replay?.candidate?.verified, true);
    assert.equal(validateBody.validation?.replay?.candidate?.verificationStatus, "verified");
    assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.status, "completed");
    assert.equal(validateBody.validation?.replay?.candidate?.replayJob?.verificationStatus, "verified");
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution proposal validate endpoint fails a non-improving validated proposal", async () => {
  persistSkillReflectionRecord({
    id: "refl_validate_fail_1",
    skillId: "find.code_symbol",
    jobId: "job_observability_validate_fail",
    reflectionKind: "skill_defect",
    reason: "The skill was attempted but verification still failed.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence", "entrypoint_signal"],
      missingRequirements: ["symbol_hits"],
      eventIds: ["evt_validate_fail_1"],
      artifactIds: [],
      silentBypassSignal: false,
    },
    recommendedAction: "patch_body",
    createdAt: new Date().toISOString(),
  });
  persistSkillEvolutionProposal({
    id: "proposal_validate_fail_1",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_validate_fail_1",
    status: "validated",
    targetFiles: ["skills/find.code_symbol/skill.json"],
    patchSummary: "Weak proposal without clear improvement",
    patchText: "Keep the current procedure unchanged.",
    candidateDir: "runtime/skill-evolution",
    createdAt: new Date().toISOString(),
  });

  const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals/proposal_validate_fail_1/validate", {}), validateRes);
  const validateBody = JSON.parse(validateRes.body) as {
    proposal?: {
      id?: string;
      status?: string;
    };
    validation?: {
      passed?: boolean;
      risk?: {
        tier?: string;
        acceptanceFocus?: string;
      };
      stability?: {
        replayInstabilityDetected?: boolean;
        autoAcceptBlocked?: boolean;
      };
      contract?: {
        hardGates?: Array<{
          name?: string;
          passed?: boolean;
        }>;
      };
      comparison?: {
        candidateVerified?: boolean;
        baselineFailedChecks?: string[];
        candidateFailedChecks?: string[];
      };
      decision?: {
        reasonCode?: string;
        autoAcceptReady?: boolean;
      };
    };
  };

  assert.equal(validateRes.statusCode, 200);
  assert.equal(validateBody.proposal?.id, "proposal_validate_fail_1");
  assert.equal(validateBody.proposal?.status, "validation_failed");
  assert.equal(validateBody.validation?.passed, false);
  assert.equal(validateBody.validation?.risk?.tier, "high");
  assert.equal(validateBody.validation?.risk?.acceptanceFocus, "non_regression");
  assert.equal(validateBody.validation?.stability?.replayInstabilityDetected, true);
  assert.equal(validateBody.validation?.stability?.autoAcceptBlocked, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "silent_bypass_absent")?.passed, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "candidate_binding_ready")?.passed, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "execution_evidence_ready")?.passed, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "same_input_comparison_ready")?.passed, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "risk_tier_contract")?.passed, false);
  assert.equal(validateBody.validation?.comparison?.candidateVerified, false);
  assert.equal(validateBody.validation?.decision?.reasonCode, "candidate_not_verified");
  assert.equal(validateBody.validation?.decision?.autoAcceptReady, false);
  assert.deepEqual(validateBody.validation?.comparison?.candidateFailedChecks, ["artifact_presence", "entrypoint_signal"]);
});

test("skill evolution proposal validate endpoint reports candidate_runtime_prepared from actual replay runtime readiness", async () => {
  persistSkillReflectionRecord({
    id: "refl_validate_runtime_unprepared_1",
    skillId: "find.code_symbol",
    jobId: "job_observability_validate_runtime_unprepared",
    reflectionKind: "skill_defect",
    reason: "The proposal snapshot is incomplete for replay runtime preparation.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["symbol_hits"],
      eventIds: ["evt_validate_runtime_unprepared_1"],
      artifactIds: ["artifact_validate_runtime_unprepared_1"],
      silentBypassSignal: false,
    },
    recommendedAction: "patch_body",
    createdAt: new Date().toISOString(),
  });
  persistSkillEvolutionProposal({
    id: "proposal_validate_runtime_unprepared_1",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_validate_runtime_unprepared_1",
    status: "validated",
    targetFiles: ["docs/not-a-skill-target.md"],
    patchSummary: "Proposal lacks a replayable skill target file",
    patchText: "This candidate cannot derive replay runtime injection.",
    candidateDir: "runtime/skill-evolution",
    createdAt: new Date().toISOString(),
  });

  const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals/proposal_validate_runtime_unprepared_1/validate", {}), validateRes);
  const validateBody = JSON.parse(validateRes.body) as {
    proposal?: {
      status?: string;
    };
    validation?: {
      passed?: boolean;
      contract?: {
        hardGates?: Array<{
          name?: string;
          passed?: boolean;
          detail?: string;
        }>;
      };
      replay?: {
        provenance?: {
          candidateSource?: string;
          runtimeConfig?: {
            prepared?: boolean;
          };
        };
      };
    };
  };

  const runtimeGate = validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "candidate_runtime_prepared");
  assert.equal(validateRes.statusCode, 200);
  assert.equal(validateBody.proposal?.status, "validation_failed");
  assert.equal(validateBody.validation?.passed, false);
  assert.equal(runtimeGate?.passed, false);
  assert.equal(typeof runtimeGate?.detail, "string");
  assert.equal(runtimeGate?.detail?.includes("could not be prepared"), true);
  assert.equal(validateBody.validation?.replay?.provenance?.candidateSource, "candidate_snapshot");
  assert.equal(validateBody.validation?.replay?.provenance?.runtimeConfig?.prepared, false);
});

test("skill evolution proposal validate endpoint fails when reflection carries silent bypass", async () => {
  persistSkillReflectionRecord({
    id: "refl_validate_silent_bypass_1",
    skillId: "find.code_symbol",
    jobId: "job_observability_validate_silent_bypass",
    reflectionKind: "execution_lapse",
    reason: "The selected skill appears to have been bypassed without concrete execution evidence.",
    evidence: {
      verificationStatus: "failed",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["symbol_hits"],
      eventIds: [],
      artifactIds: [],
      silentBypassSignal: true,
    },
    recommendedAction: "append_appendix",
    createdAt: new Date().toISOString(),
  });
  persistSkillEvolutionProposal({
    id: "proposal_validate_silent_bypass_1",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_validate_silent_bypass_1",
    status: "validated",
    targetFiles: ["skills/find.code_symbol/skill.json"],
    patchSummary: "Appendix-only proposal with silent bypass baseline",
    patchText: "Clarify execution evidence expectations.",
    candidateDir: "runtime/skill-evolution",
    createdAt: new Date().toISOString(),
  });

  const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals/proposal_validate_silent_bypass_1/validate", {}), validateRes);
  const validateBody = JSON.parse(validateRes.body) as {
    proposal?: {
      status?: string;
    };
    validation?: {
      passed?: boolean;
      risk?: {
        tier?: string;
      };
      stability?: {
        replayInstabilityDetected?: boolean;
        autoAcceptBlocked?: boolean;
      };
      contract?: {
        hardGates?: Array<{
          name?: string;
          passed?: boolean;
        }>;
      };
      decision?: {
        reasonCode?: string;
        autoAcceptReady?: boolean;
      };
    };
  };

  assert.equal(validateRes.statusCode, 200);
  assert.equal(validateBody.proposal?.status, "validation_failed");
  assert.equal(validateBody.validation?.passed, false);
  assert.equal(validateBody.validation?.risk?.tier, "high");
  assert.equal(validateBody.validation?.stability?.autoAcceptBlocked, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "silent_bypass_absent")?.passed, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "candidate_binding_ready")?.passed, true);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "execution_evidence_ready")?.passed, false);
  assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "same_input_comparison_ready")?.passed, false);
  assert.equal(validateBody.validation?.decision?.reasonCode, "silent_bypass");
  assert.equal(validateBody.validation?.decision?.autoAcceptReady, false);
});

test("skill evolution proposal validate endpoint reports low-risk summary for research-like skills", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-validate-research-"));
  const builtinRoot = join(tempRoot, "skills");
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
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_validate_research", "Validate a research-like proposal");

    const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
      job_id: "job_observability_validate_research",
    }), reflectRes);
    const reflectionId = (JSON.parse(reflectRes.body) as { reflection?: { id?: string } }).reflection?.id;

    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
      reflection_id: reflectionId,
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      proposal?: { id?: string; targetFiles?: string[] };
      candidate_path?: string;
    };
    const proposalId = createBody.proposal?.id;
    const candidateManifestPath = findCandidateManifestPath(createBody);
    const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as Record<string, unknown>;
    candidateManifest.description = "Research-oriented candidate guidance with clearer evidence capture.";
    writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

    const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);

    const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/validate`, {}), validateRes);
    const validateBody = JSON.parse(validateRes.body) as {
      validation?: {
        passed?: boolean;
        risk?: {
          tier?: string;
          skillClass?: string;
          acceptanceFocus?: string;
          summary?: string;
        };
        stability?: {
          replayInstabilityDetected?: boolean;
          candidateFlakySignal?: boolean;
          autoAcceptBlocked?: boolean;
          reasons?: string[];
        };
        contract?: {
          hardGates?: Array<{
            name?: string;
            passed?: boolean;
          }>;
        };
      };
    };

    assert.equal(validateRes.statusCode, 200);
    assert.equal(validateBody.validation?.passed, true);
    assert.equal(validateBody.validation?.risk?.tier, "low");
    assert.equal(validateBody.validation?.risk?.skillClass, "research_like");
    assert.equal(validateBody.validation?.risk?.acceptanceFocus, "improvement");
    assert.equal(typeof validateBody.validation?.risk?.summary, "string");
    assert.equal(validateBody.validation?.stability?.replayInstabilityDetected, false);
    assert.equal(validateBody.validation?.stability?.candidateFlakySignal, false);
    assert.equal(validateBody.validation?.stability?.autoAcceptBlocked, false);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "risk_tier_contract")?.passed, true);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution proposal validate endpoint blocks auto-accept on low-risk flaky heuristic improvement", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-validate-flaky-lowrisk-"));
  const builtinRoot = join(tempRoot, "skills");
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
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistSkillReflectionRecord({
      id: "refl_validate_flaky_lowrisk_1",
      skillId: "find.code_symbol",
      jobId: "job_observability_validate_flaky_lowrisk",
      reflectionKind: "discovery",
      reason: "Research-like skill found a slightly better evidence path.",
      evidence: {
        verificationStatus: "insufficient",
        failedCheckNames: ["artifact_presence"],
        missingRequirements: ["symbol_hits"],
        eventIds: ["evt_validate_flaky_lowrisk_1"],
        artifactIds: ["artifact_validate_flaky_lowrisk_1"],
        silentBypassSignal: false,
      },
      recommendedAction: "append_appendix",
      createdAt: new Date().toISOString(),
    }, config.skillEvolution.candidateDir);
    persistSkillEvolutionProposal({
      id: "proposal_validate_flaky_lowrisk_1",
      skillId: "find.code_symbol",
      sourceReflectionId: "refl_validate_flaky_lowrisk_1",
      status: "validated",
      targetFiles: [
        join(config.skills.builtinDir, "find.code_symbol", "SKILL.md").replace(/\\/g, "/"),
        join(config.skills.builtinDir, "find.code_symbol", "skill.json").replace(/\\/g, "/"),
      ],
      patchSummary: "Low-risk appendix-only proposal",
      patchText: "Append a research clarification.",
      candidateDir: config.skillEvolution.candidateDir,
      createdAt: new Date().toISOString(),
    }, config.skillEvolution.candidateDir);

    const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals/proposal_validate_flaky_lowrisk_1/validate", {}), validateRes);
    const validateBody = JSON.parse(validateRes.body) as {
      proposal?: {
        status?: string;
      };
      validation?: {
        passed?: boolean;
        risk?: {
          tier?: string;
          acceptanceFocus?: string;
        };
        stability?: {
          replayInstabilityDetected?: boolean;
          candidateFlakySignal?: boolean;
          autoAcceptBlocked?: boolean;
          reasons?: string[];
        };
        contract?: {
          hardGates?: Array<{
            name?: string;
            passed?: boolean;
          }>;
        };
        replay?: {
          sameInputComparison?: {
            mode?: string;
          };
        };
        decision?: {
          autoAcceptReady?: boolean;
        };
      };
    };

    assert.equal(validateRes.statusCode, 200);
    assert.equal(validateBody.proposal?.status, "validated");
    assert.equal(validateBody.validation?.passed, true);
    assert.equal(validateBody.validation?.risk?.tier, "low");
    assert.equal(validateBody.validation?.risk?.acceptanceFocus, "improvement");
    assert.equal(validateBody.validation?.stability?.replayInstabilityDetected, true);
    assert.equal(validateBody.validation?.stability?.candidateFlakySignal, true);
    assert.equal(validateBody.validation?.stability?.autoAcceptBlocked, true);
    assert.equal(validateBody.validation?.replay?.sameInputComparison?.mode, "recorded_baseline_vs_candidate");
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "candidate_binding_ready")?.passed, true);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "execution_evidence_ready")?.passed, true);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "same_input_comparison_ready")?.passed, false);
    assert.equal(validateBody.validation?.decision?.autoAcceptReady, false);
    assert.equal(Array.isArray(validateBody.validation?.stability?.reasons), true);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution proposal validate endpoint fails when candidate changes introduce risky escalation", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-validate-risky-"));
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
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_validate_risky", "Validate candidate that escalates tool scope");
    const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
      job_id: "job_observability_validate_risky",
    }), reflectRes);
    const reflectionId = (JSON.parse(reflectRes.body) as { reflection?: { id?: string } }).reflection?.id;

    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
      reflection_id: reflectionId,
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      proposal?: {
        id?: string;
        targetFiles?: string[];
      };
      candidate_path?: string;
    };
    const proposalId = createBody.proposal?.id ?? "";
    updateSkillEvolutionProposal(proposalId, (proposal) => ({
      ...proposal,
      status: "validated",
    }), config.skillEvolution.candidateDir);

    const candidateManifestPath = findCandidateManifestPath(createBody);
    const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as {
      requiredTools?: string[];
      description?: string;
    };
    candidateManifest.requiredTools = [...(candidateManifest.requiredTools ?? []), "web_search"];
    candidateManifest.description = "Risky candidate expands tool requirements.";
    writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

    const validateRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/validate`, {}), validateRes);
    const validateBody = JSON.parse(validateRes.body) as {
      proposal?: {
        status?: string;
      };
      validation?: {
        passed?: boolean;
        contract?: {
          hardGates?: Array<{
            name?: string;
            passed?: boolean;
          }>;
        };
        comparison?: {
          candidateSelected?: boolean;
        };
        decision?: {
          reasonCode?: string;
          autoAcceptReady?: boolean;
        };
        replay?: {
          candidate?: {
            changedFiles?: string[];
          };
        };
      };
    };

    assert.equal(reflectRes.statusCode, 201);
    assert.equal(createRes.statusCode, 201);
    assert.equal(validateRes.statusCode, 200);
    assert.equal(validateBody.proposal?.status, "validation_failed");
    assert.equal(validateBody.validation?.passed, false);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "candidate_selected")?.passed, false);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "candidate_binding_ready")?.passed, false);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "execution_evidence_ready")?.passed, false);
    assert.equal(validateBody.validation?.contract?.hardGates?.find((gate) => gate.name === "same_input_comparison_ready")?.passed, false);
    assert.equal(validateBody.validation?.comparison?.candidateSelected, false);
    assert.equal(validateBody.validation?.decision?.reasonCode, "candidate_not_selected");
    assert.equal(validateBody.validation?.decision?.autoAcceptReady, false);
    assert.equal(Array.isArray(validateBody.validation?.replay?.candidate?.changedFiles), true);
    assert.equal((validateBody.validation?.replay?.candidate?.changedFiles?.length ?? 0) >= 1, true);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution proposal accept endpoint records accepted decision", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-accept-"));
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
  }, null, 2), "utf8");

  const config = buildMinimalConfig();
  config.skills.builtinDir = join(tempRoot, "skills").replace(/\\/g, "/");
  config.skillEvolution.enabled = true;
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_accept", "Accept a validated proposal");

    const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
      job_id: "job_observability_accept",
    }), reflectRes);
    const reflectionId = (JSON.parse(reflectRes.body) as { reflection?: { id?: string } }).reflection?.id;

    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
      reflection_id: reflectionId,
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      proposal?: { id?: string; targetFiles?: string[] };
      candidate_path?: string;
    };
    const proposalId = createBody.proposal?.id;

    const candidateTarget = createBody.proposal?.targetFiles?.find((target) => target.endsWith("/skill.json") || target.endsWith("\\skill.json"));
    const candidateManifestPath = join(createBody.candidate_path ?? "", candidateTarget ?? "");
    const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8")) as Record<string, unknown>;
    candidateManifest.description = "Accepted candidate skill description.";
    writeFileSync(candidateManifestPath, JSON.stringify(candidateManifest, null, 2), "utf8");

    const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);

    const acceptRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/accept`, {
      reason: "Validated on the low-risk path.",
    }), acceptRes);
    const acceptBody = JSON.parse(acceptRes.body) as {
      proposal?: {
        id?: string;
        status?: string;
        decidedAt?: string;
      };
      decision?: {
        decision?: string;
        reason?: string;
      };
      path?: string;
      applied_files?: string[];
      rollback_path?: string | null;
    };

    assert.equal(acceptRes.statusCode, 200);
    assert.equal(acceptBody.proposal?.id, proposalId);
    assert.equal(acceptBody.proposal?.status, "accepted");
    assert.equal(typeof acceptBody.proposal?.decidedAt, "string");
    assert.equal(acceptBody.decision?.decision, "accepted");
    assert.equal(acceptBody.decision?.reason, "Validated on the low-risk path.");
    assert.equal(typeof acceptBody.path, "string");
    assert.equal(Array.isArray(acceptBody.applied_files), true);
    assert.equal(acceptBody.applied_files?.some((item) => item.endsWith("skill.json")), true);
    assert.equal(typeof acceptBody.rollback_path, "string");

    const liveManifest = JSON.parse(readFileSync(join(skillDir, "skill.json"), "utf8")) as { description?: string };
    assert.equal(liveManifest.description, "Accepted candidate skill description.");
    assert.equal(typeof candidateTarget, "string");
    const rollbackManifestPath = join(String(acceptBody.rollback_path), candidateTarget!);
    assert.equal(existsSync(rollbackManifestPath), true);
    const rollbackManifest = JSON.parse(readFileSync(rollbackManifestPath, "utf8")) as { description?: string };
    assert.equal(rollbackManifest.description, "Locate repository symbols before editing.");

    const opsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest("/v1/skill-evolution/ops"), opsRes);
    const opsBody = JSON.parse(opsRes.body) as {
      object?: string;
      summary?: {
        total_proposals?: number;
        queue_count?: number;
        accepted_count?: number;
        rollback_available_count?: number;
        statuses?: Record<string, number>;
        funnel?: Record<string, number>;
        aging_buckets?: Record<string, number>;
      };
      proposal_queue?: Array<{
        id?: string;
        status?: string;
      }>;
      accepted_history?: Array<{
        id?: string;
        skill_id?: string;
        status?: string;
        rollback_guide_url?: string | null;
        decision?: {
          decision?: string;
          reason?: string | null;
          created_at?: string;
        } | null;
        rollback?: {
          proposal_id?: string;
          rollback_path?: string;
          rollback_available?: boolean;
          changed_files?: string[];
          guide?: string[];
        };
      }>;
      rollback_guides?: Array<{
        proposal_id?: string;
        skill_id?: string;
        rollback_path?: string;
        rollback_available?: boolean;
        changed_files?: string[];
        guide?: string[];
      }>;
    };
    const acceptedItem = opsBody.accepted_history?.find((item) => item.id === proposalId);
    const rollbackGuide = opsBody.rollback_guides?.find((item) => item.proposal_id === proposalId);

    assert.equal(opsRes.statusCode, 200);
    assert.equal(opsBody.object, "skill_evolution_ops");
    assert.equal((opsBody.summary?.total_proposals ?? 0) >= 1, true);
    assert.equal(opsBody.summary?.accepted_count, 1);
    assert.equal(opsBody.summary?.rollback_available_count, 1);
    assert.equal(opsBody.summary?.statuses?.accepted, 1);
    assert.equal(opsBody.summary?.funnel?.accepted, 1);
    assert.equal(typeof opsBody.summary?.queue_count, "number");
    assert.equal(typeof opsBody.summary?.aging_buckets?.under_1h, "number");
    assert.equal(opsBody.proposal_queue?.some((item) => item.id === proposalId), false);
    assert.equal(acceptedItem?.skill_id, "find.code_symbol");
    assert.equal(acceptedItem?.status, "accepted");
    assert.equal(acceptedItem?.rollback_guide_url, `/v1/skill-evolution/proposals/${proposalId}`);
    assert.equal(acceptedItem?.decision?.decision, "accepted");
    assert.equal(acceptedItem?.decision?.reason, "Validated on the low-risk path.");
    assert.equal(typeof acceptedItem?.decision?.created_at, "string");
    assert.equal(acceptedItem?.rollback?.rollback_path, acceptBody.rollback_path);
    assert.equal(acceptedItem?.rollback?.rollback_available, true);
    assert.equal(acceptedItem?.rollback?.changed_files?.some((item) => item.endsWith("skill.json")), true);
    assert.equal((acceptedItem?.rollback?.guide?.length ?? 0) >= 3, true);
    assert.equal(rollbackGuide?.skill_id, "find.code_symbol");
    assert.equal(rollbackGuide?.rollback_path, acceptBody.rollback_path);
    assert.equal(rollbackGuide?.rollback_available, true);

    const detailRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/skill-evolution/proposals/${proposalId}`), detailRes);
    const detailBody = JSON.parse(detailRes.body) as {
      ops_summary?: {
        queue_state?: string;
        funnel_stage?: string;
        next_action?: string;
        rollback_available?: boolean;
      };
      rollback_guide?: {
        proposal_id?: string;
        rollback_path?: string;
        rollback_available?: boolean;
      } | null;
    };
    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailBody.ops_summary?.queue_state, "accepted_history");
    assert.equal(detailBody.ops_summary?.funnel_stage, "accepted");
    assert.equal(detailBody.ops_summary?.next_action, "monitor_or_rollback");
    assert.equal(detailBody.ops_summary?.rollback_available, true);
    assert.equal(detailBody.rollback_guide?.proposal_id, proposalId);
    assert.equal(detailBody.rollback_guide?.rollback_path, acceptBody.rollback_path);
    assert.equal(detailBody.rollback_guide?.rollback_available, true);
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill evolution proposal accept endpoint preserves live skill files when candidate artifacts are missing", async () => {
  mkdirSync(join(process.cwd(), "runtime"), { recursive: true });
  const tempRoot = mkdtempSync(join(process.cwd(), "runtime", "dao-skill-accept-fail-"));
  const builtinRoot = join(tempRoot, "skills");
  const skillDir = join(builtinRoot, "find.code_symbol");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Original live description.",
    intents: ["coding"],
    keywords: ["fix"],
    requiredTools: ["list_files"],
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
  config.skillEvolution.candidateDir = join(tempRoot, "runtime", "skill-evolution").replace(/\\/g, "/");
  __testables.setConfigOverrideForTests(config);

  try {
    persistObservabilityJob("job_observability_accept_fail", "Accept should fail when candidate is incomplete");

    const reflectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/find.code_symbol/reflect", {
      job_id: "job_observability_accept_fail",
    }), reflectRes);
    const reflectionId = (JSON.parse(reflectRes.body) as { reflection?: { id?: string } }).reflection?.id;

    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals", {
      reflection_id: reflectionId,
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      proposal?: { id?: string; targetFiles?: string[] };
      candidate_path?: string;
    };
    const proposalId = createBody.proposal?.id;
    const candidateTarget = createBody.proposal?.targetFiles?.find((target) => target.endsWith("/skill.json") || target.endsWith("\\skill.json"));
    const candidateManifestPath = join(createBody.candidate_path ?? "", candidateTarget ?? "");
    unlinkSync(candidateManifestPath);

    const auditRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/audit`, {}), auditRes);

    const acceptRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", `/v1/skill-evolution/proposals/${proposalId}/accept`, {
      reason: "This should fail safely.",
    }), acceptRes);
    const acceptBody = JSON.parse(acceptRes.body) as {
      error?: {
        type?: string;
        message?: string;
      };
    };

    assert.equal(acceptRes.statusCode, 409);
    assert.equal(acceptBody.error?.type, "conflict_error");
    assert.equal(typeof acceptBody.error?.message, "string");
    const liveManifest = JSON.parse(readFileSync(join(skillDir, "skill.json"), "utf8")) as { description?: string };
    assert.equal(liveManifest.description, "Original live description.");
  } finally {
    __testables.setConfigOverrideForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

function relativePathFromProject(targetRoot: string): string {
  return relative(process.cwd(), targetRoot);
}

test("skill evolution proposal reject endpoint records rejected decision", async () => {
  persistSkillReflectionRecord({
    id: "refl_reject_1",
    skillId: "find.code_symbol",
    jobId: "job_observability_reject",
    reflectionKind: "skill_defect",
    reason: "The skill still failed to satisfy verification.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["symbol_hits"],
      eventIds: ["evt_reject_1"],
      artifactIds: [],
      silentBypassSignal: false,
    },
    recommendedAction: "patch_body",
    createdAt: new Date().toISOString(),
  });
  persistSkillEvolutionProposal({
    id: "proposal_reject_1",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_reject_1",
    status: "validation_failed",
    targetFiles: ["skills/find.code_symbol/skill.json"],
    patchSummary: "Proposal rejected after validation failure",
    patchText: "Keep the current procedure unchanged.",
    candidateDir: "runtime/skill-evolution",
    createdAt: new Date().toISOString(),
  });

  const rejectRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skill-evolution/proposals/proposal_reject_1/reject", {
    reason: "Candidate did not improve verification outcomes.",
  }), rejectRes);
  const rejectBody = JSON.parse(rejectRes.body) as {
    proposal?: {
      id?: string;
      status?: string;
      decidedAt?: string;
    };
    decision?: {
      decision?: string;
      reason?: string;
    };
    path?: string;
  };

  assert.equal(rejectRes.statusCode, 200);
  assert.equal(rejectBody.proposal?.id, "proposal_reject_1");
  assert.equal(rejectBody.proposal?.status, "rejected");
  assert.equal(typeof rejectBody.proposal?.decidedAt, "string");
  assert.equal(rejectBody.decision?.decision, "rejected");
  assert.equal(rejectBody.decision?.reason, "Candidate did not improve verification outcomes.");
  assert.equal(typeof rejectBody.path, "string");
});
