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
