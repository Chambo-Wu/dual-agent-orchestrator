import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { __testables } from "../../src/index.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";
import { readGoal } from "../../src/goal-store.js";

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

function buildAuthorizedGetRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
    },
  } as IncomingMessage;
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

test("goal API supports create, list, get, and run-next", async () => {
  __testables.setTaskExecutorForTests(async (goal, model, requirePlannerCircuit, context) => {
    assert.equal(goal, "Inspect repository status");
    assert.equal(model, undefined);
    assert.equal(requirePlannerCircuit, true);
    assert.equal(Boolean(context?.jobId), true);

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Goal task execution",
      description: goal,
      status: "completed",
      verified: true,
      output: "Repository status inspected.",
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
      output: "Repository status inspected.",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    return {
      content: "Repository status inspected.",
      logPath: "runtime/logs/goal-run-next.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/goals", {
      goal: "Implement goal mode v1",
      tasks: [
        {
          title: "Inspect repository status",
          description: "Inspect repository status",
          mode: "task",
        },
      ],
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      goal: { id: string; goal: string; status: string; tasks: Array<{ id: string; status: string }> };
      links: { self: string; run_next: string };
      files: { goal_json: string; input_md: string; plan_md: string; tasks_md: string };
    };

    assert.equal(createRes.statusCode, 201);
    assert.equal(createBody.goal.goal, "Implement goal mode v1");
    assert.equal(createBody.goal.status, "ready");
    assert.equal(createBody.goal.tasks.length, 1);
    assert.equal(createBody.links.self, `/v1/goals/${createBody.goal.id}`);

    const storedGoal = readGoal(createBody.goal.id);
    assert.notEqual(storedGoal, null);
    assert.equal(storedGoal?.tasks.length, 1);
    assert.equal(existsSync(`runtime/goals/${createBody.goal.id}/goal.json`), true);
    assert.equal(existsSync(`runtime/goals/${createBody.goal.id}/input.md`), true);
    assert.equal(existsSync(`runtime/goals/${createBody.goal.id}/plan.md`), true);
    assert.equal(existsSync(`runtime/goals/${createBody.goal.id}/tasks.md`), true);

    const listRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest("/v1/goals"), listRes);
    const listBody = JSON.parse(listRes.body) as {
      object: string;
      data: Array<{ id: string; goal: string; status: string }>;
    };
    assert.equal(listRes.statusCode, 200);
    assert.equal(listBody.object, "list");
    assert.equal(listBody.data.some((entry) => entry.id === createBody.goal.id && entry.goal === "Implement goal mode v1"), true);

    const getRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest(`/v1/goals/${createBody.goal.id}`), getRes);
    const getBody = JSON.parse(getRes.body) as {
      goal: { id: string; status: string; tasks: Array<{ id: string; status: string }> };
    };
    assert.equal(getRes.statusCode, 200);
    assert.equal(getBody.goal.id, createBody.goal.id);
    assert.equal(getBody.goal.tasks[0]?.status, "pending");

    const runNextRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${createBody.goal.id}/run-next`, {}), runNextRes);
    const runNextBody = JSON.parse(runNextRes.body) as {
      object: string;
      goal: { id: string; status: string; completedTaskCount: number; tasks: Array<{ status: string; lastJobId?: string }> };
      executed_task: { status: string; lastJobId?: string };
      execution: { status: string; verified: boolean; output: string; job_id: string };
    };
    assert.equal(runNextRes.statusCode, 200);
    assert.equal(runNextBody.object, "goal_run");
    assert.equal(runNextBody.execution.status, "completed");
    assert.equal(runNextBody.execution.verified, true);
    assert.equal(runNextBody.goal.status, "waiting_review");
    assert.equal(runNextBody.goal.completedTaskCount, 1);
    assert.equal(runNextBody.executed_task.status, "completed");
    assert.equal(typeof runNextBody.execution.job_id, "string");
    assert.equal(runNextBody.goal.tasks[0]?.lastJobId, runNextBody.execution.job_id);

    const rerunRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${createBody.goal.id}/run-next`, {}), rerunRes);
    const rerunBody = JSON.parse(rerunRes.body) as { error?: { type?: string; message?: string } };
    assert.equal(rerunRes.statusCode, 409);
    assert.equal(rerunBody.error?.type, "conflict_error");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("goal observability API exposes data, dashboard, events, and timeline contracts", async () => {
  __testables.setTaskExecutorForTests(async (goal, _model, _requirePlannerCircuit, context) => {
    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Goal observability task",
      description: goal,
      status: "completed",
      verified: true,
      output: "Goal observability contract exercised.",
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
      output: "Goal observability contract exercised.",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    return {
      content: "Goal observability contract exercised.",
      logPath: "runtime/logs/goal-observability-contract.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/goals", {
      goal: "Exercise goal observability contracts",
      tasks: [
        {
          title: "Goal observability task",
          description: "Goal observability task",
          mode: "task",
        },
      ],
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      goal: { id: string; status: string };
      links: { self: string; events: string; run_next: string };
    };
    const goalId = createBody.goal.id;
    assert.equal(createRes.statusCode, 201);
    assert.equal(createBody.links.events, `/v1/goals/${goalId}/events`);

    const runNextRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/run-next`, {}), runNextRes);
    assert.equal(runNextRes.statusCode, 200);

    const dataRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest("/v1/goals/data"), dataRes);
    const dataBody = JSON.parse(dataRes.body) as {
      object: string;
      data: Array<{
        id: string;
        goal: string;
        status: string;
        completed_task_count: number;
        total_task_count: number;
        current_task: { id: string; title: string; status: string; mode: string } | null;
        final_review_status: string;
        detail_url: string;
        timeline_url: string;
        events_url: string;
        actions: Array<{ label: string; href?: string; method?: string; kind?: string }>;
      }>;
    };
    const dataGoal = dataBody.data.find((entry) => entry.id === goalId);
    assert.equal(dataRes.statusCode, 200);
    assert.equal(dataBody.object, "list");
    assert.notEqual(dataGoal, undefined);
    assert.equal(dataGoal?.goal, "Exercise goal observability contracts");
    assert.equal(dataGoal?.status, "waiting_review");
    assert.equal(dataGoal?.completed_task_count, 1);
    assert.equal(dataGoal?.total_task_count, 1);
    assert.equal(dataGoal?.current_task, null);
    assert.equal(dataGoal?.final_review_status, "pending");
    assert.equal(dataGoal?.detail_url, `/v1/goals/${goalId}`);
    assert.equal(dataGoal?.timeline_url, `/v1/goals/${goalId}/timeline`);
    assert.equal(dataGoal?.events_url, `/v1/goals/${goalId}/events`);
    assert.equal(dataGoal?.actions.some((action) => action.label === "Review" && action.href === `/v1/goals/${goalId}/review` && action.method === "POST"), true);

    const dashboardRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest("/v1/goals/dashboard"), dashboardRes);
    assert.equal(dashboardRes.statusCode, 200);
    assert.match(String(dashboardRes.headers.get("content-type")), /^text\/html/);
    assert.equal(dashboardRes.body.includes("Goal Dashboard"), true);
    assert.equal(dashboardRes.body.includes("/v1/goals/data"), true);
    assert.equal(dashboardRes.body.includes(`/v1/goals/${goalId}/timeline`), true);

    const eventsRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest(`/v1/goals/${goalId}/events`), eventsRes);
    const eventsBody = JSON.parse(eventsRes.body) as {
      object: string;
      goal_id: string;
      data: Array<{ id: string; type: string; title: string; summary: string; status: string; time: string; meta?: Record<string, unknown> }>;
    };
    assert.equal(eventsRes.statusCode, 200);
    assert.equal(eventsBody.object, "list");
    assert.equal(eventsBody.goal_id, goalId);
    assert.equal(eventsBody.data.some((event) => event.type === "goal.created" && event.status === "success"), true);
    assert.equal(eventsBody.data.some((event) => event.type === "goal.run_next_started" && event.status === "running"), true);
    assert.equal(eventsBody.data.some((event) => event.type === "goal.run_next_completed" && event.status === "success" && event.meta?.goal_status === "waiting_review"), true);

    const timelineRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest(`/v1/goals/${goalId}/timeline`), timelineRes);
    assert.equal(timelineRes.statusCode, 200);
    assert.match(String(timelineRes.headers.get("content-type")), /^text\/html/);
    assert.equal(timelineRes.body.includes("Goal Timeline"), true);
    assert.equal(timelineRes.body.includes(`/v1/goals/${goalId}/events`), true);
    assert.equal(timelineRes.body.includes("Run-next completed"), true);
    assert.equal(timelineRes.body.includes("Goal observability task"), true);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("goal API only inserts large checks for explicit tasks when requested", async () => {
  const explicitTasks = [
    { title: "Task 1", description: "Task 1", mode: "task" },
    { title: "Task 2", description: "Task 2", mode: "task" },
    { title: "Task 3", description: "Task 3", mode: "task" },
    { title: "Task 4", description: "Task 4", mode: "task" },
  ];

  const defaultRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/goals", {
    goal: "Explicit tasks without automatic large checks",
    tasks: explicitTasks,
  }), defaultRes);
  const defaultBody = JSON.parse(defaultRes.body) as {
    goal: { tasks: Array<{ kind: string; title: string }> };
  };

  assert.equal(defaultRes.statusCode, 201);
  assert.equal(defaultBody.goal.tasks.length, 4);
  assert.equal(defaultBody.goal.tasks.some((task) => task.kind === "large_check"), false);

  const requestedRes = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/goals", {
    goal: "Explicit tasks with requested large checks",
    insert_large_checks: true,
    tasks: explicitTasks,
  }), requestedRes);
  const requestedBody = JSON.parse(requestedRes.body) as {
    goal: { tasks: Array<{ kind: string; title: string; mode: string }> };
  };

  assert.equal(requestedRes.statusCode, 201);
  assert.equal(requestedBody.goal.tasks.length, 5);
  assert.equal(requestedBody.goal.tasks[3]?.kind, "large_check");
  assert.equal(requestedBody.goal.tasks[3]?.mode, "team");
  assert.equal(requestedBody.goal.tasks[4]?.title, "Task 4");
});

test("goal API can execute inserted large_check tasks through run-next", async () => {
  const executedKinds: string[] = [];
  const buildExecutionPayload = (goal: string, mode: "task" | "team", context?: {
    jobId?: string;
    planId?: string;
    taskRunId?: string;
  }) => {
    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: goal,
      description: goal,
      status: "completed",
      verified: true,
      output: `${goal} completed.`,
      attempts: 1,
      artifacts: [],
    });
    const plan = createPlanRecord({
      id: context?.planId,
      goal,
      mode,
      taskRunIds: [taskRun.id],
    });
    const job = createJobRecord({
      id: context?.jobId,
      goal,
      mode,
      status: "completed",
      verified: true,
      output: `${goal} completed.`,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    });
    return {
      content: job.output,
      logPath: "runtime/logs/goal-large-check.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  };

  __testables.setTaskExecutorForTests(async (goal, _model, _requirePlannerCircuit, context) => {
    return buildExecutionPayload(goal, "task", context);
  });
  __testables.setTeamExecutorForTests(async (goal, _model, context) => {
    return buildExecutionPayload(goal, "team", context);
  });

  try {
    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/goals", {
      goal: "Run explicit tasks with a large check",
      insert_large_checks: true,
      tasks: [
        { title: "Task 1", description: "Task 1", mode: "task" },
        { title: "Task 2", description: "Task 2", mode: "task" },
        { title: "Task 3", description: "Task 3", mode: "task" },
        { title: "Task 4", description: "Task 4", mode: "task" },
      ],
    }), createRes);
    const createBody = JSON.parse(createRes.body) as {
      goal: { id: string; tasks: Array<{ kind: string; title: string }> };
    };
    const goalId = createBody.goal.id;

    assert.equal(createRes.statusCode, 201);
    assert.equal(createBody.goal.tasks.map((task) => task.kind).join(","), "goal_task,goal_task,goal_task,large_check,goal_task");

    for (let index = 0; index < 4; index += 1) {
      const runRes = new MockResponse() as unknown as ServerResponse & MockResponse;
      await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/run-next`, {}), runRes);
      const runBody = JSON.parse(runRes.body) as {
        goal: { status: string; completedTaskCount: number };
        executed_task: { kind: string; title: string; status: string; lastJobId?: string; verificationSummary?: string };
      };

      assert.equal(runRes.statusCode, 200);
      executedKinds.push(runBody.executed_task.kind);
      assert.equal(runBody.executed_task.status, "completed");
      assert.equal(typeof runBody.executed_task.lastJobId, "string");
      assert.equal(runBody.executed_task.verificationSummary, "Verification completed successfully.");
      assert.equal(runBody.goal.completedTaskCount, index + 1);
      assert.equal(runBody.goal.status, index === 3 ? "ready" : "ready");
    }

    assert.deepEqual(executedKinds, ["goal_task", "goal_task", "goal_task", "large_check"]);

    const getRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedGetRequest(`/v1/goals/${goalId}`), getRes);
    const getBody = JSON.parse(getRes.body) as {
      goal: { tasks: Array<{ kind: string; status: string; verificationSummary?: string }> };
    };
    assert.equal(getRes.statusCode, 200);
    assert.equal(getBody.goal.tasks[3]?.kind, "large_check");
    assert.equal(getBody.goal.tasks[3]?.status, "completed");
    assert.equal(getBody.goal.tasks[4]?.status, "pending");
  } finally {
    __testables.setTaskExecutorForTests(null);
    __testables.setTeamExecutorForTests(null);
  }
});

test("goal API supports retry, resume, and review", async () => {
  let taskInvocation = 0;
  __testables.setTaskExecutorForTests(async (goal, _model, _requirePlannerCircuit, context) => {
    taskInvocation += 1;

    const taskRun = createTaskRunRecord({
      id: context?.taskRunId,
      title: "Goal lifecycle task",
      description: goal,
      status: taskInvocation === 1
        ? "failed"
        : goal.includes("Produce a final review")
          ? "completed"
          : "completed",
      verified: taskInvocation !== 1,
      output: taskInvocation === 1
        ? "First attempt failed."
        : goal.includes("Produce a final review")
          ? "Final review completed."
          : "Retry succeeded.",
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
      status: taskInvocation === 1
        ? "failed"
        : "completed",
      verified: taskInvocation !== 1,
      output: taskInvocation === 1
        ? "First attempt failed."
        : goal.includes("Produce a final review")
          ? "Final review completed."
          : "Retry succeeded.",
      plan,
      taskRuns: [taskRun],
      artifacts: [],
      verificationResult: taskInvocation === 1
        ? undefined
        : {
            status: "verified",
            summary: goal.includes("Produce a final review")
              ? "final review verified"
              : "retry verified",
            checks: [],
          },
    });
    return {
      content: job.output,
      logPath: "runtime/logs/goal-second-layer.jsonl",
      resolvedModel: "dual-agent-orchestrator",
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: [],
    };
  });

  try {
    const createRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest("/v1/goals", {
      goal: "Exercise goal lifecycle controls",
      tasks: [
        {
          title: "Primary failing task",
          description: "Primary failing task",
          mode: "task",
        },
      ],
    }), createRes);
    const createBody = JSON.parse(createRes.body) as { goal: { id: string } };
    const goalId = createBody.goal.id;

    const runNextRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/run-next`, {}), runNextRes);
    const runNextBody = JSON.parse(runNextRes.body) as {
      goal: { status: string; tasks: Array<{ status: string }> };
      execution: { status: string };
    };
    assert.equal(runNextRes.statusCode, 200);
    assert.equal(runNextBody.execution.status, "failed");
    assert.equal(runNextBody.goal.status, "failed");
    assert.equal(runNextBody.goal.tasks[0]?.status, "failed");

    const resumeConflictRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/resume`, {}), resumeConflictRes);
    const resumeConflictBody = JSON.parse(resumeConflictRes.body) as { error?: { type?: string } };
    assert.equal(resumeConflictRes.statusCode, 409);
    assert.equal(resumeConflictBody.error?.type, "conflict_error");

    const retryRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/retry`, {}), retryRes);
    const retryBody = JSON.parse(retryRes.body) as {
      goal: { status: string; tasks: Array<{ status: string; lastJobId?: string }> };
      execution: { status: string; verified: boolean };
    };
    assert.equal(retryRes.statusCode, 200);
    assert.equal(retryBody.execution.status, "completed");
    assert.equal(retryBody.execution.verified, true);
    assert.equal(retryBody.goal.status, "waiting_review");
    assert.equal(retryBody.goal.tasks[0]?.status, "completed");
    assert.equal(typeof retryBody.goal.tasks[0]?.lastJobId, "string");

    const reviewRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/review`, {}), reviewRes);
    const reviewBody = JSON.parse(reviewRes.body) as {
      object: string;
      goal: { status: string; completedAt?: string; finalReview: { status: string; summary?: string; verified?: boolean } };
      final_review: { status: string; summary?: string; verified?: boolean };
      execution: { status: string; verified: boolean };
    };
    assert.equal(reviewRes.statusCode, 200);
    assert.equal(reviewBody.object, "goal_review");
    assert.equal(reviewBody.execution.status, "completed");
    assert.equal(reviewBody.goal.status, "completed");
    assert.equal(reviewBody.final_review.status, "completed");
    assert.equal(reviewBody.final_review.verified, true);
    assert.equal(typeof reviewBody.goal.completedAt, "string");

    const stored = readGoal(goalId);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.finalReview.status, "completed");

    const reviewConflictRes = new MockResponse() as unknown as ServerResponse & MockResponse;
    await __testables.handleRequest(buildAuthorizedJsonRequest(`/v1/goals/${goalId}/review`, {}), reviewConflictRes);
    const reviewConflictBody = JSON.parse(reviewConflictRes.body) as { error?: { type?: string } };
    assert.equal(reviewConflictRes.statusCode, 409);
    assert.equal(reviewConflictBody.error?.type, "conflict_error");
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
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
    assert.match(res.body, /\[步骤 1 · 规划中\]/u);
    assert.equal(res.body.includes("\\n"), true);
    assert.match(res.body, /正在规划下一步。/u);
    assert.match(res.body, /正在确定检索重点/u);
    assert.match(res.body, /\[步骤 1 · 归纳中\]/u);
    assert.match(res.body, /已沉淀 /u);
    assert.match(res.body, /份有效资料，准备进入归纳阶段。/u);
    assert.match(res.body, /\[最终结论\]/u);
    assert.equal(res.body.includes("\"content\":\"Final \""), true);
    assert.equal(res.body.includes("\"content\":\"synthesized \""), true);
    assert.equal(res.body.includes("\"content\":\"answer.\""), true);
    assert.equal(res.body.includes("event: workflow."), false);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("chat completions stream humanizes tool progress summaries for end users", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_stream_humanized",
    title: "Primary Task",
    description: "Humanized progress",
    status: "completed",
    verified: true,
    output: "Final answer.",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_stream_humanized",
    goal: "Humanized progress",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_stream_humanized",
    goal: "Humanized progress",
    mode: "task",
    status: "completed",
    verified: true,
    output: "Final answer.",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    context?.emitEvent?.({
      type: "workflow.executor.start",
      step: 1,
      data: {
        instruction: "Search the web for benchmark evidence and then summarize the strongest sources.",
        allowed_tools: ["web_search", "url_fetch"],
      },
    });
    context?.emitEvent?.({
      type: "workflow.tool.start",
      step: 1,
      data: { tool: "web_search", arguments: { query: "benchmark evidence" } },
    });
    context?.emitEvent?.({
      type: "workflow.tool.result",
      step: 1,
      data: { tool: "web_search", ok: true, summary: "Found 10 results (legacy)" },
    });
    context?.emitEvent?.({
      type: "workflow.tool.start",
      step: 1,
      data: { tool: "url_fetch", arguments: { url: "https://example.com" } },
    });
    context?.emitEvent?.({
      type: "workflow.tool.result",
      step: 1,
      data: { tool: "url_fetch", ok: false, summary: "Fetch failed" },
    });
    context?.emitEvent?.({
      type: "workflow.executor.result",
      step: 1,
      data: {
        status: "success",
        summary: "Found 10 results (legacy)",
        artifact_count: 1,
      },
    });
    return {
      content: "Final answer.",
      logPath: "runtime/logs/test-humanized-progress.jsonl",
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
      messages: [{ role: "user", content: "Show me humanized progress" }],
    });
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;

    await __testables.handleRequest(req, res);

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\[步骤 1 · 检索中\]/u);
    assert.match(res.body, /正在检索支撑资料和基准对比信息。/u);
    assert.match(res.body, /\[检索中\]/u);
    assert.match(res.body, /正在扩展检索范围，补充更多候选资料。/u);
    assert.match(res.body, /已找到 /u);
    assert.match(res.body, /条候选结果，正在筛选可信来源。/u);
    assert.match(res.body, /\[取证中\]/u);
    assert.match(res.body, /正在打开候选页面，提取关键证据。/u);
    assert.match(res.body, /目标页面暂时无法读取，正在尝试其他来源。/u);
    assert.match(res.body, /\[步骤 1 · 筛选中\]/u);
    assert.match(res.body, /已收集 /u);
    assert.match(res.body, /条候选资料，正在筛选高质量证据。/u);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});

test("chat completions stream aggregates repeated tool activity into stage summaries", async () => {
  const taskRun = createTaskRunRecord({
    id: "taskrun_stream_aggregated",
    title: "Primary Task",
    description: "Aggregated progress",
    status: "completed",
    verified: true,
    output: "Final answer.",
    attempts: 1,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_stream_aggregated",
    goal: "Aggregated progress",
    mode: "task",
    taskRunIds: [taskRun.id],
  });
  const job = createJobRecord({
    id: "job_stream_aggregated",
    goal: "Aggregated progress",
    mode: "task",
    status: "completed",
    verified: true,
    output: "Final answer.",
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  __testables.setTaskExecutorForTests(async (_goal, _model, _requirePlannerCircuit, context) => {
    context?.emitEvent?.({
      type: "workflow.executor.start",
      step: 1,
      data: {
        instruction: "Search the web for benchmark evidence and compare multiple sources.",
        allowed_tools: ["web_search"],
      },
    });
    context?.emitEvent?.({
      type: "workflow.tool.start",
      step: 1,
      data: { tool: "web_search", arguments: { query: "query 1" } },
    });
    context?.emitEvent?.({
      type: "workflow.tool.result",
      step: 1,
      data: { tool: "web_search", ok: true, summary: "Found 10 results (legacy)" },
    });
    context?.emitEvent?.({
      type: "workflow.tool.start",
      step: 1,
      data: { tool: "web_search", arguments: { query: "query 2" } },
    });
    context?.emitEvent?.({
      type: "workflow.tool.result",
      step: 1,
      data: { tool: "web_search", ok: true, summary: "Found 5 results (legacy)" },
    });
    context?.emitEvent?.({
      type: "workflow.tool.start",
      step: 1,
      data: { tool: "web_search", arguments: { query: "query 3" } },
    });
    context?.emitEvent?.({
      type: "workflow.tool.result",
      step: 1,
      data: { tool: "web_search", ok: true, summary: "Found 8 results (legacy)" },
    });
    context?.emitEvent?.({
      type: "workflow.executor.result",
      step: 1,
      data: {
        status: "success",
        summary: "Found 23 results (legacy)",
        artifact_count: 1,
      },
    });
    return {
      content: "Final answer.",
      logPath: "runtime/logs/test-aggregated-progress.jsonl",
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
      messages: [{ role: "user", content: "Show me aggregated progress" }],
    });
    const res = new MockResponse() as unknown as ServerResponse & MockResponse;

    await __testables.handleRequest(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal((res.body.match(/正在扩展检索范围，补充更多候选资料。/gu) ?? []).length, 1);
    assert.match(res.body, /\[检索中\]/u);
    assert.match(res.body, /已完成 /u);
    assert.match(res.body, /轮搜索，累计找到 /u);
    assert.match(res.body, /条候选结果，正在筛选可信来源。/u);
  } finally {
    __testables.setTaskExecutorForTests(null);
  }
});
