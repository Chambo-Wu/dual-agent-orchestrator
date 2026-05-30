import test from "node:test";
import assert from "node:assert/strict";
import { buildIntentExecutionPlan, shouldDispatchToTeam } from "../../src/intent-dispatch.ts";
import type { IntentRouteMetadata } from "../../src/types.ts";
import { buildMinimalConfig } from "../helpers/fake-runtime.js";

test("intent dispatch routes goal intent to team path", () => {
  const route: IntentRouteMetadata = {
    kind: "goal",
    reason: "matched explicit goal-mode language",
    source: "heuristic",
  };
  assert.equal(shouldDispatchToTeam(route), true);
});

test("intent dispatch keeps non-goal intents on task path", () => {
  const directAnswer: IntentRouteMetadata = {
    kind: "direct_answer",
    reason: "matched a short direct lookup request",
    source: "heuristic",
  };
  const coding: IntentRouteMetadata = {
    kind: "coding",
    reason: "matched engineering language",
    source: "heuristic",
  };
  const research: IntentRouteMetadata = {
    kind: "research",
    reason: "matched evidence-gathering language",
    source: "heuristic",
  };

  assert.equal(shouldDispatchToTeam(directAnswer), false);
  assert.equal(shouldDispatchToTeam(coding), false);
  assert.equal(shouldDispatchToTeam(research), false);
});

test("intent dispatch builds candidate and selected skill plan before runtime dispatch", () => {
  const config = buildMinimalConfig();
  const route: IntentRouteMetadata = {
    kind: "coding",
    reason: "matched engineering language",
    source: "heuristic",
  };

  const plan = buildIntentExecutionPlan(config, "Debug src/index.ts and locate the route entrypoint", route);

  assert.equal(plan.intent.kind, "coding");
  assert.equal(plan.candidateSkills.length > 0, true);
  assert.equal(plan.candidateSkills[0]?.skillId, "find.code_symbol");
  assert.equal(plan.selectedSkill?.skill_id, "find.code_symbol");
  assert.equal(plan.selectedSkill?.skill_action, "use_installed");
  assert.equal(plan.selectedSkill?.skill_install_status, "installed");
});
