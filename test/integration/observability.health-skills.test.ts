import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { updateJobControlState } from "../../src/job-store.js";
import { appendEvent } from "../../src/job-event-bus.js";
import { __testables } from "../../src/index.js";
import { RUNTIME_ROOT } from "../../src/paths.js";
import {
  persistSkillEvolutionProposal,
  persistSkillReflectionRecord,
} from "../../src/skill-evolution-store.js";
import { createUiEvent } from "../../src/workflow-ui-events.js";
import {
  buildMinimalConfig,
  MockResponse,
  buildAuthorizedRequest,
  buildAuthorizedJsonRequest,
  persistObservabilityJob,
} from "../helpers/observability-helpers.js";

test("health payload exposes installed skill observability summary", () => {
  const health = __testables.buildHealthResponse(buildMinimalConfig()) as {
    skills?: {
      enabled?: boolean;
      builtin_count?: number;
      explicit_install_count?: number;
      installed_count?: number;
      installed?: Array<{
        skill_id?: string;
        install_status?: string;
        explicit_install?: boolean;
      }>;
    };
  };

  assert.equal(health.skills?.enabled, true);
  assert.equal((health.skills?.builtin_count ?? 0) >= 2, true);
  assert.equal(health.skills?.explicit_install_count, 0);
  assert.equal((health.skills?.installed_count ?? 0) >= 2, true);
  assert.equal(health.skills?.installed?.some((skill) => skill.skill_id === "find.code_symbol" && skill.install_status === "installed"), true);
  assert.equal(health.skills?.installed?.some((skill) => skill.skill_id === "find.official_sources" && skill.install_status === "installed"), true);
  assert.equal(health.skills?.installed?.some((skill) => skill.skill_id === "find.code_symbol" && skill.explicit_install === false), true);
});

test("skills list endpoint exposes install control metadata", async () => {
  rmSync(join(RUNTIME_ROOT, "skills"), { recursive: true, force: true });
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/skills"), res);
  const body = JSON.parse(res.body) as {
    data: Array<{
      skill_id?: string;
      install_status?: string;
      auto_install_eligible?: boolean;
      explicit_install?: boolean;
    }>;
  };

  const item = body.data.find((entry) => entry.skill_id === "find.code_symbol");
  assert.equal(res.statusCode, 200);
  assert.equal(item?.install_status, "builtin_available");
  assert.equal(item?.auto_install_eligible, false);
  assert.equal(item?.explicit_install, false);
});

test("skills install endpoint records explicit installs", async () => {
  const defaultConfig = buildMinimalConfig();
  try {
    rmSync(join(RUNTIME_ROOT, "skills"), { recursive: true, force: true });
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("POST", "/v1/skills/install", {
      skill_id: "find.code_symbol",
    }), res);
    const body = JSON.parse(res.body) as {
      skill_id?: string;
      status?: string;
      record?: {
        id?: string;
      } | null;
    };

    assert.equal(res.statusCode, 200);
    assert.equal(body.skill_id, "find.code_symbol");
    assert.equal(body.status, "installed");
    assert.equal(body.record?.id, "find.code_symbol");

    const health = __testables.buildHealthResponse() as {
      skills?: {
        explicit_install_count?: number;
        installed?: Array<{
          skill_id?: string;
          explicit_install?: boolean;
        }>;
      };
    };
    assert.equal(health.skills?.explicit_install_count, 1);
    assert.equal(health.skills?.installed?.some((skill) => skill.skill_id === "find.code_symbol" && skill.explicit_install === true), true);
  } finally {
    rmSync(defaultConfig.skills.installDir, { recursive: true, force: true });
    rmSync(join(RUNTIME_ROOT, "skills"), { recursive: true, force: true });
  }
});

test("job list endpoint returns selected skill for dashboard consumers", async () => {
  persistObservabilityJob("job_observability_list", "Show skill metadata in dashboard data");
  updateJobControlState("job_observability_list", {
    recoveredAt: "2026-05-29T08:00:00.000Z",
    recoveryReason: "service_restart",
    autoResumeStatus: "failed",
    autoResumeFailedAt: "2026-05-29T08:00:10.000Z",
    autoResumeFailureMessage: "planner unavailable",
  });

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs"), res);
  const body = JSON.parse(res.body) as {
    data: Array<{
      id: string;
      candidate_skills?: Array<{
        skillId?: string;
      }>;
      selected_skill?: {
        skill_id?: string;
        skill_install_status?: string;
      } | null;
    }>;
  };

  const item = body.data.find((entry) => entry.id === "job_observability_list");
  assert.equal(res.statusCode, 200);
  assert.equal(item?.candidate_skills?.[0]?.skillId, "find.code_symbol");
  assert.equal(item?.selected_skill?.skill_id, "find.code_symbol");
  assert.equal(item?.selected_skill?.skill_install_status, "installed");
});

test("jobs dashboard endpoints render selected skill metadata", async () => {
  persistObservabilityJob("job_observability_dashboard", "Render selected skill in dashboard html");

  const listRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs"), listRes);
  const listBody = JSON.parse(listRes.body) as {
    data: Array<{
      id: string;
      workflow_summary?: {
        skill_verification?: {
          title?: string;
          verification_status?: string;
          verification_label?: string;
          action_required?: boolean;
        } | null;
        skill_reflection?: {
          reflectionKind?: string;
          recommendedAction?: string;
        } | null;
      } | null;
    }>;
  };
  const listItem = listBody.data.find((entry) => entry.id === "job_observability_dashboard");

  const apiRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/dashboard"), apiRes);
  assert.equal(listItem?.workflow_summary?.skill_verification?.title, "Verify Code Symbol Discovery");
  assert.equal(listItem?.workflow_summary?.skill_verification?.verification_status, "verified");
  assert.equal(listItem?.workflow_summary?.skill_verification?.verification_label, "Verified");
  assert.equal(listItem?.workflow_summary?.skill_verification?.action_required, false);
  assert.equal(listItem?.workflow_summary?.skill_reflection?.reflectionKind, "discovery");
  assert.equal(listItem?.workflow_summary?.skill_reflection?.recommendedAction, "append_appendix");
  assert.equal(apiRes.statusCode, 200);
  assert.equal(apiRes.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(apiRes.body.includes("Job Dashboard"), true);
  assert.equal(apiRes.body.includes("Skill: "), true);
  assert.equal(apiRes.body.includes("find.code_symbol"), false);
  assert.equal(apiRes.body.includes("Skill candidates"), true);

  const browserDataRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/jobs/data?q=job_observability_dashboard&page=1&page_size=50"), browserDataRes);
  const browserDataBody = JSON.parse(browserDataRes.body) as {
    data: Array<{
      id: string;
      selected_skill?: { skill_id?: string };
      workflow_summary?: {
        skill_verification?: { verification_status?: string };
      } | null;
    }>;
    pagination: { page_size: number; total: number };
  };
  const browserDataItem = browserDataBody.data.find((entry) => entry.id === "job_observability_dashboard");
  assert.equal(browserDataRes.statusCode, 200);
  assert.equal(browserDataBody.pagination.page_size, 50);
  assert.equal(browserDataBody.pagination.total, 1);
  assert.equal(browserDataItem?.selected_skill?.skill_id, "find.code_symbol");
  assert.equal(browserDataItem?.workflow_summary?.skill_verification?.verification_status, "verified");

  const browserRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    method: "GET",
    url: "/jobs/dashboard",
    headers: {},
  } as IncomingMessage, browserRes);
  assert.equal(browserRes.statusCode, 200);
  assert.equal(browserRes.body.includes("new URL('/jobs/data', window.location.origin)"), true);
});

test("job workflow summary scopes skill evolution proposals to the current job reflection lineage", async () => {
  persistObservabilityJob("job_observability_evolution_scope_a", "Show only this job's proposal lineage");
  persistObservabilityJob("job_observability_evolution_scope_b", "Do not leak another job's proposal lineage");

  persistSkillReflectionRecord({
    id: "refl_scope_a",
    skillId: "find.code_symbol",
    jobId: "job_observability_evolution_scope_a",
    reflectionKind: "skill_defect",
    reason: "Job A reflection.",
    evidence: {
      verificationStatus: "insufficient",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["file_excerpt"],
      eventIds: ["evt_scope_a"],
      artifactIds: ["artifact_scope_a"],
      silentBypassSignal: false,
    },
    recommendedAction: "patch_body",
    createdAt: "2026-05-29T08:00:00.000Z",
  });
  persistSkillReflectionRecord({
    id: "refl_scope_b",
    skillId: "find.code_symbol",
    jobId: "job_observability_evolution_scope_b",
    reflectionKind: "execution_lapse",
    reason: "Job B reflection.",
    evidence: {
      verificationStatus: "failed",
      failedCheckNames: ["artifact_presence"],
      missingRequirements: ["symbol_hits"],
      eventIds: ["evt_scope_b"],
      artifactIds: ["artifact_scope_b"],
      silentBypassSignal: true,
    },
    recommendedAction: "append_appendix",
    createdAt: "2026-05-29T09:00:00.000Z",
  });

  persistSkillEvolutionProposal({
    id: "proposal_scope_a",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_scope_a",
    status: "validated",
    targetFiles: ["skills/find.code_symbol/SKILL.md", "skills/find.code_symbol/skill.json"],
    controlPlaneSummary: {
      title: "find.code_symbol: skill_defect",
      changeHeadline: "Job A change headline",
      rationaleHeadline: "Job A rationale",
      changedFiles: ["skills/find.code_symbol/SKILL.md"],
    },
    patchSummary: "Job A summary",
    patchText: "Job A patch",
    candidateDir: "runtime/skill-evolution",
    createdAt: "2026-05-29T10:00:00.000Z",
  });
  persistSkillEvolutionProposal({
    id: "proposal_scope_b",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_scope_b",
    status: "accepted",
    controlPlaneSummary: {
      title: "find.code_symbol: execution_lapse",
      changeHeadline: "Job B change headline",
      rationaleHeadline: "Job B rationale",
      changedFiles: ["skills/find.code_symbol/SKILL.md"],
    },
    targetFiles: ["skills/find.code_symbol/SKILL.md", "skills/find.code_symbol/skill.json"],
    patchSummary: "Job B summary",
    patchText: "Job B patch",
    candidateDir: "runtime/skill-evolution",
    createdAt: "2026-05-29T11:00:00.000Z",
  });

  const listRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs"), listRes);
  const listBody = JSON.parse(listRes.body) as {
    data?: Array<{
      id?: string;
      workflow_summary?: {
        skill_evolution?: {
          latest_proposal_id?: string;
          latest_status?: string;
          latest_change_summary?: string;
        } | null;
      } | null;
    }>;
  };

  const jobA = listBody.data?.find((entry) => entry.id === "job_observability_evolution_scope_a");
  const jobB = listBody.data?.find((entry) => entry.id === "job_observability_evolution_scope_b");
  assert.equal(listRes.statusCode, 200);
  assert.equal(jobA?.workflow_summary?.skill_evolution?.latest_proposal_id, "proposal_scope_a");
  assert.equal(jobA?.workflow_summary?.skill_evolution?.latest_status, "validated");
  assert.equal(jobA?.workflow_summary?.skill_evolution?.latest_change_summary, "Job A change headline");
  assert.equal(jobB?.workflow_summary?.skill_evolution?.latest_proposal_id, "proposal_scope_b");
  assert.equal(jobB?.workflow_summary?.skill_evolution?.latest_status, "accepted");
  assert.equal(jobB?.workflow_summary?.skill_evolution?.latest_change_summary, "Job B change headline");
});

test("timeline endpoint renders selected skill metadata", async () => {
  persistObservabilityJob("job_observability_timeline", "Render selected skill in timeline");
  appendEvent(createUiEvent({
    jobId: "job_observability_timeline",
    seq: 3,
    agent: "system",
    phase: "decision",
    type: "system.skill_install_attempted",
    title: "Skill install attempted",
    summary: "Attempting to install find.code_symbol.",
    status: "running",
    meta: {
      skill_id: "find.code_symbol",
      skill_install_status: "install_required",
      install_reason: "Skill installation requires skills.auto_install=true.",
      install_source: "builtin",
      install_location: "skills/find.code_symbol",
    },
  }));
  appendEvent(createUiEvent({
    jobId: "job_observability_timeline",
    seq: 4,
    agent: "system",
    phase: "retry",
    type: "system.skill_install_blocked",
    title: "Skill install blocked",
    summary: "Install blocked for find.code_symbol. Skill installation requires skills.auto_install=true.",
    status: "blocked",
    meta: {
      skill_id: "find.code_symbol",
      skill_install_status: "blocked",
      install_reason: "Skill installation requires skills.auto_install=true.",
      install_source: "builtin",
      install_location: "skills/find.code_symbol",
      failure_category: "policy_blocked",
    },
  }));

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    method: "GET",
    url: "/jobs/job_observability_timeline/timeline",
    headers: {},
  } as IncomingMessage, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.body.includes("Workflow Timeline"), true);
  assert.equal(res.body.includes("Skill: find.code_symbol"), true);
  assert.equal(res.body.includes("Skill reason:"), true);
  assert.equal(res.body.includes("Skill candidates: find.code_symbol"), true);
  assert.equal(res.body.includes("Skill install activity"), true);
  assert.equal(res.body.includes("Install events"), true);
  assert.equal(res.body.includes("event-skill-install"), true);
  assert.equal(res.body.includes("skill install"), true);
  assert.equal(res.body.includes("Skill verification: Verify Code Symbol Discovery (Verified) - Skill verification satisfied."), true);
  assert.equal(res.body.includes("Skill reflection: optimization"), true);
});

test("skill reflections endpoint lists persisted reflections for a skill", async () => {
  persistObservabilityJob("job_observability_reflections", "Persist reflection records");
  const recordModule = await import("../../src/job-store.js");
  const record = recordModule.readJobRecord("job_observability_reflections");
  assert.equal(Boolean(record), true);
  const config = buildMinimalConfig();
  config.skillEvolution.enabled = true;
  config.skillEvolution.autoReflect = true;
  config.skillEvolution.candidateDir = "runtime/skill-evolution";
  __testables.persistSkillReflectionForRecord(record!, config);

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/skills/find.code_symbol/reflections"), res);
  const body = JSON.parse(res.body) as {
    skill_id?: string;
    count?: number;
    data?: Array<{
      skillId?: string;
      jobId?: string;
      reflectionKind?: string;
      recommendedAction?: string;
    }>;
  };

  assert.equal(res.statusCode, 200);
  assert.equal(body.skill_id, "find.code_symbol");
  assert.equal((body.count ?? 0) >= 1, true);
  assert.equal(body.data?.some((entry) => entry.skillId === "find.code_symbol" && entry.jobId === "job_observability_reflections"), true);
  assert.equal(typeof body.data?.[0]?.reflectionKind, "string");
  assert.equal(typeof body.data?.[0]?.recommendedAction, "string");
});
