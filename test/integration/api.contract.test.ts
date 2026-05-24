import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { __testables } from "../../src/index.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, number | string | string[]>();
  body = "";

  setHeader(name: string, value: number | string | string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  write(chunk: unknown): boolean {
    this.body += String(chunk);
    return true;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) {
      this.body += String(chunk);
    }
    this.emit("finish");
    return this;
  }
}

function buildAuthorizedJsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(req, {
    method: "POST",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
      "content-type": "application/json",
      ...headers,
    },
  });
  queueMicrotask(() => {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  });
  return req;
}

test("v1 routes require API authorization", async () => {
  const req = {
    method: "GET",
    url: "/v1/models",
    headers: {},
  } as IncomingMessage;
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;

  await __testables.handleRequest(req, res);

  const body = JSON.parse(res.body) as { error?: { type?: string } };
  assert.equal(res.statusCode, 401);
  assert.equal(body.error?.type, "authentication_error");
});

test("chat completions stream omits workflow SSE events by default", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_stream_contract",
    title: "Primary Task",
    description: "Say hello",
    status: "completed",
    verified: true,
    output: "Hello from stream.",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_stream_contract",
    goal: "Say hello",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_stream_contract",
    goal: "Say hello",
    mode: "task",
    status: "completed",
    verified: true,
    output: "Hello from stream.",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  __testables.setTaskExecutorForTests(async () => ({
    content: "Hello from stream.",
    logPath: "runtime/logs/test.jsonl",
    resolvedModel: "dual-agent-orchestrator",
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  }));

  try {
    const req = buildAuthorizedJsonRequest("/v1/chat/completions", {
      model: "dual-agent-orchestrator",
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    });
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;

    await __testables.handleRequest(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes("event: workflow."), false);
    assert.equal(res.body.includes("\"type\":\"workflow.step.start\""), false);
    assert.equal(res.body.includes("\"choices\":"), true);
    assert.equal(res.body.includes("data: [DONE]"), true);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("chat completions stream mirrors planner and executor progress into text deltas", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_stream_progress",
    title: "Primary Task",
    description: "Research progress",
    status: "completed",
    verified: true,
    output: "Final synthesized answer.",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_stream_progress",
    goal: "Research progress",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_stream_progress",
    goal: "Research progress",
    mode: "task",
    status: "completed",
    verified: true,
    output: "Final synthesized answer.",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    context?.emitEvent?.({
      type: "workflow.step.start",
      step: 1,
      data: { replan_count: 0 },
    });
    context?.emitEvent?.({
      type: "workflow.planner.decision",
      step: 1,
      data: {
        status: "need_executor",
        reasoning_summary: "Gather evidence from the web before writing the final summary.",
        next_step: "Run web search",
        verdict: "not_applicable",
      },
    });
    context?.emitEvent?.({
      type: "workflow.executor.result",
      step: 1,
      data: {
        status: "success",
        summary: "Collected 3 useful artifacts.",
        artifact_count: 3,
      },
    });
    return {
      content: "Final synthesized answer.",
      logPath: "runtime/logs/test-progress.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const req = buildAuthorizedJsonRequest("/v1/chat/completions", {
      model: "dual-agent-orchestrator",
      stream: true,
      messages: [{ role: "user", content: "Show me progress" }],
    });
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;

    await __testables.handleRequest(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes("\"content\":\"[Progress] \""), true);
    assert.equal(res.body.includes("\"content\":\"Planner \""), true);
    assert.equal(res.body.includes("\"content\":\"started \""), true);
    assert.equal(res.body.includes("\"content\":\"Executor \""), true);
    assert.equal(res.body.includes("\"content\":\"result: \""), true);
    assert.equal(res.body.includes("\"content\":\"artifacts.\""), true);
    assert.equal(res.body.includes("[Final Answer]"), true);
    assert.equal(res.body.includes("\"content\":\"Final \""), true);
    assert.equal(res.body.includes("\"content\":\"synthesized \""), true);
    assert.equal(res.body.includes("\"content\":\"answer.\""), true);
    assert.equal(res.body.includes("event: workflow."), false);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});
