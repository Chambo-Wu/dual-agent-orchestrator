import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTask } from "../../src/orchestrator.js";
import { WORKSPACE_ROOT } from "../../src/paths.js";
import { buildMinimalConfig, buildRoutePolicy, createFakeChatRunner, executorSuccess, modelResponseFromJson } from "../helpers/fake-runtime.js";

test("research final answer is corrected into artifact readback when command artifact exists", async () => {
  const config = buildMinimalConfig();
  const artifactPath = resolve(WORKSPACE_ROOT, "runtime", "command-results", "protocol-readback-out.json");
  mkdirSync(resolve(WORKSPACE_ROOT, "runtime", "command-results"), { recursive: true });
  writeFileSync(artifactPath, "{\"title\":\"candidate evidence\"}", "utf8");

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
          tool_calls_made: [{ tool: "read_file", arguments: { path: artifactPath } }],
          artifacts: [{ type: "file", path: artifactPath, content_preview: "candidate evidence" }],
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

test("research artifact readback keeps write_file when the user requested a local markdown output", async () => {
  const config = buildMinimalConfig();
  const artifactPath = resolve(WORKSPACE_ROOT, "runtime", "command-results", "protocol-readback-with-write.json");
  const outputPath = resolve(WORKSPACE_ROOT, "research-output.md");
  mkdirSync(resolve(WORKSPACE_ROOT, "runtime", "command-results"), { recursive: true });
  writeFileSync(artifactPath, "{\"title\":\"candidate evidence\"}", "utf8");

  const routePolicy = buildRoutePolicy({
    type: "research",
    requireEvidenceBeforeFinal: true,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    minGroundedCandidates: 0,
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      goal: "research multi-agent collaboration",
      status: "need_executor",
      reasoning_summary: "Gather source evidence first.",
      next_step: "search for evidence",
      audit: { verdict: "not_applicable", notes: "Need initial evidence." },
      executor_request: {
        instruction: "Use web_search to gather initial evidence for multi-agent collaboration.",
        allowed_tools: ["web_search"],
        expected_output: "Initial evidence artifacts.",
      },
    }),
    modelResponseFromJson({
      status: "final",
      step: "answer too early",
      audit: { verdict: "approved", notes: "" },
      answer: "premature final",
    }),
    modelResponseFromJson({
      status: "final",
      step: "final after readback and write",
      audit: { verdict: "approved", notes: "" },
      answer: "done",
    }),
  ]);

  let executorCalls = 0;
  const result = await runTask(
    config,
    `Research multi-agent collaboration, prepare a comparison report, and write the final markdown to local file ${outputPath}`,
    routePolicy,
    undefined,
    {
      runChatCompletionDetailed: fakeChat.runner,
      runExecutorStep: async (_config, planner) => {
        executorCalls += 1;
        if (executorCalls === 1) {
          return executorSuccess({
            status: "success",
            summary: "collected initial evidence",
            tool_calls_made: [{ tool: "web_search", arguments: { query: "multi-agent collaboration" } }],
            artifacts: [{ type: "file", path: artifactPath, content_preview: "candidate evidence" }],
            raw_result: "candidate evidence",
            source: "native_tool",
          });
        }
        assert.equal(planner.executor_request?.allowed_tools.includes("read_file"), true);
        assert.equal(planner.executor_request?.allowed_tools.includes("write_file"), true);
        assert.equal(planner.executor_request?.instruction.includes(outputPath), true);
        return executorSuccess({
          status: "success",
          summary: "read and wrote final markdown",
          tool_calls_made: [
            { tool: "read_file", arguments: { path: artifactPath } },
            { tool: "write_file", arguments: { path: outputPath, content: "# report" } },
          ],
          artifacts: [
            { type: "file", path: artifactPath, content_preview: "candidate evidence" },
            { type: "file", path: outputPath, content_preview: "# report" },
          ],
          raw_result: "# report",
          source: "native_tool",
        });
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "read and wrote final markdown");
  assert.equal(result.executorHistory.length, 2);
});

test("research artifact scoping withholds write_file when current search artifacts are low quality", async () => {
  const config = buildMinimalConfig();
  const artifactPath = resolve(WORKSPACE_ROOT, "runtime", "command-results", "protocol-low-quality-search.json");
  const outputPath = resolve(WORKSPACE_ROOT, "low-quality-research-output.md");
  mkdirSync(resolve(WORKSPACE_ROOT, "runtime", "command-results"), { recursive: true });
  writeFileSync(
    artifactPath,
    JSON.stringify([
      {
        title: "baidu.com item Multi",
        url: "https://baike.baidu.com/item/Multi/61880560",
        snippet: "Dictionary entry for the English word multi.",
      },
      {
        title: "zdic.net hans 大",
        url: "https://www.zdic.net/hans/%E5%A4%A7",
        snippet: "Dictionary entry for the Chinese character 大.",
      },
    ]),
    "utf8",
  );

  const routePolicy = buildRoutePolicy({
    type: "research",
    requireEvidenceBeforeFinal: false,
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      goal: "research large model collaboration",
      status: "need_executor",
      reasoning_summary: "Re-check current artifacts before finalizing.",
      next_step: "read existing artifacts",
      audit: { verdict: "retry", notes: "Check current evidence first." },
      executor_request: {
        instruction: "List files under runtime/command-results and read the most relevant recent non-empty search result artifact, then produce a structured evidence summary for final answering.",
        allowed_tools: ["list_files", "read_file"],
        expected_output: "A structured evidence summary for final answering.",
      },
    }),
    modelResponseFromJson({
      status: "final",
      step: "planner final after readback",
      audit: { verdict: "approved", notes: "" },
      answer: "Need better search evidence before writing the final report.",
    }),
  ]);

  let executorCalls = 0;
  const result = await runTask(
    config,
    `Research multi-agent collaboration and write the final markdown to local file ${outputPath}`,
    routePolicy,
    undefined,
    {
      runChatCompletionDetailed: fakeChat.runner,
      runExecutorStep: async (_config, planner) => {
        executorCalls += 1;
        if (executorCalls === 1) {
          assert.equal(planner.executor_request?.allowed_tools.includes("read_file"), true);
          assert.equal(planner.executor_request?.allowed_tools.includes("write_file"), false);
          assert.equal(planner.audit.notes.includes("withheld final writeback"), true);
          return executorSuccess({
            status: "success",
            summary: "read low-quality artifact only",
            tool_calls_made: [{ tool: "read_file", arguments: { path: artifactPath } }],
            artifacts: [{ type: "file", path: artifactPath, content_preview: "dictionary search results" }],
            raw_result: "Search results are low quality and not sufficient for final reporting.",
            source: "native_tool",
          });
        }

        assert.equal(planner.executor_request?.allowed_tools.includes("write_file"), true);
        return executorSuccess({
          status: "success",
          summary: `Wrote file ${outputPath}`,
          tool_calls_made: [{ tool: "write_file", arguments: { path: outputPath, content: "# retry later" } }],
          artifacts: [{ type: "file", path: outputPath, content_preview: "# retry later" }],
          raw_result: "# retry later",
          source: "native_tool",
        });
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, `Wrote file ${outputPath}`);
  assert.equal(executorCalls, 2);
});

test("research degrades to artifact-only summary after repeated url_fetch access failures", async () => {
  const config = buildMinimalConfig();
  const artifactAPath = resolve(WORKSPACE_ROOT, "runtime", "command-results", "protocol-degraded-a.txt");
  const artifactBPath = resolve(WORKSPACE_ROOT, "runtime", "command-results", "protocol-degraded-b.txt");
  mkdirSync(resolve(WORKSPACE_ROOT, "runtime", "command-results"), { recursive: true });
  writeFileSync(artifactAPath, "DeepSeek V4 comparison summary", "utf8");
  writeFileSync(artifactBPath, "Qwen3 comparison summary", "utf8");

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
    "research DeepSeek V4 and peers, then prepare a comparison report",
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
              { tool: "web_search", arguments: { query: "DeepSeek V4 features" } },
              { tool: "url_fetch", arguments: { url: "https://example.com/a" } },
            ],
            artifacts: [{ type: "file", path: artifactAPath, content_preview: "DeepSeek V4 comparison summary" }],
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
              { tool: "web_search", arguments: { query: "Qwen3 comparison" } },
              { tool: "url_fetch", arguments: { url: "https://example.com/b" } },
            ],
            artifacts: [{ type: "file", path: artifactBPath, content_preview: "Qwen3 comparison summary from prior fetch" }],
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
          tool_calls_made: [{ tool: "read_file", arguments: { path: artifactAPath } }],
          artifacts: [{ type: "file", path: artifactAPath, content_preview: "DeepSeek V4 comparison summary" }],
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

test("final answer claiming a local markdown write is corrected into a required write_file step", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "research",
    requireEvidenceBeforeFinal: false,
  });
  const outputPath = "D:\\Android\\dual-agent-orchestrator\\domestic-model-report.md";
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "final",
      step: "write final report",
      audit: { verdict: "approved", notes: "" },
      answer: `Already wrote report: ${outputPath}`,
    }),
  ]);

  let executorCalls = 0;
  const result = await runTask(
    config,
    `Summarize mimo v2.5 pro and write local file ${outputPath}`,
    routePolicy,
    undefined,
    {
      runChatCompletionDetailed: fakeChat.runner,
      runExecutorStep: async (_config, planner) => {
        executorCalls += 1;
        assert.equal(planner.executor_request?.allowed_tools.includes("write_file"), true);
        assert.equal(planner.executor_request?.instruction.includes(outputPath), true);
        return executorSuccess({
          status: "success",
          summary: `Wrote file ${outputPath}`,
          tool_calls_made: [{
            tool: "write_file",
            arguments: {
              path: outputPath,
              content: "# report\n\ncontent",
            },
          }],
          artifacts: [{
            type: "file",
            path: outputPath,
            content_preview: "# report\n\ncontent",
          }],
          raw_result: "# report\n\ncontent",
          source: "native_tool",
        });
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, `Wrote file ${outputPath}`);
  assert.equal(result.executorHistory.length, 1);
  assert.equal(executorCalls, 1);
  assert.equal(fakeChat.calls.length, 1);
});
