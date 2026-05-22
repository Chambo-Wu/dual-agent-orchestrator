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
