import test from "node:test";
import assert from "node:assert/strict";
import { resolveResearchRoutePolicy } from "../../src/research-runtime.ts";
import type { OrchestratorConfig } from "../../src/types.ts";

function buildConfig(): OrchestratorConfig {
  return {
    planner: {
      provider: "openai_compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "planner",
      model: "planner-model",
      timeoutMs: 120000,
      maxTokens: 4096,
      temperature: 0.2,
    },
    executor: {
      provider: "openai_compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "executor",
      model: "executor-model",
      timeoutMs: 60000,
      maxTokens: 2048,
      temperature: 0,
    },
    modelRegistry: {},
    modelRouting: {
      plannerCandidates: ["planner.default"],
      executorCandidates: ["executor.default"],
    },
    policy: {
      maxSteps: 6,
      maxReplans: 2,
      maxToolRetries: 2,
      plannerHistoryMaxEntries: 3,
      plannerHistoryPreviewChars: 120,
      maxRepeatedExecutorRequests: 2,
      autoResumeConcurrency: 3,
    },
    taskRoutingPath: "config/task-routing.yml",
  };
}

test("research runtime keeps research prompts on a research-capable route", () => {
  const policy = resolveResearchRoutePolicy(buildConfig(), "Compare the latest official LangGraph and CrewAI releases with sources");
  assert.equal(["fact_research", "research", "web_search"].includes(policy.type), true);
  assert.equal(policy.requireEvidenceBeforeFinal, true);
  assert.equal(policy.plannerInstruction.includes("Additional research runtime contract"), true);
});

test("research runtime coerces non-research prompts to research default when dispatched explicitly", () => {
  const policy = resolveResearchRoutePolicy(buildConfig(), "Tell me something broad and open-ended");
  assert.equal(policy.type, "research");
  assert.equal(policy.completionChecklist.includes("separate confirmed evidence from remaining uncertainty"), true);
});
