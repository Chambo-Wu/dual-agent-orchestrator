import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { RunCancelledError, runExecutorStep, runTask } from "../../src/orchestrator.js";
import { buildMinimalConfig, buildRoutePolicy, createFakeRuntimeDeps, executorSuccess, fakeRunTaskResult, plannerFinal, plannerNeedExecutor } from "../helpers/fake-runtime.js";

test("runTask completes immediately when fake planner returns final", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();

  const result = await runTask(
    config,
    "Summarize this task",
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runPlannerStep: async () => plannerFinal("done"),
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "done");
  assert.equal(result.verified, true);
  assert.equal(result.executorHistory.length, 0);
});

test("runTask stops before planning when abort signal is already cancelled", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const controller = new AbortController();
  controller.abort(new RunCancelledError("cancelled before planning"));

  await assert.rejects(
    () => runTask(
      config,
      "Cancelled task",
      routePolicy,
      undefined,
      createFakeRuntimeDeps({
        runPlannerStep: async () => plannerFinal("should not run"),
      }),
      { abortSignal: controller.signal },
    ),
    /cancelled before planning/,
  );
});

test("runTask uses fake executor step after planner requests execution", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();

  let plannerCalls = 0;
  const result = await runTask(
    config,
    "Write a file",
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runPlannerStep: async () => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return plannerNeedExecutor({
            instruction: "do one thing",
            allowed_tools: ["write_file"],
            expected_output: "done",
          });
        }
        return plannerFinal("completed after executor");
      },
      runExecutorStep: async () => executorSuccess({
        status: "success",
        summary: "executor ok",
        raw_result: "executor-result",
      }),
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "completed after executor");
  assert.equal(result.executorHistory.length, 1);
  assert.equal(result.executorHistory[0]?.summary, "executor ok");
});

test("runExecutorStep enforces executor tool policy against native tool calls", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "call_write",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "runtime/blocked.txt", content: "blocked" }),
            },
          }],
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);

  try {
    const config = buildMinimalConfig();
    config.executor = {
      ...config.executor,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    config.executorToolPolicy = {
      allow: ["read_file"],
      deny: ["write_file"],
    };

    const result = await runExecutorStep(
      config,
      plannerNeedExecutor({
        instruction: "Try to write a file",
        allowed_tools: ["read_file", "write_file"],
        expected_output: "done",
      }),
      1,
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error, "Tool write_file is not allowed for this step");
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.tool_calls_made.map((call) => call.tool), ["write_file"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
