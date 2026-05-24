import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { persistJobRecord, readJobRecord } from "../../src/job-store.js";
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

function buildAuthorizedRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
    },
  } as IncomingMessage;
}

function buildAuthorizedJsonRequest(url: string, body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(req, {
    method: "POST",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
      "content-type": "application/json",
    },
  });
  queueMicrotask(() => {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  });
  return req;
}

test("job store persists records and API returns job payload", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_job_test",
    title: "Task",
    description: "desc",
    status: "completed",
    verified: true,
    output: "done",
    attempts: 1,
    artifacts: [{ id: "artifact_job_test", type: "file", path: "runtime/test.txt", contentPreview: "done", source: "task_run" }],
  });
  const plan = createPlanRecord({
    id: "plan_job_test",
    goal: "Goal",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_api_test",
    goal: "Goal",
    mode: "task",
    status: "completed",
    verified: true,
    output: "done",
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
  });

  persistJobRecord({
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
  });

  const stored = readJobRecord(job.id);
  assert.notEqual(stored, null);
  assert.equal(stored?.job.id, job.id);

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${job.id}`), res);
  const body = JSON.parse(res.body) as { job: { id: string } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.job.id, job.id);
});

test("job artifacts endpoint returns artifact list and 404 for missing jobs", async () => {
  const jobId = "job_api_test";
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${jobId}/artifacts`), okRes);
  const okBody = JSON.parse(okRes.body) as { job_id: string; count: number; artifacts: Array<{ id: string }> };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, jobId);
  assert.equal(okBody.count > 0, true);

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/artifacts"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job steps endpoint returns task timeline with executor progress", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_steps_test",
    title: "Continue from artifact",
    description: "Worker produced a partial artifact before the model stopped.",
    status: "blocked",
    verified: false,
    output: "partial output",
    attempts: 1,
    artifacts: [{
      id: "artifact_steps_test",
      type: "json",
      path: "runtime/command-results/steps-test.json",
      contentPreview: "{\"ok\":true}",
      source: "executor",
      sourceTaskRunId: "taskrun_steps_test",
    }],
    executorHistory: [{
      status: "partial_success",
      summary: "Collected useful intermediate data.",
      tool_calls_made: [],
      artifacts: [{
        type: "json",
        path: "runtime/command-results/steps-test.json",
        content_preview: "{\"ok\":true}",
      }],
      raw_result: "partial output",
      error: "Model response was truncated.",
      source: "native_tool",
    }],
  });
  const plan = createPlanRecord({
    id: "plan_steps_test",
    goal: "Continue from partial progress",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_steps_test",
    goal: "Continue from partial progress",
    mode: "task",
    status: "blocked",
    verified: false,
    output: "partial output",
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: taskRun.artifacts });

  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${job.id}/steps`), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    count: number;
    steps: Array<{
      id: string;
      job_id: string;
      plan_id: string;
      latest_executor_status: string | null;
      executor_history: Array<{ status: string; artifacts: Array<{ path?: string }> }>;
    }>;
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, job.id);
  assert.equal(okBody.count, 1);
  assert.equal(okBody.steps[0]?.id, taskRun.id);
  assert.equal(okBody.steps[0]?.job_id, job.id);
  assert.equal(okBody.steps[0]?.plan_id, plan.id);
  assert.equal(okBody.steps[0]?.latest_executor_status, "partial_success");
  assert.equal(okBody.steps[0]?.executor_history[0]?.status, "partial_success");
  assert.equal(okBody.steps[0]?.executor_history[0]?.artifacts[0]?.path, "runtime/command-results/steps-test.json");

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/steps"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job create endpoint runs task mode through the control plane", async () => {
  __testables.setTaskExecutorForTests(async (goal, model, requirePlannerCircuit, context) => {
    assert.equal(goal, "Create a control-plane job");
    assert.equal(model, "dual-agent-orchestrator");
    assert.equal(requirePlannerCircuit, true);
    assert.equal(Boolean(context?.jobId), true);
    assert.equal(Boolean(context?.planId), true);
    assert.equal(Boolean(context?.taskRunId), true);

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Created Job Task",
      description: goal,
      status: "completed",
      verified: true,
      output: "created job done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "task",
      status: "completed",
      verified: true,
      output: "created job done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "created job done",
      logPath: "runtime/logs/create-job.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Create a control-plane job",
      mode: "task",
      model_route: "dual-agent-orchestrator",
      policy: {
        allow_network: true,
        allow_shell: true,
        approval_mode: "on_dangerous_only",
      },
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      resolved_model: string;
      log_path: string;
      step_count: number;
      job: { id: string; status: string; output: string };
      workflow: { job: { id: string } };
    };

    assert.equal(res.statusCode, 201);
    assert.equal(body.object, "job");
    assert.equal(body.resolved_model, "dual-agent-orchestrator");
    assert.equal(body.log_path, "runtime/logs/create-job.jsonl");
    assert.equal(body.step_count, 1);
    assert.equal(body.job.status, "completed");
    assert.equal(body.job.output, "created job done");
    assert.equal(body.workflow.job.id, body.job_id);
    assert.notEqual(readJobRecord(body.job_id), null);

    const invalidRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", { goal: "" }), invalidRes);
    const invalidBody = JSON.parse(invalidRes.body) as { error?: { type?: string } };
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidBody.error?.type, "invalid_request_error");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job runtime profile endpoint exposes platform and tool capabilities", async () => {
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/runtime-profile"), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    runtime_profile: {
      platform: { os: string; shell: string };
      filesystem: { workspaceRoot: string; runtimeRoot: string };
      tools: Array<{ name: string; fallbackOnly?: boolean }>;
    };
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, "job_steps_test");
  assert.equal(typeof okBody.runtime_profile.platform.os, "string");
  assert.equal(typeof okBody.runtime_profile.platform.shell, "string");
  assert.equal(Boolean(okBody.runtime_profile.filesystem.workspaceRoot), true);
  assert.equal(Boolean(okBody.runtime_profile.filesystem.runtimeRoot), true);
  assert.equal(okBody.runtime_profile.tools.some((tool) => tool.name === "read_file"), true);
  assert.equal(okBody.runtime_profile.tools.some((tool) => tool.name === "shell_command" && tool.fallbackOnly === true), true);

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/runtime-profile"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job events endpoint reconstructs job timeline from persisted state", async () => {
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    count: number;
    snapshot: null | { job_id: string; event_count: number };
    events: Array<{ type: string; jobId: string; taskRunId?: string; agent: string; status: string; meta?: Record<string, unknown> }>;
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, "job_steps_test");
  assert.equal(okBody.count, okBody.events.length);
  assert.equal(okBody.events.some((event) => event.type === "job.created"), true);
  assert.equal(okBody.events.some((event) => event.type === "plan.created"), true);
  assert.equal(okBody.events.some((event) => event.type === "step.blocked" && event.taskRunId === "taskrun_steps_test"), true);
  assert.equal(okBody.events.some((event) => event.type === "executor.partial_success" && event.taskRunId === "taskrun_steps_test"), true);
  assert.equal(okBody.events.some((event) => event.type === "artifact.created" && event.taskRunId === "taskrun_steps_test"), true);
  assert.equal(okBody.events.every((event) => typeof event.jobId === "string" && typeof event.agent === "string"), true);
  assert.equal(okBody.snapshot?.job_id, "job_steps_test");

  const cancelRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_steps_test/cancel"),
    method: "POST",
  } as IncomingMessage, cancelRes);
  assert.equal(cancelRes.statusCode, 200);

  const afterCancelRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), afterCancelRes);
  const afterCancelBody = JSON.parse(afterCancelRes.body) as { events: Array<{ type: string }> };
  assert.equal(afterCancelBody.events.some((event) => event.type === "job.cancelled"), true);

  const missingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_missing/events"), missingRes);
  const missingBody = JSON.parse(missingRes.body) as { error?: { type?: string } };

  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingBody.error?.type, "not_found_error");
});

test("job stream endpoint replays standardized timeline events and snapshot", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/stream"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(String(res.headers.get("content-type")).includes("text/event-stream"), true);
  assert.equal(res.body.includes("event: job.snapshot"), true);
  assert.equal(res.body.includes("event: job.event"), true);
  assert.equal(res.body.includes("\"type\":\"executor.partial_success\""), true);

  res.end();
});

test("job cancel endpoint updates control metadata", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_api_test/cancel"),
    method: "POST",
  } as IncomingMessage, res);
  const body = JSON.parse(res.body) as { ok: boolean; control: { cancelledAt?: string } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.control.cancelledAt, "string");
});

test("job retry endpoint creates a new stored job and links retry metadata", async () => {
  __testables.setTaskExecutorForTests(async () => {
    const taskRun = createTaskRunRecord({
      id: "taskrun_retry_new",
      title: "Retry Task",
      description: "retry desc",
      status: "completed",
      verified: true,
      output: "retry done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: "plan_retry_new",
      goal: "Goal",
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: "job_retry_new",
      goal: "Goal",
      mode: "task",
      status: "completed",
      verified: true,
      output: "retry done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "retry done",
      logPath: "runtime/logs/retry.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_api_test/retry"),
      method: "POST",
    } as IncomingMessage, res);
    const body = JSON.parse(res.body) as { ok: boolean; retried_from: string; job: { id: string }; control: { retryOf?: string } };

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.retried_from, "job_api_test");
    assert.equal(body.job.id, "job_retry_new");
    assert.equal(body.control.retryOf, "job_api_test");

    const original = readJobRecord("job_api_test");
    assert.equal(original?.control?.retriedToJobId, "job_retry_new");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job cancel endpoint interrupts an active running job", async () => {
  let activeJobId = "";
  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    activeJobId = context?.jobId ?? "";
    await new Promise<void>((resolve, reject) => {
      if (!context) {
        reject(new Error("Missing execution context"));
        return;
      }
      context.signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      }, { once: true });
    });
    throw new Error("unreachable");
  });

  try {
    const retryRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    const retryPromise = __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_api_test/retry"),
      method: "POST",
    } as IncomingMessage, retryRes);

    for (let i = 0; i < 50 && !activeJobId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(Boolean(activeJobId), true);

    const cancelRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest(`/v1/jobs/${activeJobId}/cancel`),
      method: "POST",
    } as IncomingMessage, cancelRes);
    const cancelBody = JSON.parse(cancelRes.body) as { interrupted: boolean; active: boolean; control: { cancelledAt?: string } };
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelBody.active, true);
    assert.equal(cancelBody.interrupted, true);
    assert.equal(typeof cancelBody.control.cancelledAt, "string");

    await retryPromise;
    assert.equal(retryRes.statusCode >= 400, true);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});
