import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWorkflowPlan } from "../../src/workflow-runtime.js";
import { buildMinimalConfig, buildRoutePolicy, createFakeRuntimeDeps, fakeRunTaskResult } from "../helpers/fake-runtime.js";
import type { ExecutorOutput, PlannerOutput } from "../../src/types.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";
import { persistJobRecord, readJobRecord } from "../../src/job-store.js";
import { registerActiveJobSession, resolvePendingApproval, unregisterActiveJobSession } from "../../src/job-runtime.js";

const TEST_JOBS_DIR = resolve(import.meta.dirname!, "../../runtime/jobs");

test("workflow runtime executes delegate then write tasks", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const runTaskCalls: string[] = [];
  const runExecutorCalls: PlannerOutput[] = [];

  const result = await runWorkflowPlan(
    config,
    "Research and write a report",
    {
      id: "wf_b1",
      strategy: "delegate_write",
      summary: "Delegate research then write report.",
      tasks: [
        {
          id: "t1",
          title: "Collect evidence",
          kind: "delegate",
          role: "worker",
          instruction: "Collect evidence.",
          allowed_tools: ["web_search"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Write report",
          kind: "write",
          role: "worker",
          instruction: "Write the report file.",
          allowed_tools: ["write_file"],
          depends_on: ["t1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runTask: async (_cfg, taskPrompt) => {
        runTaskCalls.push(taskPrompt);
        return fakeRunTaskResult({
          output: "Collected evidence.",
          verified: true,
          status: "completed",
        });
      },
      runExecutorStep: async (_cfg, planner) => {
        runExecutorCalls.push(planner);
        const executorResult: ExecutorOutput = {
          status: "success",
          summary: "Wrote report.md",
          tool_calls_made: [{ tool: "write_file", arguments: { path: "report.md", content: "done" } }],
          artifacts: [{ type: "file", path: "report.md", content_preview: "done" }],
          raw_result: "done",
          source: "native_tool",
        };
        return executorResult;
      },
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.verified, true);
  assert.equal(runTaskCalls.length, 1);
  assert.equal(runExecutorCalls.length, 1);
  assert.equal(result.taskRuns.length, 2);
  assert.equal(result.taskRuns[0]?.status, "completed");
  assert.equal(result.taskRuns[1]?.status, "completed");
});

test("workflow runtime blocks unsupported milestone C plans", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();

  const result = await runWorkflowPlan(
    config,
    "Unsupported workflow",
    {
      id: "wf_b2",
      strategy: "transform_only",
      summary: "Unsupported transform plan.",
      tasks: [
        {
          id: "t1",
          title: "Transform data",
          kind: "transform",
          role: "worker",
          instruction: "Transform data.",
          allowed_tools: ["parse_json"],
          depends_on: [],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.output.includes("not executable in Milestone C"), true);
});

test("workflow runtime persists awaiting approval state for approval tasks", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const jobId = "job_workflow_approval";
  const planId = "plan_workflow_approval";
  const controller = new AbortController();

  mkdirSync(resolve(TEST_JOBS_DIR, jobId), { recursive: true });
  persistJobRecord({
    job: createJobRecord({
      id: jobId,
      goal: "Approval workflow",
      mode: "task",
      status: "running",
      verified: false,
      output: "Running...",
      plan: createPlanRecord({
        id: planId,
        goal: "Approval workflow",
        mode: "task",
        taskRunIds: ["approve_1"],
        summary: "Seed workflow plan.",
      }),
      taskRuns: [
        createTaskRunRecord({
          id: "approve_1",
          title: "Approval step",
          description: "Wait for approval",
          status: "pending",
          verified: false,
          output: "",
          attempts: 0,
          artifacts: [],
        }),
      ],
      artifacts: [],
    }),
    plan: createPlanRecord({
      id: planId,
      goal: "Approval workflow",
      mode: "task",
      taskRunIds: ["approve_1"],
      summary: "Seed workflow plan.",
    }),
    taskRuns: [
      createTaskRunRecord({
        id: "approve_1",
        title: "Approval step",
        description: "Wait for approval",
        status: "pending",
        verified: false,
        output: "",
        attempts: 0,
        artifacts: [],
      }),
    ],
    artifacts: [],
  });

  registerActiveJobSession(jobId, "Approval workflow", controller);

  const workflowPromise = runWorkflowPlan(
    config,
    "Approval workflow",
    {
      id: "wf_approval",
      strategy: "approval_only",
      summary: "Wait for approval before finishing.",
      tasks: [
        {
          id: "approve_1",
          title: "Approval step",
          kind: "approval",
          role: "worker",
          instruction: "Please approve this workflow.",
          allowed_tools: [],
          depends_on: [],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps(),
    {
      jobId,
      planId,
    },
  );

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));

  const pendingRecord = readJobRecord(jobId);
  assert.ok(pendingRecord);
  assert.equal(pendingRecord?.job.status, "awaiting_approval");
  assert.equal(pendingRecord?.taskRuns[0]?.status, "awaiting_approval");
  assert.equal(pendingRecord?.approvalRequests?.length, 1);

  resolvePendingApproval(jobId, "approved");
  const result = await workflowPromise;

  assert.equal(result.status, "completed");
  const completedRecord = readJobRecord(jobId);
  assert.ok(completedRecord);
  assert.equal(completedRecord?.job.status, "completed");
  assert.equal(completedRecord?.taskRuns[0]?.status, "completed");

  unregisterActiveJobSession(jobId);
  rmSync(resolve(TEST_JOBS_DIR, jobId), { recursive: true, force: true });
});

test("workflow runtime honors finish_when any_of by stopping after the first selected completion", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];

  const result = await runWorkflowPlan(
    config,
    "Complete either branch",
    {
      id: "wf_finish_any_of",
      strategy: "parallel_options",
      summary: "Finish when either branch completes.",
      tasks: [
        {
          id: "t1",
          title: "Primary option",
          kind: "read",
          role: "worker",
          instruction: "Read the primary source.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Secondary option",
          kind: "read",
          role: "worker",
          instruction: "Read the secondary source.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: true,
        },
        {
          id: "t3",
          title: "Write after primary",
          kind: "write",
          role: "worker",
          instruction: "Write the primary result.",
          allowed_tools: ["write_file"],
          depends_on: ["t1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "any_of",
        task_ids: ["t1", "t2"],
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async (_cfg, planner) => {
        executorPlanners.push(planner);
        return {
          status: "success",
          summary: `Completed ${planner.next_step}`,
          tool_calls_made: [{ tool: "read_file", arguments: { path: "source.txt" } }],
          artifacts: [{ type: "file", path: "source.txt", content_preview: "content" }],
          raw_result: "content",
          source: "native_tool",
        };
      },
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.taskRuns[0]?.status, "completed");
  assert.equal(result.taskRuns[1]?.status, "skipped");
  assert.equal(result.taskRuns[2]?.status, "skipped");
  assert.equal(executorPlanners.length, 1);
});

test("workflow runtime honors finish_when first_success by stopping after the first successful target", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];

  const result = await runWorkflowPlan(
    config,
    "Use the first success",
    {
      id: "wf_finish_first_success",
      strategy: "first_success",
      summary: "Finish after the first successful candidate.",
      tasks: [
        {
          id: "t1",
          title: "Candidate A",
          kind: "read",
          role: "worker",
          instruction: "Read candidate A.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Candidate B",
          kind: "read",
          role: "worker",
          instruction: "Read candidate B.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: true,
        },
      ],
      finish_when: {
        mode: "first_success",
        task_ids: ["t1", "t2"],
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async (_cfg, planner) => {
        executorPlanners.push(planner);
        return {
          status: "success",
          summary: `Completed ${planner.next_step}`,
          tool_calls_made: [{ tool: "read_file", arguments: { path: "candidate.txt" } }],
          artifacts: [{ type: "file", path: "candidate.txt", content_preview: "candidate" }],
          raw_result: "candidate",
          source: "native_tool",
        };
      },
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.taskRuns[0]?.status, "completed");
  assert.equal(result.taskRuns[1]?.status, "skipped");
  assert.equal(executorPlanners.length, 1);
});

test("workflow runtime honors finish_when manual_approval_resolved by stopping after approval", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const jobId = "job_finish_manual_approval";
  const planId = "plan_finish_manual_approval";
  const controller = new AbortController();

  mkdirSync(resolve(TEST_JOBS_DIR, jobId), { recursive: true });
  persistJobRecord({
    job: createJobRecord({
      id: jobId,
      goal: "Approval-only finish",
      mode: "task",
      status: "running",
      verified: false,
      output: "Running...",
      plan: createPlanRecord({
        id: planId,
        goal: "Approval-only finish",
        mode: "task",
        taskRunIds: ["approve_1"],
        summary: "Seed workflow plan.",
      }),
      taskRuns: [
        createTaskRunRecord({
          id: "approve_1",
          title: "Approval step",
          description: "Wait for approval",
          status: "pending",
          verified: false,
          output: "",
          attempts: 0,
          artifacts: [],
        }),
      ],
      artifacts: [],
    }),
    plan: createPlanRecord({
      id: planId,
      goal: "Approval-only finish",
      mode: "task",
      taskRunIds: ["approve_1"],
      summary: "Seed workflow plan.",
    }),
    taskRuns: [
      createTaskRunRecord({
        id: "approve_1",
        title: "Approval step",
        description: "Wait for approval",
        status: "pending",
        verified: false,
        output: "",
        attempts: 0,
        artifacts: [],
      }),
    ],
    artifacts: [],
  });
  registerActiveJobSession(jobId, "Approval-only finish", controller);

  const workflowPromise = runWorkflowPlan(
    config,
    "Approval-only finish",
    {
      id: "wf_finish_manual_approval",
      strategy: "approval_gates_finish",
      summary: "Finish as soon as approval resolves.",
      tasks: [
        {
          id: "approve_1",
          title: "Approval step",
          kind: "approval",
          role: "worker",
          instruction: "Approve this workflow.",
          allowed_tools: [],
          depends_on: [],
          required: true,
        },
        {
          id: "after_approval",
          title: "Write after approval",
          kind: "write",
          role: "worker",
          instruction: "This should not run once approval resolves.",
          allowed_tools: ["write_file"],
          depends_on: ["approve_1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "manual_approval_resolved",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async () => {
        throw new Error("Downstream task should not execute after approval resolution.");
      },
    }),
    {
      jobId,
      planId,
    },
  );

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  resolvePendingApproval(jobId, "approved");
  const result = await workflowPromise;

  assert.equal(result.status, "completed");
  assert.equal(result.taskRuns[0]?.status, "completed");
  assert.equal(result.taskRuns[1]?.status, "skipped");

  unregisterActiveJobSession(jobId);
  rmSync(resolve(TEST_JOBS_DIR, jobId), { recursive: true, force: true });
});

test("workflow runtime executes search fetch read and extract tasks through executor steps", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];

  const result = await runWorkflowPlan(
    config,
    "Research a topic with staged workflow tasks",
    {
      id: "wf_c1",
      strategy: "search_fetch_read_extract",
      summary: "Search, fetch, read, and extract evidence.",
      tasks: [
        {
          id: "t1",
          title: "Search sources",
          kind: "search",
          role: "worker",
          instruction: "Search for primary sources.",
          allowed_tools: ["web_search"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Fetch source",
          kind: "fetch",
          role: "worker",
          instruction: "Fetch the strongest source.",
          allowed_tools: ["url_fetch"],
          depends_on: ["t1"],
          required: true,
        },
        {
          id: "t3",
          title: "Read artifact",
          kind: "read",
          role: "worker",
          instruction: "Read the fetched artifact.",
          allowed_tools: ["read_file"],
          depends_on: ["t2"],
          required: true,
        },
        {
          id: "t4",
          title: "Extract findings",
          kind: "extract",
          role: "worker",
          instruction: "Extract the key findings into structured text.",
          allowed_tools: ["extract_text", "parse_json"],
          depends_on: ["t3"],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async (_cfg, planner, stepNumber) => {
        executorPlanners.push(planner);
        const outputs: ExecutorOutput[] = [
          {
            status: "success",
            summary: "Found 3 results (test)",
            tool_calls_made: [{ tool: "web_search", arguments: { query: "primary sources" } }],
            artifacts: [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{}]" }],
            raw_result: "[{}]",
            source: "native_tool",
          },
          {
            status: "success",
            summary: "Fetched https://example.com/source",
            tool_calls_made: [{ tool: "url_fetch", arguments: { url: "https://example.com/source" } }],
            artifacts: [{ type: "file", path: "runtime/command-results/source.txt", content_preview: "source body" }],
            raw_result: "source body",
            source: "native_tool",
          },
          {
            status: "success",
            summary: "Read file runtime/command-results/source.txt",
            tool_calls_made: [{ tool: "read_file", arguments: { path: "runtime/command-results/source.txt" } }],
            artifacts: [{ type: "file", path: "runtime/command-results/source.txt", content_preview: "source body" }],
            raw_result: "source body",
            source: "native_tool",
          },
          {
            status: "success",
            summary: "Extracted findings",
            tool_calls_made: [{ tool: "extract_text", arguments: { content: "source body", format: "auto" } }],
            artifacts: [{ type: "text", content_preview: "key findings" }],
            raw_result: "key findings",
            source: "native_tool",
          },
        ];
        return outputs[stepNumber - 1]!;
      },
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.taskRuns.length, 4);
  assert.equal(result.taskRuns.every((taskRun) => taskRun.status === "completed"), true);
  assert.equal(executorPlanners.length, 4);
  assert.equal(executorPlanners[0]?.executor_request?.allowed_tools[0], "web_search");
  assert.equal(executorPlanners[1]?.executor_request?.allowed_tools[0], "url_fetch");
  assert.equal(executorPlanners[2]?.executor_request?.allowed_tools[0], "read_file");
  assert.equal(executorPlanners[3]?.executor_request?.allowed_tools.includes("extract_text"), true);
});

test("workflow runtime executes synthesize tasks from dependency outputs", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  let synthesisCalls = 0;

  const result = await runWorkflowPlan(
    config,
    "Research and synthesize",
    {
      id: "wf_c2",
      strategy: "delegate_synthesize",
      summary: "Delegate evidence collection and synthesize the answer.",
      tasks: [
        {
          id: "t1",
          title: "Collect evidence",
          kind: "delegate",
          role: "worker",
          instruction: "Collect evidence.",
          allowed_tools: ["web_search"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Synthesize answer",
          kind: "synthesize",
          role: "synthesizer",
          instruction: "Synthesize a concise final answer.",
          allowed_tools: [],
          depends_on: ["t1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runTask: async () => fakeRunTaskResult({
        output: "Evidence A\nEvidence B",
        verified: true,
        status: "completed",
      }),
      runTeamSynthesis: async (_cfg, goal, resultsText, memorySummary) => {
        synthesisCalls += 1;
        assert.equal(goal, "Research and synthesize");
        assert.equal(resultsText.includes("Synthesize answer"), true);
        assert.equal(memorySummary.includes("Evidence A"), true);
        return "Final synthesized answer.";
      },
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "Final synthesized answer.");
  assert.equal(result.taskRuns[1]?.status, "completed");
  assert.equal(synthesisCalls, 1);
});

test("workflow runtime executes verify tasks using dependency artifacts", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];
  const sourcePath = resolve(import.meta.dirname!, "../../source.txt");
  writeFileSync(sourcePath, "source content", "utf8");

  try {
    const result = await runWorkflowPlan(
      config,
      "Read, verify, and write",
      {
        id: "wf_verify_pass",
        strategy: "read_verify_write",
        summary: "Read an artifact, verify it, then write the result.",
        tasks: [
          {
            id: "t1",
            title: "Read source",
            kind: "read",
            role: "worker",
            instruction: "Read source.txt.",
            allowed_tools: ["read_file"],
            depends_on: [],
            required: true,
          },
          {
            id: "t2",
            title: "Verify source",
            kind: "verify",
            role: "verifier",
            instruction: "Verify the source artifact exists and is non-empty.",
            allowed_tools: ["read_file"],
            depends_on: ["t1"],
            required: true,
          },
          {
            id: "t3",
            title: "Write result",
            kind: "write",
            role: "worker",
            instruction: "Write a short result file.",
            allowed_tools: ["write_file"],
            depends_on: ["t2"],
            required: true,
          },
        ],
        finish_when: {
          mode: "all_required_tasks_completed",
        },
      },
      routePolicy,
      undefined,
      createFakeRuntimeDeps({
        runExecutorStep: async (_cfg, planner, stepNumber) => {
          executorPlanners.push(planner);
          if (stepNumber === 1) {
            return {
              status: "success",
              summary: "Read source.txt",
              tool_calls_made: [{ tool: "read_file", arguments: { path: "source.txt" } }],
              artifacts: [{ type: "file", path: sourcePath, content_preview: "source content" }],
              raw_result: "source content",
              source: "native_tool",
            };
          }
          return {
            status: "success",
            summary: "Wrote result.md",
            tool_calls_made: [{ tool: "write_file", arguments: { path: "result.md", content: "ok" } }],
            artifacts: [{ type: "file", path: "result.md", content_preview: "ok" }],
            raw_result: "ok",
            source: "native_tool",
          };
        },
      }),
    );

    assert.equal(result.status, "completed");
    assert.equal(result.taskRuns.length, 3);
    assert.equal(result.taskRuns[1]?.status, "completed");
    assert.equal(result.taskRuns[1]?.verified, true);
    assert.equal(result.taskRuns[1]?.output.includes("PASS artifact_presence"), true);
    assert.equal(result.taskRuns[2]?.status, "completed");
    assert.equal(executorPlanners.length, 2);
  } finally {
    unlinkSync(sourcePath);
  }
});

test("workflow runtime fails verify tasks when dependency artifacts do not satisfy verifiers", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();

  const result = await runWorkflowPlan(
    config,
    "Read then verify",
    {
      id: "wf_verify_fail",
      strategy: "read_verify",
      summary: "Read without artifact output and fail verification.",
      tasks: [
        {
          id: "t1",
          title: "Read source",
          kind: "read",
          role: "worker",
          instruction: "Read source.txt.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Verify source",
          kind: "verify",
          role: "verifier",
          instruction: "Verify the source artifact exists and is non-empty.",
          allowed_tools: ["read_file"],
          depends_on: ["t1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async () => ({
        status: "success",
        summary: "Read source.txt without artifact output",
        tool_calls_made: [{ tool: "read_file", arguments: { path: "source.txt" } }],
        artifacts: [],
        raw_result: "source content",
        source: "native_tool",
      }),
    }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.taskRuns.length, 2);
  assert.equal(result.taskRuns[0]?.status, "completed");
  assert.equal(result.taskRuns[1]?.status, "failed");
  assert.equal(result.taskRuns[1]?.verified, false);
  assert.equal(result.taskRuns[1]?.output.includes("FAIL artifact_presence"), true);
});

test("workflow runtime honors retry_policy skip for failed tasks and continues dependents", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];

  const result = await runWorkflowPlan(
    config,
    "Retry policy skip workflow",
    {
      id: "wf_c3",
      strategy: "skip_on_failure",
      summary: "Skip a failed optional extract task and continue synthesis.",
      tasks: [
        {
          id: "t1",
          title: "Read source",
          kind: "read",
          role: "worker",
          instruction: "Read the source file.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: true,
        },
        {
          id: "t2",
          title: "Optional extract",
          kind: "extract",
          role: "worker",
          instruction: "Extract optional details.",
          allowed_tools: ["extract_text"],
          depends_on: ["t1"],
          required: false,
          retry_policy: {
            max_attempts: 1,
            on_failure: "skip",
          },
        },
        {
          id: "t3",
          title: "Synthesize result",
          kind: "synthesize",
          role: "synthesizer",
          instruction: "Synthesize from whatever reliable outputs are available.",
          allowed_tools: [],
          depends_on: ["t1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async (_cfg, planner, stepNumber) => {
        executorPlanners.push(planner);
        if (stepNumber === 1) {
          return {
            status: "success",
            summary: "Read source",
            tool_calls_made: [{ tool: "read_file", arguments: { path: "source.txt" } }],
            artifacts: [{ type: "file", path: "source.txt", content_preview: "source content" }],
            raw_result: "source content",
            source: "native_tool",
          };
        }
        return {
          status: "failed",
          summary: "Extraction failed",
          tool_calls_made: [{ tool: "extract_text", arguments: { content: "source content" } }],
          artifacts: [],
          raw_result: "",
          error: "parse failure",
          source: "native_tool",
        };
      },
      runTeamSynthesis: async () => "Synthesis after skipped optional task.",
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.taskRuns.length, 3);
  assert.equal(result.taskRuns[1]?.status, "skipped");
  assert.equal(result.taskRuns[2]?.status, "completed");
  assert.equal(result.output, "Synthesis after skipped optional task.");
  assert.equal(executorPlanners.length, 2);
});

test("workflow runtime executes fallback_task_id when a task fails", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];

  const result = await runWorkflowPlan(
    config,
    "Fallback workflow",
    {
      id: "wf_c4",
      strategy: "fallback_on_failure",
      summary: "Use a fallback task when the primary task fails.",
      tasks: [
        {
          id: "t1",
          title: "Primary fetch",
          kind: "fetch",
          role: "worker",
          instruction: "Fetch the primary source.",
          allowed_tools: ["url_fetch"],
          depends_on: [],
          required: true,
          retry_policy: {
            max_attempts: 1,
            on_failure: "fallback",
            fallback_task_id: "t_fallback",
          },
        },
        {
          id: "t_fallback",
          title: "Fallback read",
          kind: "read",
          role: "worker",
          instruction: "Read a local fallback artifact.",
          allowed_tools: ["read_file"],
          depends_on: [],
          required: false,
        },
        {
          id: "t2",
          title: "Synthesize result",
          kind: "synthesize",
          role: "synthesizer",
          instruction: "Synthesize from the available fetched content.",
          allowed_tools: [],
          depends_on: ["t1"],
          required: true,
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async (_cfg, planner) => {
        executorPlanners.push(planner);
        if (planner.executor_request?.allowed_tools[0] === "url_fetch") {
          return {
            status: "failed",
            summary: "Primary fetch failed",
            tool_calls_made: [{ tool: "url_fetch", arguments: { url: "https://example.com/primary" } }],
            artifacts: [],
            raw_result: "",
            error: "network failure",
            source: "native_tool",
          };
        }
        return {
          status: "success",
          summary: "Read fallback artifact",
          tool_calls_made: [{ tool: "read_file", arguments: { path: "fallback.txt" } }],
          artifacts: [{ type: "file", path: "fallback.txt", content_preview: "fallback content" }],
          raw_result: "fallback content",
          source: "native_tool",
        };
      },
      runTeamSynthesis: async () => "Synthesized from fallback content.",
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.taskRuns.length, 3);
  assert.equal(result.taskRuns[0]?.status, "completed");
  assert.equal(result.taskRuns[0]?.title.includes("fallback"), true);
  assert.equal(result.taskRuns[1]?.status, "skipped");
  assert.equal(result.taskRuns[2]?.status, "completed");
  assert.equal(result.output, "Synthesized from fallback content.");
  assert.equal(executorPlanners.length, 2);
  assert.equal(executorPlanners[0]?.executor_request?.allowed_tools[0], "url_fetch");
  assert.equal(executorPlanners[1]?.executor_request?.allowed_tools[0], "read_file");
});

test("workflow runtime replans when retry_policy requests replan", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const executorPlanners: PlannerOutput[] = [];
  const replanPrompts: string[] = [];
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];

  const result = await runWorkflowPlan(
    config,
    "Replan workflow",
    {
      id: "wf_replan_original",
      strategy: "primary_fetch",
      summary: "Try the primary fetch path first.",
      tasks: [
        {
          id: "t1",
          title: "Primary fetch",
          kind: "fetch",
          role: "worker",
          instruction: "Fetch the primary source.",
          allowed_tools: ["url_fetch"],
          depends_on: [],
          required: true,
          retry_policy: {
            max_attempts: 1,
            on_failure: "replan",
          },
        },
      ],
      finish_when: {
        mode: "all_required_tasks_completed",
      },
      replan_policy: {
        allow_runtime_replan: true,
        max_replans: 1,
      },
    },
    routePolicy,
    undefined,
    createFakeRuntimeDeps({
      runExecutorStep: async (_cfg, planner) => {
        executorPlanners.push(planner);
        if (planner.executor_request?.allowed_tools[0] === "url_fetch") {
          return {
            status: "failed",
            summary: "Primary source timed out",
            tool_calls_made: [{ tool: "url_fetch", arguments: { url: "https://example.com/primary" } }],
            artifacts: [],
            raw_result: "",
            error: "timeout",
            source: "native_tool",
          };
        }
        return {
          status: "success",
          summary: "Read local backup",
          tool_calls_made: [{ tool: "read_file", arguments: { path: "backup.txt" } }],
          artifacts: [{ type: "file", path: "backup.txt", content_preview: "backup evidence" }],
          raw_result: "backup evidence",
          source: "native_tool",
        };
      },
      runPlannerStep: async (_cfg, replanGoal) => {
        replanPrompts.push(replanGoal);
        return {
          goal: "Replan workflow",
          status: "workflow",
          reasoning_summary: "Switch to backup path",
          next_step: "Use local backup and synthesize",
          audit: { verdict: "approved", notes: "Primary fetch failed, use backup evidence." },
          workflow_plan: {
            id: "wf_replan_replacement",
            strategy: "backup_read_synthesize",
            summary: "Read backup evidence and synthesize the answer.",
            tasks: [
              {
                id: "r1",
                title: "Read backup",
                kind: "read",
                role: "worker",
                instruction: "Read the local backup artifact.",
                allowed_tools: ["read_file"],
                depends_on: [],
                required: true,
              },
              {
                id: "r2",
                title: "Synthesize backup result",
                kind: "synthesize",
                role: "synthesizer",
                instruction: "Synthesize from backup evidence.",
                allowed_tools: [],
                depends_on: ["r1"],
                required: true,
              },
            ],
            finish_when: {
              mode: "all_required_tasks_completed",
            },
          },
        };
      },
      runTeamSynthesis: async (_cfg, _goal, _resultsText, memorySummary) => {
        assert.equal(memorySummary.includes("Read local backup"), true);
        return "Synthesized from replanned backup.";
      },
    }),
    {
      onEvent: (event) => {
        events.push({ type: event.type, data: event.data });
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "Synthesized from replanned backup.");
  assert.equal(result.plan.summary?.includes("wf_replan_replacement"), true);
  assert.equal(result.plan.summary?.includes("wf_replan_original -> wf_replan_replacement"), true);
  assert.equal(result.taskRuns.length, 3);
  assert.equal(result.taskRuns[0]?.id, "wf_replan_original:t1");
  assert.equal(result.taskRuns[0]?.title.includes("superseded"), true);
  assert.equal(result.taskRuns[0]?.status, "failed");
  assert.equal(result.taskRuns[1]?.status, "completed");
  assert.equal(result.taskRuns[2]?.status, "completed");
  assert.equal(replanPrompts.length, 1);
  assert.equal(replanPrompts[0]?.includes("Failed task id: t1"), true);
  assert.equal(executorPlanners.length, 2);
  assert.equal(executorPlanners[0]?.executor_request?.allowed_tools[0], "url_fetch");
  assert.equal(executorPlanners[1]?.executor_request?.allowed_tools[0], "read_file");
  assert.equal(events.some((event) => event.type === "workflow.plan.replanned"), true);
  assert.equal(events.some((event) => event.type === "workflow.task.superseded" && event.data.task_id === "t1"), true);
});
