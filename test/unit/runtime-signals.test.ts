import test from "node:test";
import assert from "node:assert/strict";
import { compressJsonOutput, compressToolOutput } from "../../src/compress.js";
import { LoopDetector } from "../../src/loop-detector.js";
import { hasNonEmptyCommandArtifact, hasSuccessfulWrite, hasUsefulArtifactRead } from "../../src/orchestrator.js";
import type { ExecutorOutput } from "../../src/types.js";

test("loop detector identifies repeated missing-file failures", () => {
  const detector = new LoopDetector();
  const history: ExecutorOutput[] = [
    { status: "blocked", summary: "missing file", tool_calls_made: [], artifacts: [], raw_result: "", error: "file not available" },
    { status: "blocked", summary: "still missing file", tool_calls_made: [], artifacts: [], raw_result: "", error: "cannot proceed without input" },
  ];

  const result = detector.check(history);

  assert.equal(result.detected, true);
  assert.equal(result.type, "missing_file");
});

test("loop detector attributes repeated tool failure to the last failed tool call", () => {
  const detector = new LoopDetector();
  const history: ExecutorOutput[] = [
    {
      status: "failed",
      summary: "Fetch failed",
      tool_calls_made: [
        { tool: "web_search", arguments: { query: "DeepSeek V4" } },
        { tool: "url_fetch", arguments: { url: "https://example.com/a" } },
      ],
      artifacts: [{ type: "json", path: "/tmp/runtime/command-results/a.json", content_preview: "[]" }],
      raw_result: "",
      error: "HTTP 403: Forbidden",
      source: "native_tool",
    },
    {
      status: "failed",
      summary: "Fetch failed",
      tool_calls_made: [
        { tool: "web_search", arguments: { query: "DeepSeek V4 对比" } },
        { tool: "url_fetch", arguments: { url: "https://example.com/b" } },
      ],
      artifacts: [{ type: "json", path: "/tmp/runtime/command-results/b.json", content_preview: "[]" }],
      raw_result: "",
      error: "HTTP 403: Forbidden",
      source: "native_tool",
    },
    {
      status: "failed",
      summary: "Fetch failed",
      tool_calls_made: [
        { tool: "web_search", arguments: { query: "Qwen3 对比" } },
        { tool: "url_fetch", arguments: { url: "https://example.com/c" } },
      ],
      artifacts: [{ type: "json", path: "/tmp/runtime/command-results/c.json", content_preview: "[]" }],
      raw_result: "",
      error: "HTTP 403: Forbidden",
      source: "native_tool",
    },
  ];

  const result = detector.check(history);

  assert.equal(result.detected, true);
  assert.equal(result.type, "repeated_tool_failure");
  assert.equal(result.message, "Tool url_fetch failed 3 times in recent steps.");
});

test("artifact signal helpers distinguish command artifacts, readback, and writes", () => {
  const history: ExecutorOutput[] = [
    {
      status: "success",
      summary: "command output",
      tool_calls_made: [{ tool: "shell_command", arguments: {} }],
      artifacts: [{ type: "file", path: "/tmp/runtime/command-results/out.json", content_preview: "{\"items\":[]}" }],
      raw_result: "{\"items\":[]}",
      source: "native_tool",
    },
    {
      status: "success",
      summary: "read output",
      tool_calls_made: [{ tool: "read_file", arguments: {} }],
      artifacts: [{ type: "file", path: "/tmp/runtime/command-results/out.json", content_preview: "content" }],
      raw_result: "content",
      source: "native_tool",
    },
    {
      status: "success",
      summary: "wrote output",
      tool_calls_made: [{ tool: "write_file", arguments: {} }],
      artifacts: [{ type: "file", path: "/tmp/runtime/notes/out.md", content_preview: "ok" }],
      raw_result: "ok",
      source: "native_tool",
    },
  ];

  assert.equal(hasNonEmptyCommandArtifact(history), true);
  assert.equal(hasUsefulArtifactRead(history), true);
  assert.equal(hasSuccessfulWrite(history), true);
});

test("compression keeps short text intact and summarizes long JSON", () => {
  assert.equal(compressToolOutput("hello"), "hello");

  const compressedText = compressToolOutput("x".repeat(2000), 500);
  assert.equal(compressedText.length <= 500, true);
  assert.equal(compressedText.includes("chars omitted"), true);

  const jsonArray = JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id, text: "x".repeat(80) })));
  const compressedJson = compressJsonOutput(jsonArray, 500);
  assert.equal(compressedJson.length <= 500, true);
  assert.equal(compressedJson.includes("Array with 20 items"), true);
});
