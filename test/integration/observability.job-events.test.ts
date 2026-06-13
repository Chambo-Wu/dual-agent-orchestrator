import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { appendEvent } from "../../src/job-event-bus.js";
import { __testables } from "../../src/index.js";
import { createUiEvent } from "../../src/workflow-ui-events.js";
import {
  MockResponse,
  buildAuthorizedRequest,
  persistObservabilityJob,
} from "../helpers/observability-helpers.js";

test("job events endpoint exposes planner skill metadata for observability consumers", async () => {
  persistObservabilityJob("job_observability_events", "Expose skill decision in planner events");
  appendEvent(createUiEvent({
    jobId: "job_observability_events",
    seq: 1,
    agent: "planner",
    phase: "decision",
    type: "planner.decision",
    title: "Planner decision recorded",
    summary: "Selected the repository discovery skill.",
    status: "running",
    meta: {
      planner_status: "workflow",
      candidate_skills: [{
        skillId: "find.code_symbol",
        score: 0.98,
        reasons: ["The request needs repository symbol discovery before editing."],
        source: "rule",
      }],
      selected_skill: "find.code_symbol",
      skill_id: "find.code_symbol",
      skill_action: "use_installed",
      skill_install_status: "installed",
      skill_reason: "The request needs repository symbol discovery before editing.",
    },
  }));

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_events/events"), res);
  const body = JSON.parse(res.body) as {
    events: Array<{
      type: string;
      meta?: Record<string, unknown>;
    }>;
  };

  const plannerEvent = body.events.find((event) => event.type === "planner.decision");
  assert.equal(res.statusCode, 200);
  assert.equal(plannerEvent?.meta?.selected_skill, "find.code_symbol");
  assert.equal(plannerEvent?.meta?.skill_action, "use_installed");
  assert.equal(plannerEvent?.meta?.skill_install_status, "installed");
  assert.deepEqual(plannerEvent?.meta?.skill_match_candidates, [{
    skillId: "find.code_symbol",
    score: 0.98,
    reasons: ["The request needs repository symbol discovery before editing."],
    source: "rule",
  }]);
});

test("job events endpoint exposes standardized skill install lifecycle events", async () => {
  persistObservabilityJob("job_observability_skill_install", "Expose skill install lifecycle in events");
  appendEvent(createUiEvent({
    jobId: "job_observability_skill_install",
    seq: 1,
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
    jobId: "job_observability_skill_install",
    seq: 2,
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
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_observability_skill_install/events"), res);
  const body = JSON.parse(res.body) as {
    events: Array<{
      type: string;
      summary?: string;
      status?: string;
      meta?: Record<string, unknown>;
    }>;
  };

  const attemptedEvent = body.events.find((event) => event.type === "system.skill_install_attempted");
  const blockedEvent = body.events.find((event) => event.type === "system.skill_install_blocked");
  assert.equal(res.statusCode, 200);
  assert.equal(attemptedEvent?.status, "running");
  assert.equal(attemptedEvent?.meta?.skill_id, "find.code_symbol");
  assert.equal(attemptedEvent?.meta?.skill_install_status, "install_required");
  assert.equal(blockedEvent?.status, "blocked");
  assert.equal(blockedEvent?.summary?.includes("Install blocked for find.code_symbol"), true);
  assert.equal(blockedEvent?.meta?.install_reason, "Skill installation requires skills.auto_install=true.");
});

