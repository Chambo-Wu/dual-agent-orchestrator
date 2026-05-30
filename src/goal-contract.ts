import { readGoalEvents } from "./goal-store.js";
import type { GoalEventRecord, GoalRecord } from "./goal-types.js";

function buildGoalControlSummary(record: GoalRecord, events: GoalEventRecord[]): Record<string, unknown> {
  const nextPendingTask = record.tasks.find((task) => task.status === "pending");
  const blockedTask = record.tasks.find((task) => task.status === "blocked");
  const latestEvent = events.at(-1) ?? null;
  return {
    next_action: record.status === "waiting_review"
      ? "review"
      : blockedTask
        ? "resume_or_retry"
        : nextPendingTask
          ? "run_next"
          : record.status === "completed"
            ? "none"
            : "review",
    next_task_id: nextPendingTask?.id ?? null,
    blocked_task_id: blockedTask?.id ?? null,
    latest_event_type: latestEvent?.type ?? null,
    latest_event_summary: latestEvent?.summary ?? null,
  };
}

export function buildGoalResponse(record: GoalRecord): Record<string, unknown> {
  const events = readGoalEvents(record.id);
  return {
    object: "goal",
    goal: record,
    tasks: record.tasks,
    run_history: record.runHistory,
    final_review: record.finalReview,
    control: buildGoalControlSummary(record, events),
    recent_events: events.slice(-10),
    files: {
      goal_json: `/runtime/goals/${record.id}/goal.json`,
      input_md: `/runtime/goals/${record.id}/input.md`,
      plan_md: `/runtime/goals/${record.id}/plan.md`,
      tasks_md: `/runtime/goals/${record.id}/tasks.md`,
      events_jsonl: `/runtime/goals/${record.id}/events.jsonl`,
    },
    links: {
      self: `/v1/goals/${record.id}`,
      events: `/v1/goals/${record.id}/events`,
      run_next: `/v1/goals/${record.id}/run-next`,
      retry: `/v1/goals/${record.id}/retry`,
      resume: `/v1/goals/${record.id}/resume`,
      review: `/v1/goals/${record.id}/review`,
    },
  };
}
