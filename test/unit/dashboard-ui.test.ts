import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml, type DashboardData } from "../../src/dashboard.js";
import { renderJobsDashboardHtml } from "../../src/jobs-dashboard.js";
import { renderGoalsDashboardHtml } from "../../src/goals-dashboard.js";
import { renderGoalTimelineHtml } from "../../src/goal-timeline.js";

test("run dashboard html renders intent route callout", () => {
  const html = renderDashboardHtml({
    runId: "run_123",
    goal: "Implement a routing layer",
    startedAt: "2026-05-28T10:00:00.000Z",
    completedAt: "2026-05-28T10:05:00.000Z",
    tasks: [],
    trace: [],
    summary: {
      totalTasks: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      tools: 0,
      loops: 0,
      artifacts: 0,
    },
    intentRoute: {
      kind: "goal",
      reason: "team CLI mode selected",
      source: "heuristic",
    },
  } satisfies DashboardData);

  assert.equal(html.includes("Intent Route:"), true);
  assert.equal(html.includes("Goal (heuristic)"), true);
  assert.equal(html.includes("team CLI mode selected"), true);
});

test("jobs dashboard html renders intent route and status toggle wiring", () => {
  const html = renderJobsDashboardHtml([{
    id: "job_123",
    goal: "Fix the broken API route",
    mode: "task",
    status: "running",
    saved_at: "2026-05-28T10:00:00.000Z",
    verified: false,
    artifact_count: 2,
    step_count: 3,
    latest_step: {
      status: "in_progress",
      latest_executor_status: "success",
    },
    intent_route: {
      kind: "coding",
      reason: "matched engineering language",
      source: "heuristic",
    },
    actions: [],
    timeline_url: "/v1/jobs/job_123/timeline",
    events_url: "/v1/jobs/job_123/events",
    stream_url: "/v1/jobs/job_123/stream",
    workflow_summary: {
      skill_evolution: {
        proposal_count: 2,
        latest_proposal_id: "proposal_123",
        latest_status: "accepted",
        latest_patch_summary: "find.code_symbol: discovery -> append_appendix",
        latest_ops_summary: {
          queue_state: "accepted_history",
          funnel_stage: "accepted",
          age_bucket: "under_1h",
          auto_accept_eligible: false,
          eligibility_reasons: ["dynamic risk blocks auto-accept"],
          dynamic_risk_tier: "high",
          dynamic_risk_cooldown_active: true,
          dynamic_risk_cooldown_until: "2026-05-31T00:00:00.000Z",
          effective_automation_ceiling: "auto_validate",
          stuck_state: {
            stuck: true,
            reasons: ["validated but not auto-accept eligible"],
          },
          rollback_available: true,
        },
      },
    },
  }]);

  assert.equal(html.includes("formatIntentRouteLabel(item.intent_route.kind)"), true);
  assert.equal(html.includes("matched engineering language"), false);
  assert.equal(html.includes("Intent route"), true);
  assert.equal(html.includes("id=\"route-filter\""), true);
  assert.equal(html.includes("All routes"), true);
  assert.equal(html.includes("id=\"route-summary\""), true);
  assert.equal(html.includes("id=\"loading-banner\""), true);
  assert.equal(html.includes("loadingBanner.hidden = !loading"), true);
  assert.equal(html.includes("Direct Answer"), true);
  assert.equal(html.includes("Research"), true);
  assert.equal(html.includes("Goal"), true);
  assert.equal(html.includes("Coding"), true);
  assert.equal(html.includes("data-route-card"), true);
  assert.equal(html.includes("activeRouteFilter === nextRoute ? '' : nextRoute"), true);
  assert.equal(html.includes("routeFilter.value = activeRouteFilter"), true);
  assert.equal(html.includes("page = 1;"), true);
  assert.equal(html.includes("void refreshJobs();"), true);
  assert.equal(html.includes("activeStatusTab = nextStatus"), true);
  assert.equal(html.includes("statusFilter.value = activeStatusTab"), true);
  assert.equal(html.includes("url.searchParams.set('page_size', String(pageSize));"), true);
  assert.equal(html.includes("formatSkillEvolution(item)"), true);
  assert.equal(html.includes("Skill evolution"), true);
  assert.equal(html.includes("Ops: "), true);
  assert.equal(html.includes("Eligibility: "), true);
  assert.equal(html.includes("Dynamic risk: "), true);
  assert.equal(html.includes("Cooldown: "), true);
  assert.equal(html.includes("Stuck: "), true);
  assert.equal(html.includes("accepted_history"), false);
});

test("jobs dashboard html resets persisted browser filters and renders all job states", () => {
  const html = renderJobsDashboardHtml([
    {
      id: "job_running",
      goal: "Running job",
      mode: "task",
      status: "running",
      saved_at: "2026-05-28T10:00:00.000Z",
      verified: false,
      artifact_count: 0,
      step_count: 1,
      actions: [],
    },
    {
      id: "job_completed",
      goal: "Completed job",
      mode: "task",
      status: "completed",
      saved_at: "2026-05-28T10:01:00.000Z",
      verified: true,
      artifact_count: 1,
      step_count: 1,
      actions: [],
    },
    {
      id: "job_failed",
      goal: "Failed job",
      mode: "task",
      status: "failed",
      saved_at: "2026-05-28T10:02:00.000Z",
      verified: false,
      artifact_count: 0,
      step_count: 1,
      actions: [],
    },
    {
      id: "job_approval",
      goal: "Approval job",
      mode: "team",
      status: "awaiting_approval",
      saved_at: "2026-05-28T10:03:00.000Z",
      verified: false,
      artifact_count: 0,
      step_count: 1,
      actions: [],
    },
  ]);

  assert.equal(html.includes('select id="status-filter" autocomplete="off"'), true);
  assert.equal(html.includes("statusFilter.value = '';"), true);
  assert.equal(html.includes("routeFilter.value = '';"), true);
  assert.equal(html.includes("let pageSize = 50;"), true);
  assert.equal(html.includes("let jobs = [];"), true);
  assert.equal(html.includes("activeStatusTab = nextStatus"), true);
  assert.equal(html.includes("buildDataUrl()"), true);
  assert.equal(html.includes("url.searchParams.set('page', String(page));"), true);
  assert.equal(html.includes("url.searchParams.set('page_size', String(pageSize));"), true);
  assert.equal(html.includes("Page ' + page + ' of ' + totalPages"), true);
  assert.equal(html.includes("Running job"), false);
  assert.equal(html.includes("Completed job"), false);
  assert.equal(html.includes("Failed job"), false);
  assert.equal(html.includes("Approval job"), false);
});

test("goals dashboard html renders goal actions and filters", () => {
  const html = renderGoalsDashboardHtml([{
    id: "goal_123",
    goal: "Ship goal mode browser visibility",
    status: "ready",
    created_at: "2026-05-29T01:00:00.000Z",
    updated_at: "2026-05-29T02:00:00.000Z",
    completed_task_count: 1,
    total_task_count: 3,
    current_task: {
      id: "task_1",
      title: "Wire timeline route",
      status: "pending",
      mode: "task",
    },
    final_review_status: "pending",
    timeline_url: "/v1/goals/goal_123/timeline",
    events_url: "/v1/goals/goal_123/events",
    detail_url: "/v1/goals/goal_123",
    actions: [
      { label: "Timeline", href: "/v1/goals/goal_123/timeline", kind: "link", emphasis: "primary" },
      { label: "Run Next", href: "/v1/goals/goal_123/run-next", kind: "api", method: "POST" },
    ],
  }], {
    dataUrl: "/goals/data",
  });

  assert.equal(html.includes("Goal Dashboard"), true);
  assert.equal(html.includes("/v1/goals/goal_123/timeline"), true);
  assert.equal(html.includes("Run Next"), true);
  assert.equal(html.includes("status-filter"), true);
  assert.equal(html.includes("/goals/data"), true);
});

test("goal timeline html renders controls and events", () => {
  const html = renderGoalTimelineHtml({
    id: "goal_123",
    goal: "Ship the goal timeline",
    status: "running",
    createdAt: "2026-05-29T01:00:00.000Z",
    updatedAt: "2026-05-29T02:00:00.000Z",
    currentTaskId: "task_1",
    completedTaskCount: 0,
    tasks: [{
      id: "task_1",
      title: "Build route",
      description: "Add /v1/goals/:id/timeline",
      mode: "task",
      kind: "goal_task",
      status: "running",
      updatedAt: "2026-05-29T02:00:00.000Z",
    }],
    runHistory: [],
    finalReview: {
      status: "pending",
    },
  }, [{
    id: "evt_1",
    time: "2026-05-29T02:00:00.000Z",
    type: "goal.run_next_started",
    title: "Run-next started",
    summary: "Starting goal task Build route.",
    status: "running",
    meta: {
      goal_id: "goal_123",
      task_id: "task_1",
    },
  }], {
    routeBasePath: "/v1/goals",
    apiBasePath: "/v1/goals",
  });

  assert.equal(html.includes("Goal Timeline"), true);
  assert.equal(html.includes("/v1/goals/goal_123/run-next"), true);
  assert.equal(html.includes("goal.run_next_started"), true);
  assert.equal(html.includes("Build route"), true);
});
