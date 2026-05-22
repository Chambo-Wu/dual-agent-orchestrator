import test from "node:test";
import assert from "node:assert/strict";
import { __testables as orchestratorTestables } from "../../src/orchestrator.js";
import type { ModelResponse } from "../../src/types.js";

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
