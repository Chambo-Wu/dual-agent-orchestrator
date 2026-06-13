import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { __testables } from "../../src/index.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";
import { buildMinimalConfig } from "../helpers/fake-runtime.js";

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

function jsonRequest(method: "POST" | "GET", url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(req, {
    method,
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
      "content-type": "application/json",
    },
  });
  if (method === "POST") {
    queueMicrotask(() => {
      req.emit("data", JSON.stringify(body ?? {}));
      req.emit("end");
    });
  }
  return req;
}

async function request(method: "POST" | "GET", url: string, body?: unknown): Promise<MockResponse> {
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;
  await __testables.handleRequest(jsonRequest(method, url, body), res);
  return res;
}

async function withLocalProbeServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "OK",
          },
        }],
      }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("demo smoke covers health, dashboards, skills, and a goal run-next path", async () => {
  await withLocalProbeServer(async (baseUrl) => {
    const config = buildMinimalConfig();
    config.executor.baseUrl = baseUrl;
    config.modelRegistry["executor.default"]!.model.baseUrl = baseUrl;
    __testables.setConfigOverrideForTests(config);

    __testables.setTaskExecutorForTests(async (goal, _model, _requirePlannerCircuit, context) => {
      const taskRun = createTaskRunRecord({
        id: context?.taskRunId,
        title: "Demo smoke task",
        description: goal,
        status: "completed",
        verified: true,
        output: "Demo smoke task completed.",
        attempts: 1,
        artifacts: [],
      });
      const plan = createPlanRecord({
        id: context?.planId,
        goal,
        mode: "task",
        taskRunIds: [taskRun.id],
        summary: "Demo smoke plan.",
      });
      const job = createJobRecord({
        id: context?.jobId,
        goal,
        mode: "task",
        status: "completed",
        verified: true,
        output: "Demo smoke task completed.",
        plan,
        taskRuns: [taskRun],
        artifacts: [],
      });
      return {
        content: "Demo smoke task completed.",
        logPath: "runtime/logs/demo-smoke.jsonl",
        resolvedModel: "dual-agent-orchestrator",
        job,
        plan,
        taskRuns: [taskRun],
        artifacts: [],
      };
    });

    try {
      const healthRes = await request("GET", "/health");
      assert.equal(healthRes.statusCode, 200);
      const healthBody = JSON.parse(healthRes.body) as {
        status?: string;
        executor?: { active_probe?: { healthy_candidates?: string[] } };
        skills?: { available_count?: number };
        runtime?: { goal_mode?: { total_goals?: number } };
      };
      assert.equal(healthBody.status, "ok");
      assert.deepEqual(healthBody.executor?.active_probe?.healthy_candidates, ["executor.default"]);
      assert.equal(typeof healthBody.skills?.available_count, "number");
      assert.equal(typeof healthBody.runtime?.goal_mode?.total_goals, "number");

      const skillsRes = await request("GET", "/v1/skills");
      assert.equal(skillsRes.statusCode, 200);
      const skillsBody = JSON.parse(skillsRes.body) as { data?: unknown[] };
      assert.equal(Array.isArray(skillsBody.data), true);
      assert.equal(skillsBody.data!.length > 0, true);

      const jobsDashboardRes = await request("GET", "/v1/jobs/dashboard");
      assert.equal(jobsDashboardRes.statusCode, 200);
      assert.equal(jobsDashboardRes.body.includes("Job Dashboard"), true);

      const goalsDashboardRes = await request("GET", "/v1/goals/dashboard");
      assert.equal(goalsDashboardRes.statusCode, 200);
      assert.equal(goalsDashboardRes.body.includes("Goal Dashboard"), true);

      const createGoalRes = await request("POST", "/v1/goals", {
        goal: "Prepare a demo smoke goal",
        tasks: [{
          title: "Run demo smoke task",
          description: "Run the demo smoke task.",
          mode: "task",
        }],
      });
      assert.equal(createGoalRes.statusCode, 201);
      const createGoalBody = JSON.parse(createGoalRes.body) as {
        goal?: { id?: string; status?: string };
      };
      const goalId = createGoalBody.goal?.id;
      assert.equal(typeof goalId, "string");
      assert.equal(createGoalBody.goal?.status, "ready");

      const runNextRes = await request("POST", `/v1/goals/${goalId}/run-next`, {});
      assert.equal(runNextRes.statusCode, 200);
      const runNextBody = JSON.parse(runNextRes.body) as {
        execution?: { status?: string; verified?: boolean; job_id?: string };
        goal?: { status?: string };
      };
      assert.equal(runNextBody.execution?.status, "completed");
      assert.equal(runNextBody.execution?.verified, true);
      assert.equal(typeof runNextBody.execution?.job_id, "string");
      assert.equal(runNextBody.goal?.status, "waiting_review");

      const timelineRes = await request("GET", `/v1/goals/${goalId}/timeline`);
      assert.equal(timelineRes.statusCode, 200);
      assert.equal(timelineRes.body.includes(goalId ?? ""), true);
    } finally {
      __testables.setTaskExecutorForTests(null);
      __testables.setConfigOverrideForTests(null);
    }
  });
});

test("job lifecycle smoke covers create, get, events, timeline, cancel", async () => {
  await withLocalProbeServer(async (baseUrl) => {
    // 1. Create a job
    const createRes = await request("POST", `${baseUrl}/jobs`, {
      goal: "Write a markdown file named test-e2e.md with a single line 'hello e2e'",
      mode: "task",
    });
    assert.equal(createRes.statusCode, 201);
    const created = JSON.parse(createRes.body);
    assert.ok(created.id, "job should have an id");
    const jobId: string = created.id;

    // 2. Get the job
    const getRes = await request("GET", `${baseUrl}/jobs/${jobId}`);
    assert.equal(getRes.statusCode, 200);
    const job = JSON.parse(getRes.body);
    assert.equal(job.id, jobId);
    assert.ok(["pending", "running", "completed", "failed"].includes(job.status), `unexpected job status: ${job.status}`);

    // 3. Get job events (should return array or object with events)
    const eventsRes = await request("GET", `${baseUrl}/jobs/${jobId}/events`);
    assert.equal(eventsRes.statusCode, 200);
    const events = JSON.parse(eventsRes.body);
    assert.ok(Array.isArray(events) || events.events, "events should be accessible");

    // 4. Get job timeline (HTML)
    const timelineRes = await request("GET", `${baseUrl}/jobs/${jobId}/timeline`);
    assert.equal(timelineRes.statusCode, 200);
    assert.ok(timelineRes.body.includes("<!DOCTYPE html>") || timelineRes.body.includes("<html"), "timeline should return HTML");

    // 5. Cancel the job
    const cancelRes = await request("POST", `${baseUrl}/jobs/${jobId}/cancel`);
    assert.ok([200, 409].includes(cancelRes.statusCode), `cancel should return 200 or 409, got ${cancelRes.statusCode}`);
  });
});

test("job list endpoint returns paginated results", async () => {
  await withLocalProbeServer(async (baseUrl) => {
    const res = await request("GET", `${baseUrl}/jobs`);
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body);
    assert.ok(Array.isArray(list), "job list should be an array");
  });
});

test("dashboard endpoints return HTML", async () => {
  const res = await request("GET", "/jobs/dashboard");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("<!DOCTYPE html>") || res.body.includes("<html"), "jobs dashboard should return HTML");
});

test("goals dashboard returns HTML", async () => {
  const res = await request("GET", "/goals/dashboard");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("<!DOCTYPE html>") || res.body.includes("<html"), "goals dashboard should return HTML");
});
