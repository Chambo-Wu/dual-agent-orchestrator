import type { GoalRecord, GoalTask, GoalTaskStatus } from "./goal-types.js";
import { readGoal, updateGoal } from "./goal-store.js";

export interface GoalTaskExecutionPayload {
  job: {
    id: string;
    status: "completed" | "failed" | "blocked";
    verified: boolean;
    output: string;
    verificationResult?: {
      summary: string;
    };
  };
}

export interface GoalRuntimeDeps {
  executeByMode: (
    mode: "task" | "team",
    goal: string,
    model: string | undefined,
  ) => Promise<GoalTaskExecutionPayload | {
    job: {
      id: string;
      status: string;
      verified: boolean;
      output: string;
      verificationResult?: {
        summary: string;
      };
    };
  }>;
}

export interface GoalRunNextResult {
  goal: GoalRecord;
  executedTask: GoalTask;
  execution: GoalTaskExecutionPayload;
}

export interface GoalReviewResult {
  goal: GoalRecord;
  execution: GoalTaskExecutionPayload;
}

function normalizeExecutionPayload(
  execution: GoalTaskExecutionPayload | {
    job: {
      id: string;
      status: string;
      verified: boolean;
      output: string;
      verificationResult?: {
        summary: string;
      };
    };
  },
): GoalTaskExecutionPayload {
  return {
    job: {
      id: execution.job.id,
      status: execution.job.status === "completed" ? "completed" : execution.job.status === "blocked" ? "blocked" : "failed",
      verified: execution.job.verified,
      output: execution.job.output,
      verificationResult: execution.job.verificationResult,
    },
  };
}

function summarizeVerification(payload: GoalTaskExecutionPayload): string {
  if (payload.job.verificationResult?.summary?.trim()) {
    return payload.job.verificationResult.summary.trim();
  }
  return payload.job.verified ? "verified" : "verification_not_available";
}

function summarizeOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function findNextPendingTask(record: GoalRecord): GoalTask | null {
  return record.tasks.find((task) => task.status === "pending") ?? null;
}

function findRetryableTask(record: GoalRecord): GoalTask | null {
  return [...record.tasks].reverse().find((task) => task.status === "failed" || task.status === "blocked") ?? null;
}

function findResumableTask(record: GoalRecord): GoalTask | null {
  return record.tasks.find((task) => task.status === "blocked") ?? null;
}

function deriveGoalStatus(tasks: GoalTask[]): GoalRecord["status"] {
  const completedTaskCount = tasks.filter((task) => task.status === "completed").length;
  const hasPending = tasks.some((task) => task.status === "pending");
  const hasBlocked = tasks.some((task) => task.status === "blocked");
  const hasFailed = tasks.some((task) => task.status === "failed");
  if (hasPending) {
    return hasBlocked ? "blocked" : hasFailed ? "failed" : "ready";
  }
  if (completedTaskCount === tasks.length && tasks.length > 0) {
    return "waiting_review";
  }
  return hasBlocked ? "blocked" : hasFailed ? "failed" : "ready";
}

async function executeGoalTask(
  goalId: string,
  taskId: string,
  deps: GoalRuntimeDeps,
  model: string | undefined,
  allowedStatuses: GoalTaskStatus[],
): Promise<GoalRunNextResult> {
  const snapshot = readGoal(goalId);
  if (!snapshot) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const nextTask = snapshot.tasks.find((task) => task.id === taskId) ?? null;
  if (!nextTask) {
    throw new Error(`Goal task not found: ${taskId}`);
  }
  if (!allowedStatuses.includes(nextTask.status)) {
    throw new Error(`Goal task is not executable in current state: ${nextTask.status}`);
  }

  const runningRecord = updateGoal(goalId, (record) => {
    const now = new Date().toISOString();
    return {
      ...record,
      status: "running",
      currentTaskId: nextTask.id,
      updatedAt: now,
      tasks: record.tasks.map((task) =>
        task.id === nextTask.id
          ? { ...task, status: "running", updatedAt: now }
          : task),
    };
  });
  if (!runningRecord) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const execution = normalizeExecutionPayload(await deps.executeByMode(nextTask.mode, nextTask.description, model));
  const now = new Date().toISOString();
  const taskStatus: GoalTaskStatus = execution.job.status === "completed"
    ? "completed"
    : execution.job.status === "blocked"
      ? "blocked"
      : "failed";

  const updatedRecord = updateGoal(goalId, (record) => {
    const tasks: GoalTask[] = record.tasks.map((task) => {
      if (task.id !== nextTask.id) {
        return task;
      }
      return {
        ...task,
        status: taskStatus,
        lastJobId: execution.job.id,
        outputSummary: summarizeOutput(execution.job.output),
        verificationSummary: summarizeVerification(execution),
        completedAt: taskStatus === "completed" ? now : task.completedAt,
        updatedAt: now,
      };
    });
    const completedTaskCount = tasks.filter((task) => task.status === "completed").length;
    return {
      ...record,
      tasks,
      currentTaskId: undefined,
      completedTaskCount,
      updatedAt: now,
      status: deriveGoalStatus(tasks),
      runHistory: [
        ...record.runHistory,
        {
          jobId: execution.job.id,
          taskId: nextTask.id,
          mode: nextTask.mode,
          status: execution.job.status,
          verified: execution.job.verified,
          createdAt: now,
        },
      ],
    };
  });

  if (!updatedRecord) {
    throw new Error(`Goal not found after execution: ${goalId}`);
  }

  const executedTask = updatedRecord.tasks.find((task) => task.id === nextTask.id);
  if (!executedTask) {
    throw new Error(`Executed task missing from goal: ${nextTask.id}`);
  }

  return {
    goal: updatedRecord,
    executedTask,
    execution,
  };
}

export async function runNextGoalTask(
  goalId: string,
  deps: GoalRuntimeDeps,
  model?: string,
): Promise<GoalRunNextResult> {
  const snapshot = readGoal(goalId);
  if (!snapshot) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const nextTask = findNextPendingTask(snapshot);
  if (!nextTask) {
    throw new Error(`Goal has no pending tasks: ${goalId}`);
  }
  return executeGoalTask(goalId, nextTask.id, deps, model, ["pending"]);
}

export async function retryGoalTask(
  goalId: string,
  deps: GoalRuntimeDeps,
  model?: string,
): Promise<GoalRunNextResult> {
  const snapshot = readGoal(goalId);
  if (!snapshot) {
    throw new Error(`Goal not found: ${goalId}`);
  }
  const retryable = findRetryableTask(snapshot);
  if (!retryable) {
    throw new Error(`Goal has no retryable tasks: ${goalId}`);
  }
  return executeGoalTask(goalId, retryable.id, deps, model, ["failed", "blocked"]);
}

export function resumeGoal(goalId: string): GoalRecord {
  const updated = updateGoal(goalId, (record) => {
    const resumable = findResumableTask(record);
    if (!resumable) {
      throw new Error(`Goal has no resumable tasks: ${goalId}`);
    }
    const now = new Date().toISOString();
    return {
      ...record,
      status: "ready",
      updatedAt: now,
      currentTaskId: resumable.id,
      tasks: record.tasks.map((task) =>
        task.id === resumable.id
          ? {
              ...task,
              status: "pending",
              notes: task.notes?.trim()
                ? `${task.notes} Resumed at ${now}.`
                : `Resumed at ${now}.`,
              updatedAt: now,
            }
          : task),
    };
  });
  if (!updated) {
    throw new Error(`Goal not found: ${goalId}`);
  }
  return updated;
}

export async function reviewGoal(
  goalId: string,
  deps: GoalRuntimeDeps,
  model?: string,
): Promise<GoalReviewResult> {
  const snapshot = readGoal(goalId);
  if (!snapshot) {
    throw new Error(`Goal not found: ${goalId}`);
  }
  if (snapshot.tasks.some((task) => task.status !== "completed")) {
    throw new Error(`Goal is not ready for final review: ${goalId}`);
  }
  if (snapshot.finalReview.status === "completed" || snapshot.status === "completed") {
    throw new Error(`Goal final review already completed: ${goalId}`);
  }

  const updated = updateGoal(goalId, (record) => ({
    ...record,
    status: "running",
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const reviewPrompt = [
    `Goal: ${snapshot.goal}`,
    "",
    "Completed tasks:",
    ...snapshot.tasks.map((task, index) => `${index + 1}. ${task.title}: ${task.outputSummary || task.description}`),
    "",
    "Produce a final review summarizing completed work, verification confidence, and remaining risks.",
  ].join("\n");
  const execution = normalizeExecutionPayload(await deps.executeByMode("task", reviewPrompt, model));
  const now = new Date().toISOString();
  const nextStatus: GoalRecord["status"] = execution.job.status === "completed"
    ? "completed"
    : execution.job.status === "blocked"
      ? "blocked"
      : "failed";
  const reviewed = updateGoal(goalId, (record) => ({
    ...record,
    status: nextStatus,
    updatedAt: now,
    completedAt: nextStatus === "completed" ? now : record.completedAt,
    finalReview: {
      jobId: execution.job.id,
      status: execution.job.status,
      summary: summarizeOutput(execution.job.output),
      verified: execution.job.verified,
      reviewedAt: now,
    },
  }));
  if (!reviewed) {
    throw new Error(`Goal not found after review: ${goalId}`);
  }
  return {
    goal: reviewed,
    execution,
  };
}
