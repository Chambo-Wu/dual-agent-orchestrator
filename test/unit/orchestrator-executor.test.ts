import test from "node:test";
import assert from "node:assert/strict";
import { __testables as orchestratorTestables } from "../../src/orchestrator.js";
import type { ModelResponse } from "../../src/types.js";
import { buildMinimalConfig, buildRoutePolicy, createFakeChatRunner, createFakeRuntimeDeps, modelResponseFromJson } from "../helpers/fake-runtime.js";

test("finalizeExecutorResult treats successful native tool calls as success even when assistant text is empty", () => {
  const executorResponse: ModelResponse = {
    content: "",
    reasoning: "",
    toolCalls: [{
      id: "call_1",
      name: "write_file",
      arguments: "{\"path\":\"out.txt\",\"content\":\"hello\"}",
    }],
    raw: { id: "resp_1" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [{ tool: "write_file", arguments: { path: "out.txt", content: "hello" } }],
    artifacts: [{ type: "file", path: "runtime/out.txt", content_preview: "hello" }],
    lastSummary: "Wrote file runtime/out.txt",
    lastRawResult: "hello",
    ok: true,
  });

  assert.equal(result.status, "success");
  assert.equal(result.summary, "Wrote file runtime/out.txt");
  assert.equal(result.error, undefined);
  assert.equal(result.source, "native_tool");
  assert.deepEqual(result.tool_calls_made, [{ tool: "write_file", arguments: { path: "out.txt", content: "hello" } }]);
  assert.deepEqual(result.artifacts, [{ type: "file", path: "runtime/out.txt", content_preview: "hello" }]);
  assert.equal(result.raw_result, "hello");
});

test("finalizeExecutorResult preserves successful native progress gathered before tool round limit", () => {
  const executorResponse: ModelResponse = {
    content: "",
    reasoning: "",
    toolCalls: [],
    raw: { id: "resp_limit" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [
      { tool: "web_search", arguments: { query: "DeepSeek V4" } },
      { tool: "url_fetch", arguments: { url: "https://www.deepseek.com/" } },
    ],
    artifacts: [
      { type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"DeepSeek\"}]" },
      { type: "file", path: "runtime/command-results/page.txt", content_preview: "DeepSeek-V4 preview release" },
    ],
    lastSummary: "Fetched https://www.deepseek.com/ (463 chars)",
    lastRawResult: "DeepSeek-V4 preview release",
    ok: true,
  });

  assert.equal(result.status, "success");
  assert.equal(result.source, "native_tool");
  assert.equal(result.error, undefined);
  assert.equal(result.summary, "Fetched https://www.deepseek.com/ (463 chars)");
  assert.equal(result.raw_result, "DeepSeek-V4 preview release");
  assert.equal(result.artifacts.length, 2);
});

test("finalizeExecutorResult marks native partial progress as partial_success when error is present", () => {
  const executorResponse: ModelResponse = {
    content: "",
    reasoning: "",
    toolCalls: [],
    raw: { id: "resp_partial" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [{ tool: "web_search", arguments: { query: "DeepSeek V4" } }],
    artifacts: [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"DeepSeek\"}]" }],
    lastSummary: "Found 3 results",
    lastRawResult: "[{\"title\":\"DeepSeek\"}]",
    lastError: "Executor exceeded tool round limit",
    ok: true,
  });

  assert.equal(result.status, "partial_success");
  assert.equal(result.source, "native_tool");
  assert.equal(result.summary, "Found 3 results");
});

test("finalizeExecutorResult preserves model-declared failure after native tool execution", () => {
  const executorResponse: ModelResponse = {
    content: JSON.stringify({
      status: "failed",
      summary: "Search results were low quality and did not establish a trustworthy answer.",
      raw_result: "Search results were dominated by irrelevant placeholder domains.",
      error: "Need better sources before continuing.",
    }),
    reasoning: "",
    toolCalls: [],
    raw: { id: "resp_failed_after_tools" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [{ tool: "web_search", arguments: { query: "example topic" } }],
    artifacts: [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"Example\"}]" }],
    lastSummary: "Found 5 results",
    lastRawResult: "[{\"title\":\"Example\"}]",
    ok: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.source, "native_tool");
  assert.equal(result.summary, "Search results were low quality and did not establish a trustworthy answer.");
  assert.equal(result.raw_result, "Search results were dominated by irrelevant placeholder domains.");
  assert.equal(result.error, "Need better sources before continuing.");
  assert.deepEqual(result.tool_calls_made, [{ tool: "web_search", arguments: { query: "example topic" } }]);
  assert.deepEqual(result.artifacts, [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"Example\"}]" }]);
});

test("assessTaskComplexity classifies simple weather lookup as direct", () => {
  const result = orchestratorTestables.assessTaskComplexity(
    "帮我查询上海未来一周的天气，然后写入本地天气预报-上海-20260525.md",
    "general",
    {
      type: "general",
      matchers: [],
      plannerInstruction: "",
      enableRanking: false,
      requireEvidenceBeforeFinal: false,
      minGroundedCandidates: 0,
      requireArtifactReadback: false,
      requireNonEmptyArtifact: false,
      preferredTools: ["web_search"],
      artifactPriority: [],
      completionChecklist: [],
      fallbackRule: "",
    },
  );

  assert.equal(result.mode, "direct");
  assert.ok(result.score >= 4);
});

test("assessTaskComplexity keeps comparison-heavy research as orchestrated", () => {
  const result = orchestratorTestables.assessTaskComplexity(
    "调研 DeepSeek、Qwen、GLM 的代码能力对比，分析优劣并生成报告",
    "research",
    {
      type: "research",
      matchers: ["research"],
      plannerInstruction: "",
      enableRanking: true,
      requireEvidenceBeforeFinal: true,
      minGroundedCandidates: 3,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
      preferredTools: ["web_search", "read_file"],
      artifactPriority: [],
      completionChecklist: [],
      fallbackRule: "",
    },
  );

  assert.equal(result.mode, "orchestrated");
  assert.ok(result.score < 4);
});

test("runPlannerStep records and degrades workflow plans during milestone A", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "workflow",
      step: "build_workflow",
      audit: {
        verdict: "approved",
        notes: "Multi-stage task benefits from a workflow plan.",
      },
      workflow_plan: {
        id: "wf_demo",
        strategy: "research_and_write",
        summary: "Collect evidence then write the result.",
        tasks: [
          {
            id: "t1",
            title: "Collect evidence",
            kind: "delegate",
            role: "worker",
            instruction: "Collect evidence with direct tools.",
            allowed_tools: ["web_search", "read_file"],
            depends_on: [],
            required: true,
          },
        ],
        finish_when: {
          mode: "all_required_tasks_completed",
        },
        replan_policy: {
          allow_runtime_replan: true,
          max_replans: 1,
        },
      },
    }),
  ]);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];

  const result = await orchestratorTestables.runPlannerStep(
    config,
    "Research a topic and prepare a report",
    [],
    0,
    routePolicy,
    1,
    undefined,
    createFakeRuntimeDeps({
      runChatCompletionDetailed: fakeChat.runner,
    }),
    {
      onEvent: (event) => {
        events.push({ type: event.type, data: event.data });
      },
    },
  );

  assert.equal(result.status, "need_executor");
  assert.equal(result.workflow_plan?.id, "wf_demo");
  assert.equal(result.executor_request?.allowed_tools.includes("web_search"), true);
  assert.equal(result.audit.notes.includes("Runtime fallback applied"), true);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "workflow.step.start",
      "workflow.plan.created",
      "workflow.plan.validated",
      "workflow.planner.decision",
    ],
  );
});
