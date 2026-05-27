import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { persistJobRecord, readJobRecord, updateStoredJobRecord } from "../../src/job-store.js";
import { __testables } from "../../src/index.js";
import { registerActiveJobSession, unregisterActiveJobSession, resolvePendingApproval } from "../../src/job-runtime.js";
import { buildMinimalConfig } from "../helpers/fake-runtime.js";
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

test("team agent resolution uses config registry by default and env as override", () => {
  const config = buildMinimalConfig();
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
    },
    writer: {
      id: "writer",
      role: "write",
      model: {
        ...config.executor,
        model: "writer-model",
      },
    },
  };

  assert.deepEqual(__testables.resolveTeamAgents(config, undefined), [
    { name: "researcher", role: "research" },
    { name: "writer", role: "write" },
  ]);
  assert.deepEqual(__testables.resolveTeamAgents(config, JSON.stringify([{ name: "env_agent", role: "override" }])), [
    { name: "env_agent", role: "override" },
  ]);
});

test("registered role agent resolution exposes verifier routing metadata", () => {
  const config = buildMinimalConfig();
  config.agents = {
    qa_agent: {
      id: "qa_agent",
      role: "team verifier",
      model: {
        ...config.executor,
        model: "verifier-model",
      },
    },
  };

  assert.deepEqual(__testables.resolveRegisteredRoleAgent(config, "verifier"), {
    id: "qa_agent",
    role: "team verifier",
    model: "verifier-model",
  });
});

test("team approval gate persists ApprovalRequest and resolves through job runtime", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_team_gate_root",
    title: "Team Gate Root",
    description: "Root task",
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_team_gate",
    goal: "Approve team subtask",
    mode: "team",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_team_gate",
    goal: "Approve team subtask",
    mode: "team",
    status: "running",
    verified: false,
    output: "Running...",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });
  persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
  const controller = new AbortController();
  registerActiveJobSession("job_team_gate", "Approve team subtask", controller);

  try {
    const gatePromise = __testables.createTeamApprovalGate("job_team_gate")([{
      id: "task_team_review",
      title: "Review before execution",
      description: "Needs approval",
      status: "awaiting_approval",
      assignee: "reviewer",
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    const pendingRecord = readJobRecord("job_team_gate");
    assert.equal(pendingRecord?.approvalRequests?.length, 1);
    assert.equal(pendingRecord?.approvalRequests?.[0]?.taskIds[0], "task_team_review");
    assert.equal(pendingRecord?.control?.approvalStatus, "pending");

    assert.equal(resolvePendingApproval("job_team_gate", "approved"), true);
    assert.equal(await gatePromise, true);
  } finally {
    unregisterActiveJobSession("job_team_gate");
  }
});

test("team approval mode requires async job creation", async () => {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
    goal: "Run a gated team job",
    mode: "team",
    policy: {
      approval_mode: "always",
    },
  }), res);
  const body = JSON.parse(res.body) as { error: { message: string; type: string } };

  assert.equal(res.statusCode, 400);
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.message.includes("policy.async=true"), true);
});

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

test("job create endpoint supports async start for realtime clients", async () => {
  __testables.setTaskExecutorForTests(async (goal, model, requirePlannerCircuit, context) => {
    assert.equal(goal, "Create an async control-plane job");
    assert.equal(model, "dual-agent-orchestrator");
    assert.equal(requirePlannerCircuit, true);
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
        reasoning_summary: "Search first, then summarize.",
        next_step: "Run web search",
        verdict: "not_applicable",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Async Job Task",
      description: goal,
      status: "completed",
      verified: true,
      output: "async job done",
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
      output: "async job done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    return {
      content: "async job done",
      logPath: "runtime/logs/create-job-async.jsonl",
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
      goal: "Create an async control-plane job",
      mode: "task",
      model_route: "dual-agent-orchestrator",
      policy: {
        async: true,
      },
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      status: string;
      accepted: boolean;
      stream_url: string;
      events_url: string;
      timeline_url: string;
      job: { id: string; status: string };
    };

    assert.equal(res.statusCode, 202);
    assert.equal(body.object, "job");
    assert.equal(body.accepted, true);
    assert.equal(body.job.status, "running");
    assert.equal(body.stream_url, `/v1/jobs/${body.job_id}/stream`);
    assert.equal(body.events_url, `/v1/jobs/${body.job_id}/events`);
    assert.equal(body.timeline_url, `/v1/jobs/${body.job_id}/timeline`);

    const streamRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(body.stream_url), streamRes);
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.body.includes("event: job.snapshot"), true);
    assert.equal(streamRes.body.includes("\"type\":\"job.created\""), true);
    streamRes.end();

    let completedRecord = readJobRecord(body.job_id);
    for (let i = 0; i < 30 && completedRecord?.job.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completedRecord = readJobRecord(body.job_id);
    }

    assert.equal(completedRecord?.job.status, "completed");

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(body.events_url), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      events: Array<{ type: string }>;
    };
    assert.equal(eventsBody.events.some((event) => event.type === "planner.start"), true);
    assert.equal(eventsBody.events.some((event) => event.type === "planner.decision"), true);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job create endpoint supports team mode with the same control-plane contract", async () => {
  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Coordinate a researcher and writer");
    assert.equal(model, "dual-agent-orchestrator");
    context?.emitEvent?.({
      type: "workflow.step.start",
      step: 1,
      data: { replan_count: 0 },
    });
    context?.emitEvent?.({
      type: "workflow.planner.decision",
      step: 1,
      data: {
        status: "workflow",
        reasoning_summary: "Split research and writing across the team.",
        next_step: "Dispatch team tasks",
        verdict: "approved",
      },
    });

    const researchTask = createTaskRunRecord({
      id: "taskrun_team_research",
      title: "Research",
      description: "Inspect source material",
      status: "completed",
      assignee: "researcher",
      verified: true,
      output: "research done",
      attempts: 1,
      artifacts: [],
    });
    const writeTask = createTaskRunRecord({
      id: "taskrun_team_write",
      title: "Write",
      description: "Produce summary",
      status: "completed",
      assignee: "writer",
      dependsOn: [researchTask.id],
      verified: true,
      output: "write done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [researchTask.id, writeTask.id],
      summary: "Team plan with 2 task runs.",
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team job done",
      plan,
      taskRuns: [researchTask, writeTask],
      artifacts: [],
      memorySummary: "shared context",
    });
    persistJobRecord({
      job,
      plan,
      taskRuns: [researchTask, writeTask],
      artifacts: [],
    });
    return {
      content: "team job done",
      logPath: "runtime/logs/create-team-job.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [researchTask, writeTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Coordinate a researcher and writer",
      mode: "team",
      model_route: "dual-agent-orchestrator",
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      job: { id: string; mode: string; status: string };
      plan: { mode: string };
      step_count: number;
    };

    assert.equal(res.statusCode, 201);
    assert.equal(body.object, "job");
    assert.equal(body.job.id, body.job_id);
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.plan.mode, "team");
    assert.equal(body.step_count, 2);
    assert.notEqual(readJobRecord(body.job_id), null);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${body.job_id}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as { events: Array<{ type: string; agent: string; status: string }> };
    const verificationEvent = eventsBody.events.find((event) => event.type === "system.verification_passed");
    assert.equal(Boolean(verificationEvent), true);
    assert.equal(verificationEvent?.agent, "system");
    assert.equal(verificationEvent?.status, "success");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("team job create endpoint applies shared verifier result", async () => {
  __testables.setTeamExecutorForTests(async (goal, _model, context) => {
    const teamTask = createTaskRunRecord({
      id: "taskrun_team_verifier_failure",
      title: "Tool-backed team task",
      description: goal,
      status: "completed",
      assignee: "researcher",
      verified: true,
      output: "tool completed without artifacts",
      attempts: 1,
      artifacts: [],
      executorHistory: [{
        status: "success",
        summary: "tool ok",
        tool_calls_made: [{ tool: "read_file", arguments: { path: "missing.txt" } }],
        artifacts: [],
        raw_result: "tool ok",
      }],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [teamTask.id],
      summary: "Team verifier failure plan.",
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team verifier failure",
      plan,
      taskRuns: [teamTask],
      artifacts: [],
    });
    return {
      content: "team verifier failure",
      logPath: "runtime/logs/create-team-job-verifier-failure.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [teamTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Run a team job with verifier failure",
      mode: "team",
      model_route: "dual-agent-orchestrator",
    }), res);
    const body = JSON.parse(res.body) as {
      job_id: string;
      job: { mode: string; status: string; verified: boolean };
    };

    assert.equal(res.statusCode, 201);
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.job.verified, false);

    const record = readJobRecord(body.job_id);
    assert.equal(record?.job.verified, false);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedRequest(`/v1/jobs/${body.job_id}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as { events: Array<{ type: string; status: string }> };
    const verificationEvent = eventsBody.events.find((event) => event.type === "system.verification_failed");
    assert.equal(Boolean(verificationEvent), true);
    assert.equal(verificationEvent?.status, "blocked");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job create endpoint supports async team mode", async () => {
  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Run an async team job");
    assert.equal(model, "dual-agent-orchestrator");
    context?.emitEvent?.({
      type: "workflow.step.start",
      step: 1,
      data: { replan_count: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const teamTask = createTaskRunRecord({
      id: "taskrun_async_team_root",
      title: "Team Root Task",
      description: goal,
      status: "completed",
      assignee: "planner",
      verified: true,
      output: "async team done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [teamTask.id],
      summary: "Async team plan.",
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "async team done",
      plan,
      taskRuns: [teamTask],
      artifacts: [],
      memorySummary: "async team memory",
    });
    return {
      content: "async team done",
      logPath: "runtime/logs/create-team-job-async.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [teamTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs", {
      goal: "Run an async team job",
      mode: "team",
      model_route: "dual-agent-orchestrator",
      policy: {
        async: true,
      },
    }), res);
    const body = JSON.parse(res.body) as {
      object: string;
      job_id: string;
      accepted: boolean;
      job: { mode: string; status: string };
    };

    assert.equal(res.statusCode, 202);
    assert.equal(body.object, "job");
    assert.equal(body.accepted, true);
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "running");

    let completedRecord = readJobRecord(body.job_id);
    for (let i = 0; i < 30 && completedRecord?.job.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completedRecord = readJobRecord(body.job_id);
    }

    assert.equal(completedRecord?.job.mode, "team");
    assert.equal(completedRecord?.job.status, "completed");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job runtime profile endpoint exposes platform and tool capabilities", async () => {
  const okRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/runtime-profile"), okRes);
  const okBody = JSON.parse(okRes.body) as {
    job_id: string;
    diagnostics_summary: {
      dependency_warnings: number;
      dependency_checks: number;
    };
    runtime_profile: {
      platform: { os: string; shell: string };
      filesystem: { workspaceRoot: string; runtimeRoot: string };
      diagnostics: {
        dependencyChecks: Array<{ name: string; status: string }>;
      };
      tools: Array<{ name: string; fallbackOnly?: boolean }>;
    };
  };

  assert.equal(okRes.statusCode, 200);
  assert.equal(okBody.job_id, "job_steps_test");
  assert.equal(typeof okBody.runtime_profile.platform.os, "string");
  assert.equal(typeof okBody.runtime_profile.platform.shell, "string");
  assert.equal(Boolean(okBody.runtime_profile.filesystem.workspaceRoot), true);
  assert.equal(Boolean(okBody.runtime_profile.filesystem.runtimeRoot), true);
  assert.equal(typeof okBody.diagnostics_summary.dependency_warnings, "number");
  assert.equal(typeof okBody.diagnostics_summary.dependency_checks, "number");
  assert.equal(okBody.runtime_profile.diagnostics.dependencyChecks.length > 0, true);
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
    snapshot: null | {
      job_id: string;
      event_count: number;
      replay?: { next_seq?: number; can_resume_from?: number };
    };
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
  assert.equal(typeof okBody.snapshot?.replay?.next_seq, "number");
  assert.equal(typeof okBody.snapshot?.replay?.can_resume_from, "number");

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
  assert.equal(res.body.includes("\"replayed_count\""), true);
  assert.equal(res.body.includes("id: "), true);

  res.end();
});

test("job stream supports since_seq replay and Last-Event-ID resume", async () => {
  const allEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), allEventsRes);
  const allEventsBody = JSON.parse(allEventsRes.body) as {
    events: Array<{ seq: number; type: string }>;
  };
  const cursor = allEventsBody.events.find((event) => event.type === "plan.created")?.seq ?? 0;

  const sinceSeqRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest(`/v1/jobs/job_steps_test/stream?since_seq=${cursor}`),
  } as IncomingMessage, sinceSeqRes);

  assert.equal(sinceSeqRes.statusCode, 200);
  assert.equal(sinceSeqRes.body.includes(`"resumed_from_seq":${cursor}`), true);
  assert.equal(sinceSeqRes.body.includes('"replayed_count"'), true);
  assert.equal(sinceSeqRes.body.includes('"type":"job.created"'), false);

  sinceSeqRes.end();

  const lastEventIdRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest({
    ...buildAuthorizedRequest("/v1/jobs/job_steps_test/stream"),
    headers: {
      authorization: "Bearer dual-agent-local",
      "last-event-id": String(cursor),
    },
  } as IncomingMessage, lastEventIdRes);

  assert.equal(lastEventIdRes.statusCode, 200);
  assert.equal(lastEventIdRes.body.includes(`"resumed_from_seq":${cursor}`), true);
  assert.equal(lastEventIdRes.body.includes('"type":"job.created"'), false);

  lastEventIdRes.end();
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

test("job retry endpoint preserves team mode", async () => {
  const teamTask = createTaskRunRecord({
    id: "taskrun_team_retry_source",
    title: "Team Retry Source",
    description: "retry team desc",
    status: "failed",
    assignee: "planner",
    verified: false,
    output: "team retry source failed",
    attempts: 1,
    artifacts: [],
  });
  const teamPlan = createPlanRecord({
    id: "plan_team_retry_source",
    goal: "Retry this team job",
    mode: "team",
    taskRunIds: [teamTask.id],
    summary: "Team retry source plan.",
  });
  const teamJob = createJobRecord({
    id: "job_team_retry_source",
    goal: "Retry this team job",
    mode: "team",
    status: "failed",
    verified: false,
    output: "team retry source failed",
    plan: teamPlan,
    taskRuns: [teamTask],
    artifacts: [],
    memorySummary: "team retry source memory",
  });
  persistJobRecord({
    job: teamJob,
    plan: teamPlan,
    taskRuns: [teamTask],
    artifacts: [],
  });

  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Retry this team job");
    assert.equal(model, undefined);
    const retriedTask = createTaskRunRecord({
      id: "taskrun_team_retry_new",
      title: "Retried Team Task",
      description: "retried team desc",
      status: "completed",
      assignee: "planner",
      verified: true,
      output: "team retry done",
      attempts: 1,
      artifacts: [],
    });
    const retriedPlan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [retriedTask.id],
      summary: "Retried team plan.",
    });
    const retriedJob = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team retry done",
      plan: retriedPlan,
      taskRuns: [retriedTask],
      artifacts: [],
      memorySummary: "team retry memory",
    });
    return {
      content: "team retry done",
      logPath: "runtime/logs/team-retry.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job: retriedJob,
      plan: retriedPlan,
      taskRuns: [retriedTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_team_retry_source/retry"),
      method: "POST",
    } as IncomingMessage, res);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      retried_from: string;
      job: { id: string; mode: string; status: string };
      control: { retryOf?: string };
    };

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.retried_from, "job_team_retry_source");
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.control.retryOf, "job_team_retry_source");
  } finally {
    __testables.setTeamExecutorForTests(null);
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

test("job approve endpoint resolves pending approval and records lifecycle metadata", async () => {
  const approvalTask = createTaskRunRecord({
    id: "taskrun_approval_api",
    title: "Approval Gate",
    description: "Wait for reviewer approval",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    attempts: 0,
    artifacts: [],
  });
  const approvalPlan = createPlanRecord({
    id: "plan_approval_api",
    goal: "Approval workflow",
    mode: "task",
    taskRunIds: [approvalTask.id],
    summary: "Approval workflow plan.",
  });
  const approvalJob = createJobRecord({
    id: "job_approval_api",
    goal: "Approval workflow",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  persistJobRecord({
    job: approvalJob,
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  updateStoredJobRecord("job_approval_api", (record) => ({
    ...record,
    approvalRequests: [{
      id: "appr_api_1",
      jobId: "job_approval_api",
      taskIds: [approvalTask.id],
      reason: "Approve the workflow",
      status: "pending",
      createdAt: new Date().toISOString(),
    }],
    control: {
      pendingApprovalId: "appr_api_1",
      approvalStatus: "pending",
    },
  }));

  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/jobs/job_approval_api/approve", {
    approval_id: "appr_api_1",
    decision: "approved",
    note: "looks good",
  }), res);
  const body = JSON.parse(res.body) as {
    ok: boolean;
    approval_id: string;
    decision: string;
    signaled: boolean;
    control: { approvalStatus?: string; pendingApprovalId?: string };
  };

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.approval_id, "appr_api_1");
  assert.equal(body.decision, "approved");
  assert.equal(body.signaled, false);
  assert.equal(body.control.approvalStatus, "approved");
  assert.equal(body.control.pendingApprovalId, undefined);

  const updated = readJobRecord("job_approval_api");
  assert.equal(updated?.approvalRequests?.[0]?.status, "approved");
  assert.equal(updated?.approvalRequests?.[0]?.responseNote, "looks good");

  const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_approval_api/events"), eventsRes);
  const eventsBody = JSON.parse(eventsRes.body) as {
    events: Array<{ type: string; meta?: Record<string, unknown> }>;
  };
  const approvalEvent = eventsBody.events.find((event) => event.type === "approval.approved");
  assert.equal(Boolean(approvalEvent), true);
  assert.equal(approvalEvent?.meta?.approval_id, "appr_api_1");
});

test("job resume endpoint creates a resumed job and blocks awaiting approval jobs", async () => {
  const blockedTask = createTaskRunRecord({
    id: "taskrun_resume_source",
    title: "Blocked Task",
    description: "Needs later resume",
    status: "blocked",
    verified: false,
    output: "blocked output",
    attempts: 1,
    artifacts: [],
  });
  const blockedPlan = createPlanRecord({
    id: "plan_resume_source",
    goal: "Resume me",
    mode: "task",
    taskRunIds: [blockedTask.id],
  });
  const blockedJob = createJobRecord({
    id: "job_resume_source",
    goal: "Resume me",
    mode: "task",
    status: "blocked",
    verified: false,
    output: "blocked output",
    plan: blockedPlan,
    taskRuns: [blockedTask],
    artifacts: [],
  });
  persistJobRecord({
    job: blockedJob,
    plan: blockedPlan,
    taskRuns: [blockedTask],
    artifacts: [],
  });

  const approvalTask = createTaskRunRecord({
    id: "taskrun_resume_waiting",
    title: "Approval Wait",
    description: "Should not resume directly",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    attempts: 0,
    artifacts: [],
  });
  const approvalPlan = createPlanRecord({
    id: "plan_resume_waiting",
    goal: "Await approval first",
    mode: "task",
    taskRunIds: [approvalTask.id],
  });
  const approvalJob = createJobRecord({
    id: "job_resume_waiting",
    goal: "Await approval first",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  persistJobRecord({
    job: approvalJob,
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  updateStoredJobRecord("job_resume_waiting", (record) => ({
    ...record,
    control: {
      ...record.control,
      pendingApprovalId: "appr_resume_waiting",
      approvalStatus: "pending",
    },
    approvalRequests: [{
      id: "appr_resume_waiting",
      jobId: "job_resume_waiting",
      taskIds: [approvalTask.id],
      reason: "Approve before resume",
      status: "pending",
      createdAt: new Date().toISOString(),
    }],
  }));

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Resumed Task",
      description: "resumed desc",
      status: "completed",
      verified: true,
      output: "resumed done",
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal: "Resume me",
      mode: "task",
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal: "Resume me",
      mode: "task",
      status: "completed",
      verified: true,
      output: "resumed done",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    persistJobRecord({ job, plan, taskRuns: [taskRun], artifacts: [] });
    return {
      content: "resumed done",
      logPath: "runtime/logs/resume.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const resumeRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_resume_source/resume"),
      method: "POST",
    } as IncomingMessage, resumeRes);
    const resumeBody = JSON.parse(resumeRes.body) as {
      ok: boolean;
      resumed_from: string;
      job: { id: string };
      control: { resumeOf?: string };
    };

    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeBody.ok, true);
    assert.equal(resumeBody.resumed_from, "job_resume_source");
    assert.equal(resumeBody.control.resumeOf, "job_resume_source");

    const sourceRecord = readJobRecord("job_resume_source");
    assert.equal(sourceRecord?.control?.resumedToJobId, resumeBody.job.id);
    assert.equal(typeof sourceRecord?.control?.resumedAt, "string");

    const resumedRecord = readJobRecord(resumeBody.job.id);
    assert.equal(resumedRecord?.control?.resumeOf, "job_resume_source");

    const waitingRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_resume_waiting/resume"),
      method: "POST",
    } as IncomingMessage, waitingRes);
    const waitingBody = JSON.parse(waitingRes.body) as { error?: { type?: string; message?: string } };

    assert.equal(waitingRes.statusCode, 409);
    assert.equal(waitingBody.error?.type, "conflict_error");
    assert.equal(waitingBody.error?.message?.includes("/approve"), true);
    assert.equal(waitingBody.error?.failure_category, "approval_blocked");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("job resume endpoint preserves team mode", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_team_resume_source",
    title: "Team Resume Source",
    description: "Needs team resume",
    status: "blocked",
    assignee: "planner",
    verified: false,
    output: "team resume source blocked",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_team_resume_source",
    goal: "Resume this team job",
    mode: "team",
    taskRunIds: [taskRun.id],
    summary: "Team resume source plan.",
  });
  const job = createJobRecord({
    id: "job_team_resume_source",
    goal: "Resume this team job",
    mode: "team",
    status: "blocked",
    verified: false,
    output: "team resume source blocked",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
    memorySummary: "team resume source memory",
  });
  persistJobRecord({
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  __testables.setTeamExecutorForTests(async (goal, model, context) => {
    assert.equal(goal, "Resume this team job");
    assert.equal(model, undefined);
    const resumedTask = createTaskRunRecord({
      id: "taskrun_team_resume_new",
      title: "Resumed Team Task",
      description: "resumed team desc",
      status: "completed",
      assignee: "planner",
      verified: true,
      output: "team resumed done",
      attempts: 1,
      artifacts: [],
    });
    const resumedPlan = createPlanRecord({
      id: context?.planId,
      goal,
      mode: "team",
      taskRunIds: [resumedTask.id],
      summary: "Resumed team plan.",
    });
    const resumedJob = createJobRecord({
      id: context?.jobId,
      goal,
      mode: "team",
      status: "completed",
      verified: true,
      output: "team resumed done",
      plan: resumedPlan,
      taskRuns: [resumedTask],
      artifacts: [],
      memorySummary: "team resumed memory",
    });
    return {
      content: "team resumed done",
      logPath: "runtime/logs/team-resume.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job: resumedJob,
      plan: resumedPlan,
      taskRuns: [resumedTask],
      artifacts: [],
    };
  });

  try {
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest({
      ...buildAuthorizedRequest("/v1/jobs/job_team_resume_source/resume"),
      method: "POST",
    } as IncomingMessage, res);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      resumed_from: string;
      job: { id: string; mode: string; status: string };
      control: { resumeOf?: string };
    };

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.resumed_from, "job_team_resume_source");
    assert.equal(body.job.mode, "team");
    assert.equal(body.job.status, "completed");
    assert.equal(body.control.resumeOf, "job_team_resume_source");
  } finally {
    __testables.setTeamExecutorForTests(null);
  }
});

test("job events snapshot summarizes failure categories for diagnostics", async () => {
  const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_steps_test/events"), eventsRes);
  const body = JSON.parse(eventsRes.body) as {
    snapshot?: {
      failure_summary?: {
        total?: number;
        by_category?: Record<string, number>;
        latest_category?: string | null;
      };
    };
  };

  assert.equal(eventsRes.statusCode, 200);
  assert.equal((body.snapshot?.failure_summary?.total ?? 0) > 0, true);
  assert.equal(Object.keys(body.snapshot?.failure_summary?.by_category ?? {}).length > 0, true);
  assert.equal(typeof body.snapshot?.failure_summary?.latest_category, "string");
});

test("restart recovery marks interrupted running jobs as recoverable and preserves approval jobs", async () => {
  const runningTask = createTaskRunRecord({
    id: "taskrun_restart_running",
    title: "Interrupted Task",
    description: "Was running before restart",
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const runningPlan = createPlanRecord({
    id: "plan_restart_running",
    goal: "Recover me after restart",
    mode: "task",
    taskRunIds: [runningTask.id],
  });
  const runningJob = createJobRecord({
    id: "job_restart_running",
    goal: "Recover me after restart",
    mode: "task",
    status: "running",
    verified: false,
    output: "Running...",
    plan: runningPlan,
    taskRuns: [runningTask],
    artifacts: [],
  });
  persistJobRecord({
    job: runningJob,
    plan: runningPlan,
    taskRuns: [runningTask],
    artifacts: [],
  });

  const approvalTask = createTaskRunRecord({
    id: "taskrun_restart_approval",
    title: "Approval Task",
    description: "Still waiting for approval",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    attempts: 0,
    artifacts: [],
  });
  const approvalPlan = createPlanRecord({
    id: "plan_restart_approval",
    goal: "Wait for approval across restart",
    mode: "task",
    taskRunIds: [approvalTask.id],
  });
  const approvalJob = createJobRecord({
    id: "job_restart_approval",
    goal: "Wait for approval across restart",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });
  persistJobRecord({
    job: approvalJob,
    plan: approvalPlan,
    taskRuns: [approvalTask],
    artifacts: [],
  });

  const recoveredIds = __testables.recoverInterruptedJobs();
  assert.equal(recoveredIds.includes("job_restart_running"), true);
  assert.equal(recoveredIds.includes("job_restart_approval"), false);

  const recoveredRecord = readJobRecord("job_restart_running");
  assert.equal(recoveredRecord?.job.status, "blocked");
  assert.equal(recoveredRecord?.job.output.includes("service restart"), true);
  assert.equal(recoveredRecord?.control?.recoveryReason, "service_restart");
  assert.equal(typeof recoveredRecord?.control?.recoveredAt, "string");
  assert.equal(recoveredRecord?.taskRuns[0]?.status, "blocked");

  const approvalRecord = readJobRecord("job_restart_approval");
  assert.equal(approvalRecord?.job.status, "awaiting_approval");
  assert.equal(approvalRecord?.taskRuns[0]?.status, "awaiting_approval");

  const recoveredJobRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_restart_running"), recoveredJobRes);
  const recoveredJobBody = JSON.parse(recoveredJobRes.body) as {
    job: { status: string };
    control: { recoveryReason?: string; recoveredAt?: string };
  };
  assert.equal(recoveredJobRes.statusCode, 200);
  assert.equal(recoveredJobBody.job.status, "blocked");
  assert.equal(recoveredJobBody.control.recoveryReason, "service_restart");
  assert.equal(typeof recoveredJobBody.control.recoveredAt, "string");

  const recoveredEventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedRequest("/v1/jobs/job_restart_running/events"), recoveredEventsRes);
  const recoveredEventsBody = JSON.parse(recoveredEventsRes.body) as {
    snapshot?: {
      recovery?: {
        status?: string;
        reason?: string;
        affected_task_run_ids?: string[];
      } | null;
    };
    events: Array<{ type: string; meta?: Record<string, unknown> }>;
  };
  const recoveredEvent = recoveredEventsBody.events.find((event) => event.type === "job.recovered");
  assert.equal(Boolean(recoveredEvent), true);
  assert.equal(recoveredEvent?.meta?.recovery_reason, "service_restart");
  assert.equal(recoveredEvent?.meta?.recoverable, true);
  assert.deepEqual(recoveredEvent?.meta?.affected_task_run_ids, ["taskrun_restart_running"]);
  assert.equal(recoveredEventsBody.snapshot?.recovery?.status, "recovered");
  assert.equal(recoveredEventsBody.snapshot?.recovery?.reason, "service_restart");
  assert.deepEqual(recoveredEventsBody.snapshot?.recovery?.affected_task_run_ids, ["taskrun_restart_running"]);
});

test("doctor report exposes runtime diagnostics and writable checks", () => {
  const report = __testables.buildDoctorReport() as {
    ok: boolean;
    generated_at: string;
    config_path: string;
    summary: {
      passed: number;
      failed: number;
      total: number;
    };
    recommendations: Array<{
      category: string;
      severity: string;
      message: string;
      suggested_action: string;
      related_checks: string[];
    }>;
    checks: Array<{
      name: string;
      ok: boolean;
      summary: string;
      detail?: Record<string, unknown>;
    }>;
  };

  assert.equal(typeof report.ok, "boolean");
  assert.equal(typeof report.generated_at, "string");
  assert.equal(typeof report.config_path, "string");
  assert.equal(typeof report.summary?.passed, "number");
  assert.equal(typeof report.summary?.failed, "number");
  assert.equal(typeof report.summary?.total, "number");
  assert.equal(Array.isArray(report.recommendations), true);
  assert.equal(Array.isArray(report.checks), true);
  assert.equal(report.checks.some((check) => check.name === "config_load" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "planner_model_config" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "executor_model_config" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "runtime_profile" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "task_routing_summary" && check.ok), true);
  assert.equal(report.checks.some((check) => check.name === "workspace_writable"), true);
  assert.equal(report.checks.some((check) => check.name === "runtime_writable"), true);
  assert.equal(report.checks.some((check) => check.name === "proxy_health"), true);
  assert.equal(report.checks.some((check) => check.name === "search_provider_readiness"), true);
  assert.equal(report.summary.total, report.checks.length);
  assert.equal(report.recommendations.length > 0, true);
  assert.equal(typeof report.recommendations[0]?.suggested_action, "string");
});
