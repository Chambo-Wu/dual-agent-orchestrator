import test from "node:test";
import assert from "node:assert/strict";
import { RunCancelledError, runTask } from "../../src/orchestrator.js";
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
