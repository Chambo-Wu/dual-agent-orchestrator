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
    config.modelRegistry["executor.default"] = {
      id: "executor.default",
      role: "executor",
      enabled: true,
      model: {
        ...config.modelRegistry["executor.default"]!.model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
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

test("runExecutorStep rotates to the next healthy executor when the first candidate fails to write", async () => {
  const callsByModel = new Map<string, number>();
  let backupIssuedToolCall = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("multi-agent evidence");
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const parsed = JSON.parse(body) as { model?: string };
    const model = parsed.model ?? "unknown";
    callsByModel.set(model, (callsByModel.get(model) ?? 0) + 1);

    const response = model === "executor-primary"
      ? {
          choices: [{
            message: {
              content: JSON.stringify({
                status: "failed",
                summary: "Executor returned malformed output. Retry or switch the model.",
                tool_calls_made: [],
                artifacts: [],
                raw_result: "",
                error: "Unable to parse executor output as JSON. The model may have returned mixed text and JSON.",
              }),
            },
          }],
        }
      : !backupIssuedToolCall
        ? (() => {
            backupIssuedToolCall = true;
            return {
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "call_write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({ path: "runtime/rotated-success.md", content: "ok" }),
                    },
                  }],
                },
              }],
            };
          })()
        : {
            choices: [{
              message: {
                content: JSON.stringify({
                  status: "success",
                  summary: "file written",
                  tool_calls_made: [],
                  artifacts: [],
                  raw_result: "ok",
                  error: "",
                }),
              },
            }],
          };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);

  try {
    const config = buildMinimalConfig();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.executor = {
      ...config.executor,
      baseUrl,
      model: "executor-primary",
    };
    config.modelRegistry["executor.default"] = {
      id: "executor.default",
      role: "executor",
      enabled: true,
      model: {
        ...config.executor,
        baseUrl,
        model: "executor-primary",
      },
    };
    config.modelRegistry.executor_backup = {
      id: "executor_backup",
      role: "executor",
      enabled: true,
      model: {
        ...config.executor,
        baseUrl,
        model: "executor-backup",
      },
    };
    config.modelRouting.executorCandidates = ["executor.default", "executor_backup"];

    const result = await runExecutorStep(
      config,
      plannerNeedExecutor({
        instruction: "Write the file",
        allowed_tools: ["write_file"],
        expected_output: "file written",
      }),
      1,
    );

    assert.equal(result.status, "success");
    assert.deepEqual(result.tool_calls_made.map((call) => call.tool), ["write_file"]);
    assert.equal(callsByModel.get("executor-primary"), 1);
    assert.equal(callsByModel.get("executor-backup"), 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("runExecutorStep lazily warms search candidates and reuses the healthy subset afterward", async () => {
  const callsByModel = new Map<string, number>();
  let serverPort = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url === "/page") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("multi-agent evidence");
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const parsed = JSON.parse(body) as { model?: string };
    const model = parsed.model ?? "unknown";
    callsByModel.set(model, (callsByModel.get(model) ?? 0) + 1);
    const callNumber = callsByModel.get(model) ?? 0;

    let response;
    if (model === "executor-primary") {
      response = {
        choices: [{
          message: {
            content: "{not-json",
          },
        }],
      };
    } else if (callNumber === 1) {
      response = {
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_fetch",
              type: "function",
              function: {
                name: "url_fetch",
                arguments: JSON.stringify({ url: `http://127.0.0.1:${serverPort}/page`, max_chars: 200 }),
              },
            }],
          },
        }],
      };
    } else if (callNumber === 2) {
      response = {
        choices: [{
          message: {
            content: JSON.stringify({
              status: "success",
              summary: "search evidence gathered",
              tool_calls_made: [],
              artifacts: [],
              raw_result: "search evidence",
              error: "",
            }),
          },
        }],
      };
    } else if (callNumber === 3) {
      response = {
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "runtime/lazy-warmup.md", content: "ok" }),
              },
            }],
          },
        }],
      };
    } else {
      response = {
        choices: [{
          message: {
            content: JSON.stringify({
              status: "success",
              summary: "file written",
              tool_calls_made: [],
              artifacts: [],
              raw_result: "ok",
              error: "",
            }),
          },
        }],
      };
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  serverPort = address.port;

  try {
    const config = buildMinimalConfig();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.executor = {
      ...config.executor,
      baseUrl,
      model: "executor-primary",
    };
    config.modelRegistry["executor.default"] = {
      id: "executor.default",
      role: "executor",
      enabled: true,
      model: {
        ...config.executor,
        baseUrl,
        model: "executor-primary",
      },
    };
    config.modelRegistry.executor_backup = {
      id: "executor_backup",
      role: "executor",
      enabled: true,
      model: {
        ...config.executor,
        baseUrl,
        model: "executor-backup",
      },
    };
    config.modelRouting.executorCandidates = ["executor.default", "executor_backup"];

    const options = {
      executorSelectionState: {},
    };

    const warmupResult = await runExecutorStep(
      config,
      plannerNeedExecutor({
        instruction: "Search for multi-agent collaboration examples",
        allowed_tools: ["url_fetch"],
        expected_output: "search evidence",
      }),
      1,
      undefined,
      undefined,
      options,
    );

    assert.equal(warmupResult.status, "success");
    assert.deepEqual(options.executorSelectionState.selectedCandidateIds, ["executor_backup"]);
    assert.equal(callsByModel.get("executor-primary"), 1);
    assert.equal(callsByModel.get("executor-backup"), 2);

    const writeResult = await runExecutorStep(
      config,
      plannerNeedExecutor({
        instruction: "Write the warmed summary",
        allowed_tools: ["write_file"],
        expected_output: "done",
      }),
      2,
      undefined,
      undefined,
      options,
    );

    assert.equal(writeResult.status, "success");
    assert.deepEqual(writeResult.tool_calls_made.map((call) => call.tool), ["write_file"]);
    assert.equal(callsByModel.get("executor-primary"), 1);
    assert.equal(callsByModel.get("executor-backup"), 4);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
