import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../../src/index.js";
import { renderTimelineHtml } from "../../src/timeline.js";
import { normalizeWorkflowEvent } from "../../src/workflow-ui-events.js";
import type { StoredJobRecord } from "../../src/job-store.js";
import type { Artifact, Job, Plan, TaskRun } from "../../src/types.js";

test("claude control messages are short-circuited before orchestration", () => {
  assert.equal(__testables.isClaudeControlMessage("/init"), true);
  assert.equal(__testables.isClaudeControlMessage("<command-message>init</command-message>\n<command-name>/init</command-name>"), true);
  assert.equal(__testables.isClaudeControlMessage("[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]"), true);
  assert.equal(__testables.isClaudeControlMessage("介绍一下这个项目"), false);

  const initResponse = __testables.buildClaudeControlResponse("/init");
  assert.equal(initResponse?.job.status, "completed");
  assert.equal(initResponse?.job.verified, true);
  assert.equal(initResponse?.taskRuns.length, 1);
  assert.equal(initResponse?.content.includes("ready"), true);

  const wrappedInitResponse = __testables.buildClaudeControlResponse("<command-message>init</command-message>\n<command-name>/init</command-name>");
  assert.equal(wrappedInitResponse?.job.status, "completed");
  assert.equal(wrappedInitResponse?.content.includes("ready"), true);

  const suggestionResponse = __testables.buildClaudeControlResponse("[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]");
  assert.equal(suggestionResponse?.job.status, "completed");
  assert.equal(suggestionResponse?.content, "");
});

function buildRecord(taskRuns: TaskRun[]): StoredJobRecord {
  const plan: Plan = {
    id: "plan_workflow_1",
    goal: "Test workflow summary",
    mode: "task",
    taskRunIds: taskRuns.map((taskRun) => taskRun.id),
    summary: "Workflow summary test.",
  };
  const job: Job = {
    id: "job_workflow_1",
    goal: "Test workflow summary",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan,
    taskRuns,
    artifacts: [],
  };
  return {
    savedAt: new Date().toISOString(),
    job,
    plan,
    taskRuns,
    artifacts: [] as Artifact[],
    control: {
      pendingApprovalId: "appr_1",
      approvalStatus: "pending",
    },
  };
}

test("buildJobResponse includes workflow summary with counts and current approval task", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [],
      attempts: 1,
    },
    {
      id: "task_waiting",
      title: "Approval task",
      description: "await approval",
      status: "awaiting_approval",
      assignee: "worker",
      dependsOn: ["task_done"],
      verified: false,
      output: "Waiting for approval.",
      artifacts: [],
      attempts: 0,
    },
    {
      id: "task_pending",
      title: "Pending task",
      description: "pending",
      status: "pending",
      assignee: "worker",
      dependsOn: ["task_waiting"],
      verified: false,
      output: "",
      artifacts: [],
      attempts: 0,
    },
  ]);

  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      workflow_id: string;
      task_counts: Record<string, number>;
      current_task: Record<string, unknown> | null;
      awaiting_approval_task: Record<string, unknown> | null;
    };
  };

  assert.equal(response.workflow_summary.workflow_id, "plan_workflow_1");
  assert.equal(response.workflow_summary.task_counts.completed, 1);
  assert.equal(response.workflow_summary.task_counts.awaiting_approval, 1);
  assert.equal(response.workflow_summary.task_counts.pending, 1);
  assert.equal(response.workflow_summary.current_task?.id, "task_waiting");
  assert.equal(response.workflow_summary.awaiting_approval_task?.id, "task_waiting");
});

test("buildStepList marks current and approval-blocked workflow steps", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [],
      attempts: 1,
    },
    {
      id: "task_waiting",
      title: "Approval task",
      description: "await approval",
      status: "awaiting_approval",
      assignee: "worker",
      dependsOn: ["task_done"],
      verified: false,
      output: "Waiting for approval.",
      artifacts: [],
      attempts: 0,
    },
    {
      id: "task_pending",
      title: "Pending task",
      description: "pending",
      status: "pending",
      assignee: "worker",
      dependsOn: ["task_waiting"],
      verified: false,
      output: "",
      artifacts: [],
      attempts: 0,
    },
  ]);

  const steps = __testables.buildStepList(record) as Array<{
    id: string;
    is_current_task: boolean;
    is_awaiting_approval_task: boolean;
    workflow_position: { index: number; total: number };
  }>;

  assert.equal(steps.length, 3);
  assert.equal(steps[0]?.workflow_position.index, 1);
  assert.equal(steps[0]?.workflow_position.total, 3);
  assert.equal(steps[1]?.id, "task_waiting");
  assert.equal(steps[1]?.is_current_task, true);
  assert.equal(steps[1]?.is_awaiting_approval_task, true);
  assert.equal(steps[2]?.is_current_task, false);
});

test("buildStepList exposes executor display summary when available", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [],
      attempts: 1,
      executorHistory: [{
        status: "success",
        summary: "Decision summary",
        display_summary: "Display summary",
        tool_calls_made: [],
        artifacts: [],
        raw_result: "raw detail",
        source: "model_text",
      }],
    },
  ]);

  const steps = __testables.buildStepList(record) as Array<{
    latest_executor_summary: string | null;
  }>;

  assert.equal(steps[0]?.latest_executor_summary, "Display summary");
});

test("buildJobEvents exposes artifact metadata for control-plane consumers", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [{
        id: "artifact_1",
        type: "file",
        path: "runtime/source.txt",
        contentPreview: "source",
        source: "executor",
        trustLevel: "high",
        sourceTaskRunId: "task_done",
        relatedTaskRunId: "task_done",
        relatedStep: 2,
      }],
      attempts: 1,
    },
  ]);
  record.artifacts = record.taskRuns.flatMap((taskRun) => taskRun.artifacts);

  const events = __testables.buildJobEvents(record);
  const artifactEvent = events.find((event) => event.type === "artifact.created");

  assert.equal(artifactEvent?.meta.trust_level, "high");
  assert.equal(artifactEvent?.meta.related_task_run_id, "task_done");
  assert.equal(artifactEvent?.meta.related_step, 2);
});

test("buildJobEvents classifies failure categories for blocked and failed records", () => {
  const record = buildRecord([
    {
      id: "task_failed",
      title: "Failed task",
      description: "failed",
      status: "failed",
      assignee: "worker",
      dependsOn: [],
      verified: false,
      output: "Verification failed because the report file is missing.",
      artifacts: [],
      attempts: 1,
      executorHistory: [{
        status: "failed",
        summary: "Fetch failed",
        tool_calls_made: [{ tool: "url_fetch", arguments: { url: "https://example.com" } }],
        artifacts: [],
        raw_result: "",
        error: "HTTP 403: Forbidden",
        source: "native_tool",
      }],
    },
  ]);
  record.job.status = "blocked";
  record.job.output = "Execution was interrupted by a service restart. The job can be resumed from the control plane.";
  record.control = {
    recoveredAt: new Date().toISOString(),
    recoveryReason: "service_restart",
  };

  const events = __testables.buildJobEvents(record);
  const stepEvent = events.find((event) => event.type === "step.failed");
  const executorEvent = events.find((event) => event.type === "executor.failed");
  const recoveryEvent = events.find((event) => event.type === "job.recovered");

  assert.equal(stepEvent?.meta.failure_category, "verification_failure");
  assert.equal(executorEvent?.meta.failure_category, "tool_failure");
  assert.equal(recoveryEvent?.meta.failure_category, "environment_failure");
});

test("timeline html renders workflow summary details in the header", () => {
  const html = renderTimelineHtml(
    "job_workflow_1",
    [],
    "Test workflow summary",
    "awaiting_approval",
    {
      current_task: {
        id: "task_waiting",
        title: "Approval task",
        status: "awaiting_approval",
      },
      awaiting_approval_task: {
        title: "Approval task",
        status: "awaiting_approval",
      },
      task_counts: {
        pending: 1,
        in_progress: 0,
        awaiting_approval: 1,
        completed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
      },
    },
  );

  assert.equal(html.includes("Current: Approval task (awaiting_approval)"), true);
  assert.equal(html.includes("Approval: Approval task"), true);
  assert.equal(html.includes("Tasks: 1 completed, 1 awaiting approval, 0 in progress, 1 pending"), true);
});

test("timeline html renders failure summary details in the header and event tags", () => {
  const html = renderTimelineHtml(
    "job_failure_1",
    [{
      id: "evt_1",
      jobId: "job_failure_1",
      seq: 1,
      time: new Date().toISOString(),
      agent: "system",
      phase: "result",
      type: "system.verification_failed",
      title: "Verification reported issues",
      summary: "Verification reported issues because artifact output is missing.",
      status: "blocked",
      meta: {
        failure_category: "verification_failure",
      },
    }],
    "Failure summary test",
    "blocked",
  );

  assert.equal(html.includes("Issues: 1 total"), true);
  assert.equal(html.includes("Verification failure: 1"), true);
  assert.equal(html.includes("Latest issue: Verification issue"), true);
  assert.equal(html.includes('title="verification_failure">Verification failure</span>'), true);
});

test("timeline html renders runtime analysis summaries", () => {
  const html = renderTimelineHtml(
    "job_analysis_1",
    [
      {
        id: "evt_1",
        jobId: "job_analysis_1",
        seq: 1,
        time: new Date().toISOString(),
        agent: "tool",
        phase: "start",
        type: "tool.start",
        title: "Tool started",
        summary: "web_search started.",
        status: "running",
        meta: { tool: "web_search" },
      },
      {
        id: "evt_2",
        jobId: "job_analysis_1",
        seq: 2,
        time: new Date().toISOString(),
        agent: "verifier",
        phase: "result",
        type: "system.verification_failed",
        title: "Verification reported issues",
        summary: "Verification reported issues because artifact output is missing.",
        status: "blocked",
        meta: {
          tool: "read_file",
          failure_category: "verification_failure",
        },
      },
      {
        id: "evt_3",
        jobId: "job_analysis_1",
        seq: 3,
        time: new Date().toISOString(),
        agent: "verifier",
        phase: "result",
        type: "system.verification_check_insufficient",
        title: "Verification check insufficient",
        summary: "artifact_presence: Tool calls were made but no artifacts were produced.",
        status: "blocked",
        taskRunId: "t2",
        meta: {
          verification_check_name: "artifact_presence",
          verification_check_status: "insufficient",
          verification_status: "insufficient",
          failure_category: "verification_failure",
          related_artifact_ids: ["artifact_report_1"],
        },
      },
      {
        id: "evt_4",
        jobId: "job_analysis_1",
        seq: 4,
        time: new Date().toISOString(),
        agent: "system",
        phase: "result",
        type: "artifact.created",
        title: "Artifact created",
        summary: "Artifact saved to runtime/command-results/report.md.",
        status: "success",
        taskRunId: "t2",
        meta: {
          artifact_id: "artifact_report_1",
          related_task_run_id: "t2",
        },
      },
    ],
    "Runtime analysis test",
    "blocked",
    {
      dag: {
        workflow_count: 1,
        edge_count: 0,
        workflows: [
          {
            workflow_id: "wf_analysis",
            status: "active",
            task_count: 2,
            completed_count: 1,
            tasks: [
              {
                id: "t1",
                task_id: "t1",
                title: "Collect evidence",
                status: "completed",
                assignee: "worker",
                depends_on: [],
                verified: false,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t2",
                task_id: "t2",
                title: "Verify artifact",
                status: "completed",
                assignee: "verifier",
                depends_on: ["t1"],
                verified: true,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
            ],
          },
        ],
      },
      replan_history: [],
    },
  );

  assert.equal(html.includes("Workflow Analysis"), true);
  assert.equal(html.includes("Runtime Analysis"), true);
  assert.equal(html.includes("Verification: 0 passed, 1 failed"), true);
  assert.equal(html.includes("Artifact output"), true);
  assert.equal(html.includes("Artifacts created"), true);
  assert.equal(html.includes("Verification failed"), true);
  assert.equal(html.includes("Verification checks"), true);
  assert.equal(html.includes("artifact_presence"), true);
  assert.equal(html.includes("Tool activity"), true);
  assert.equal(html.includes("web_search"), true);
  assert.equal(html.includes("Common issues"), true);
  assert.equal(html.includes("verification_failure"), true);
  assert.equal(html.includes('data-analysis-filter="verifier"'), true);
  assert.equal(html.includes('data-analysis-filter="verification_check"'), true);
  assert.equal(html.includes('data-analysis-filter="artifact"'), true);
  assert.equal(html.includes('data-analysis-filter="tool"'), true);
  assert.equal(html.includes('data-analysis-filter="failure_category"'), true);
  assert.equal(html.includes('data-event-type="system.verification_failed"'), true);
  assert.equal(html.includes('data-event-type="system.verification_check_insufficient"'), true);
  assert.equal(html.includes('data-verification-check-name="artifact_presence"'), true);
  assert.equal(html.includes('data-verification-check-status="insufficient"'), true);
  assert.equal(html.includes('data-related-artifact-ids="artifact_report_1"'), true);
  assert.equal(html.includes('data-event-type="artifact.created"'), true);
  assert.equal(html.includes('data-artifact-id="artifact_report_1"'), true);
  assert.equal(html.includes('data-task-run-id="t2"'), true);
  assert.equal(html.includes('data-related-task-run-id="t2"'), true);
  assert.equal(html.includes('data-event-tool="web_search"'), true);
  assert.equal(html.includes('data-failure-category="verification_failure"'), true);
  assert.equal(html.includes('data-assignee="verifier"'), true);
  assert.equal(html.includes('data-verified="true"'), true);
  assert.equal(html.includes('data-clear-analysis-filter'), true);
  assert.equal(html.includes("Show all events"), true);
  assert.equal(html.includes("is-analysis-match"), true);
});

test("timeline html renders dependency graph lanes with SVG edges", () => {
  const html = renderTimelineHtml(
    "job_graph_1",
    [],
    "Graph workflow",
    "running",
    {
      task_counts: {
        pending: 0,
        in_progress: 1,
        awaiting_approval: 0,
        completed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
      },
      dag: {
        workflow_count: 1,
        edge_count: 2,
        workflows: [
          {
            workflow_id: "wf_graph",
            status: "active",
            task_count: 3,
            completed_count: 1,
            tasks: [
              {
                id: "t1",
                task_id: "t1",
                title: "Collect evidence",
                status: "completed",
                assignee: "worker",
                depends_on: [],
                verified: true,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t2",
                task_id: "t2",
                title: "Verify evidence",
                status: "completed",
                assignee: "verifier",
                depends_on: ["t1"],
                verified: true,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t3",
                task_id: "t3",
                title: "Write report",
                status: "in_progress",
                assignee: "worker",
                depends_on: ["t2"],
                verified: false,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
            ],
          },
        ],
      },
      replan_history: [],
    },
  );

  assert.equal(html.includes("workflow-graph"), true);
  assert.equal(html.includes("graph-svg"), true);
  assert.equal(html.includes("graph-edge"), true);
  assert.equal(html.includes("Stage 1"), true);
  assert.equal(html.includes("Stage 2"), true);
  assert.equal(html.includes('data-workflow-id="wf_graph"'), true);
  assert.equal(html.includes('data-task-id="t3"'), true);
  assert.equal(html.includes('data-from="t1"'), true);
  assert.equal(html.includes('data-to="t2"'), true);
  assert.equal(html.includes("is-current-task"), true);
  assert.equal(html.includes("initializeWorkflowInteractions"), true);
});

test("timeline html renders replan history focus hooks", () => {
  const html = renderTimelineHtml(
    "job_graph_2",
    [],
    "Graph workflow with replan",
    "running",
    {
      current_task: {
        id: "t2",
        title: "Replacement task",
        status: "in_progress",
      },
      dag: {
        workflow_count: 2,
        edge_count: 1,
        workflows: [
          {
            workflow_id: "wf_old",
            status: "superseded",
            superseded_by: "wf_new",
            task_count: 1,
            completed_count: 0,
            tasks: [
              {
                id: "t1",
                task_id: "t1",
                title: "Old task",
                status: "failed",
                assignee: "worker",
                depends_on: [],
                verified: false,
                attempts: 1,
                superseded: true,
                superseded_by: "wf_new",
              },
            ],
          },
          {
            workflow_id: "wf_new",
            status: "active",
            task_count: 1,
            completed_count: 0,
            tasks: [
              {
                id: "t2",
                task_id: "t2",
                title: "Replacement task",
                status: "in_progress",
                assignee: "worker",
                depends_on: [],
                verified: false,
                attempts: 0,
                superseded: false,
                superseded_by: null,
              },
            ],
          },
        ],
      },
      replan_history: [
        {
          index: 1,
          superseded_workflow_id: "wf_old",
          replacement_workflow_id: "wf_new",
          failed_task_id: "t1",
        },
      ],
    },
  );

  assert.equal(html.includes('data-superseded-workflow-id="wf_old"'), true);
  assert.equal(html.includes('data-replacement-workflow-id="wf_new"'), true);
  assert.equal(html.includes('class="workflow-lane superseded" data-workflow-id="wf_old"'), true);
  assert.equal(html.includes('data-clear-workflow-focus'), true);
  assert.equal(html.includes('Show all lanes'), true);
  assert.equal(html.includes('clearWorkflowFocus'), true);
  assert.equal(html.includes('applyWorkflowFocus'), true);
  assert.equal(html.includes("workflowFocus"), true);
  assert.equal(html.includes("history.replaceState"), true);
  assert.equal(html.includes('history-item.is-focused'), true);
  assert.equal(html.includes('data-focus-state'), true);
  assert.equal(html.includes('data-focus-hint'), true);
  assert.equal(html.includes('Focused: superseded lane'), true);
  assert.equal(html.includes('Focused: replacement lane'), true);
  assert.equal(html.includes('Click again to switch to replacement lane'), true);
});

test("workflow UI normalizes replanned and superseded events", () => {
  const replanned = normalizeWorkflowEvent({
    type: "workflow.plan.replanned",
    step: 2,
    data: {
      workflow_id: "wf_old",
      replacement_workflow_id: "wf_new",
      task_id: "t1",
      replan_count: 1,
    },
  }, "job_1", 1);
  const superseded = normalizeWorkflowEvent({
    type: "workflow.task.superseded",
    step: 2,
    data: {
      task_id: "t1",
      title: "Old task",
      role: "worker",
      replacement_workflow_id: "wf_new",
    },
  }, "job_1", 2);

  assert.equal(replanned.type, "planner.workflow_plan_replanned");
  assert.equal(replanned.summary.includes("wf_old"), true);
  assert.equal(superseded.type, "workflow.task.superseded");
  assert.equal(superseded.summary.includes("wf_new"), true);
});

test("workflow UI classifies replan rejections and verification failures", () => {
  const replanRejected = normalizeWorkflowEvent({
    type: "workflow.replan.rejected",
    step: 2,
    data: {
      workflow_id: "wf_old",
      replacement_workflow_id: "wf_new",
      task_id: "t1",
      issues: ["replacement workflow schema validation failed"],
    },
  }, "job_1", 3);
  const verificationFailed = normalizeWorkflowEvent({
    type: "system.verification_failed",
    step: 3,
    data: {
      verification_status: "failed",
      verifier_count: 2,
      summary: "Verification reported issues because artifact output is missing.",
    },
  }, "job_1", 4);

  assert.equal(replanRejected.type, "planner.workflow_replan_rejected");
  assert.equal(replanRejected.meta.failure_category, "validation_failure");
  assert.equal(verificationFailed.meta.failure_category, "verification_failure");
});

test("workflow UI normalizes verification check events", () => {
  const check = normalizeWorkflowEvent({
    type: "system.verification_check_insufficient",
    step: 3,
    data: {
      task_id: "t_verify",
      title: "Verify artifact",
      kind: "verify",
      role: "verifier",
      verification_check_name: "artifact_presence",
      verification_check_status: "insufficient",
      verification_status: "insufficient",
      verification_source: "task_run",
      passed: false,
      detail: "Tool calls were made but no artifacts were produced.",
    },
  }, "job_1", 5);

  assert.equal(check.agent, "verifier");
  assert.equal(check.status, "blocked");
  assert.equal(check.taskRunId, "t_verify");
  assert.equal(check.meta.verification_check_name, "artifact_presence");
  assert.equal(check.meta.failure_category, "verification_failure");
});

test("workflow UI prefers normalized planner and executor contract fields", () => {
  const planner = normalizeWorkflowEvent({
    type: "workflow.planner.decision",
    step: 1,
    data: {
      status: "final",
      reasoning_summary: "internal reasoning",
      next_step: "next step",
      decision_text: "Final consumer-facing answer",
    },
  }, "job_1", 1);
  const executor = normalizeWorkflowEvent({
    type: "workflow.executor.result",
    step: 1,
    data: {
      status: "success",
      summary: "Decision summary",
      display_summary: "Display summary",
    },
  }, "job_1", 2);

  assert.equal(planner.summary, "Final consumer-facing answer");
  assert.equal(executor.summary, "Display summary");
});
