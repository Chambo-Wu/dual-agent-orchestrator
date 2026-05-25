import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../../src/index.js";
import { renderTimelineHtml } from "../../src/timeline.js";
import { normalizeWorkflowEvent } from "../../src/workflow-ui-events.js";
import type { StoredJobRecord } from "../../src/job-store.js";
import type { Artifact, Job, Plan, TaskRun } from "../../src/types.js";

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
