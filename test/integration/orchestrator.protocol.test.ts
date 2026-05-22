import test from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../../src/orchestrator.js";
import { buildMinimalConfig, buildRoutePolicy, createFakeChatRunner, executorSuccess, modelResponseFromJson } from "../helpers/fake-runtime.js";

test("research final answer is corrected into artifact readback when command artifact exists", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "research",
    requireEvidenceBeforeFinal: true,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    minGroundedCandidates: 0,
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "final",
      step: "answer too early",
      audit: { verdict: "approved", notes: "" },
      answer: "final without readback",
    }),
    modelResponseFromJson({
      status: "final",
      step: "final after readback",
      audit: { verdict: "approved", notes: "" },
      answer: "grounded final",
    }),
  ]);

  const result = await runTask(
    config,
    "research repositories",
    routePolicy,
    undefined,
    {
      runChatCompletionDetailed: fakeChat.runner,
      runExecutorStep: async (_config, planner) => {
        assert.equal(planner.executor_request?.allowed_tools.includes("read_file"), true);
        return executorSuccess({
          status: "success",
          summary: "read artifact",
          tool_calls_made: [{ tool: "read_file", arguments: { path: "runtime/command-results/out.json" } }],
          artifacts: [{ type: "file", path: "runtime/command-results/out.json", content_preview: "candidate evidence" }],
          raw_result: "candidate evidence",
          source: "native_tool",
        });
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "grounded final");
  assert.equal(result.executorHistory.length, 1);
  assert.equal(fakeChat.calls.length, 2);
});

test("research degrades to artifact-only summary after repeated url_fetch access failures", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "research",
    requireEvidenceBeforeFinal: true,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    minGroundedCandidates: 3,
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "final",
      step: "final too early",
      audit: { verdict: "approved", notes: "" },
      answer: "premature final",
    }),
    modelResponseFromJson({
      status: "final",
      step: "final still too early",
      audit: { verdict: "approved", notes: "" },
      answer: "still premature final",
    }),
    modelResponseFromJson({
      status: "final",
      step: "final after degraded summary",
      audit: { verdict: "approved", notes: "" },
      answer: "constrained grounded final",
    }),
    modelResponseFromJson({
      status: "final",
      step: "final after artifact summary",
      audit: { verdict: "approved", notes: "" },
      answer: "constrained grounded final",
    }),
  ]);

  let executorCalls = 0;
  const result = await runTask(
    config,
    "research DeepSeek V4 and peers",
    routePolicy,
    undefined,
    {
      runChatCompletionDetailed: fakeChat.runner,
      runExecutorStep: async (_config, planner) => {
        executorCalls += 1;
        if (executorCalls === 1) {
          return executorSuccess({
            status: "failed",
            summary: "Fetch failed",
            tool_calls_made: [
              { tool: "web_search", arguments: { query: "DeepSeek V4 功能 特点 参数" } },
              { tool: "url_fetch", arguments: { url: "https://example.com/a" } },
            ],
            artifacts: [{ type: "file", path: "runtime/command-results/a.txt", content_preview: "DeepSeek V4 1.6T Pro 284B Flash 1M 上下文" }],
            raw_result: "",
            error: "HTTP 403: Forbidden",
            source: "native_tool",
          });
        }

        if (executorCalls === 2) {
          return executorSuccess({
            status: "failed",
            summary: "Fetch failed",
            tool_calls_made: [
              { tool: "web_search", arguments: { query: "Qwen3 对比" } },
              { tool: "url_fetch", arguments: { url: "https://example.com/b" } },
            ],
            artifacts: [{ type: "file", path: "runtime/command-results/b.txt", content_preview: "Qwen3 comparison summary from prior fetch" }],
            raw_result: "",
            error: "HTTP 403: Forbidden",
            source: "native_tool",
          });
        }

        assert.equal(planner.executor_request?.allowed_tools.includes("url_fetch"), false);
        assert.equal(planner.executor_request?.allowed_tools.includes("read_file"), true);
        assert.equal(planner.executor_request?.instruction.includes("Do not call web_search or url_fetch again"), true);
        return executorSuccess({
          status: "success",
          summary: "read existing evidence",
          tool_calls_made: [{ tool: "read_file", arguments: { path: "runtime/command-results/a.txt" } }],
          artifacts: [{ type: "file", path: "runtime/command-results/a.txt", content_preview: "DeepSeek V4 1.6T Pro 284B Flash 1M 上下文" }],
          raw_result: "Confirmed from existing readable artifact; comparison evidence is incomplete because source pages returned 403.",
          source: "native_tool",
        });
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "constrained grounded final");
  assert.equal(result.executorHistory.length, 3);
  assert.equal(executorCalls, 3);
});
