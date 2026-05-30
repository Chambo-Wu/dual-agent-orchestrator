import test from "node:test";
import assert from "node:assert/strict";
import { detectIntentRouteHeuristics } from "../../src/intent-router.ts";

test("intent router detects explicit goal mode requests", () => {
  const result = detectIntentRouteHeuristics("/goal 为这个项目创建多轮任务计划");
  assert.equal(result.kind, "goal");
});

test("intent router detects coding-oriented requests", () => {
  const result = detectIntentRouteHeuristics("Fix the failing TypeScript test in src/index.ts and update the API response");
  assert.equal(result.kind, "coding");
});

test("intent router detects short direct lookup requests", () => {
  const result = detectIntentRouteHeuristics("What is the weather in Seattle today?");
  assert.equal(result.kind, "direct_answer");
});

test("intent router detects research-style requests", () => {
  const result = detectIntentRouteHeuristics("Compare the latest official LangGraph and CrewAI releases with sources");
  assert.equal(result.kind, "research");
});
