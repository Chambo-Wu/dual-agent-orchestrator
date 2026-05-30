import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { RUNTIME_ROOT } from "./paths.js";
import type { CreateGoalInput, GoalEventRecord, GoalRecord, GoalTask, GoalTaskInput } from "./goal-types.js";

function goalsRoot(): string {
  return resolve(RUNTIME_ROOT, "goals");
}

function goalDir(goalId: string): string {
  return resolve(goalsRoot(), goalId);
}

function goalRecordPath(goalId: string): string {
  return resolve(goalDir(goalId), "goal.json");
}

function goalInputMirrorPath(goalId: string): string {
  return resolve(goalDir(goalId), "input.md");
}

function goalPlanMirrorPath(goalId: string): string {
  return resolve(goalDir(goalId), "plan.md");
}

function goalTasksMirrorPath(goalId: string): string {
  return resolve(goalDir(goalId), "tasks.md");
}

function goalEventsPath(goalId: string): string {
  return resolve(goalDir(goalId), "events.jsonl");
}

function ensureGoalsRoot(): void {
  mkdirSync(goalsRoot(), { recursive: true });
}

function createGoalTask(task: GoalTaskInput, index: number): GoalTask {
  const now = new Date().toISOString();
  return {
    id: `goaltask_${randomUUID()}`,
    title: task.title.trim() || `Task ${index + 1}`,
    description: task.description.trim() || task.title.trim() || `Task ${index + 1}`,
    mode: task.mode === "team" ? "team" : "task",
    kind: task.kind === "large_check" ? "large_check" : "goal_task",
    status: "pending",
    updatedAt: now,
  };
}

function buildDefaultTasks(goal: string): GoalTask[] {
  return [
    createGoalTask({
      title: "Execute next goal step",
      description: goal,
      mode: "task",
      kind: "goal_task",
    }, 0),
  ];
}

function normalizeGoalTask(task: Partial<GoalTask> & { title?: unknown; description?: unknown }, index: number, fallbackTime: string): GoalTask {
  const title = typeof task.title === "string" && task.title.trim()
    ? task.title.trim()
    : `Task ${index + 1}`;
  const description = typeof task.description === "string" && task.description.trim()
    ? task.description.trim()
    : title;
  return {
    id: typeof task.id === "string" && task.id.trim() ? task.id : `goaltask_${randomUUID()}`,
    title,
    description,
    mode: task.mode === "team" ? "team" : "task",
    kind: task.kind === "large_check" ? "large_check" : "goal_task",
    status: task.status === "running"
      || task.status === "completed"
      || task.status === "blocked"
      || task.status === "failed"
      || task.status === "skipped"
      ? task.status
      : "pending",
    notes: typeof task.notes === "string" ? task.notes : undefined,
    outputSummary: typeof task.outputSummary === "string" ? task.outputSummary : undefined,
    verificationSummary: typeof task.verificationSummary === "string" ? task.verificationSummary : undefined,
    lastJobId: typeof task.lastJobId === "string" ? task.lastJobId : undefined,
    completedAt: typeof task.completedAt === "string" ? task.completedAt : undefined,
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : fallbackTime,
  };
}

function normalizeGoalRecord(record: Partial<GoalRecord> & { goal?: unknown; tasks?: unknown }): GoalRecord {
  const now = new Date().toISOString();
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : now;
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : createdAt;
  const goal = typeof record.goal === "string" ? record.goal : "";
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map((task, index) => normalizeGoalTask(task as Partial<GoalTask>, index, updatedAt))
    : [];
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `goal_${randomUUID()}`,
    goal,
    status: record.status === "initializing"
      || record.status === "ready"
      || record.status === "running"
      || record.status === "waiting_review"
      || record.status === "blocked"
      || record.status === "completed"
      || record.status === "failed"
      ? record.status
      : "ready",
    createdAt,
    updatedAt,
    currentTaskId: typeof record.currentTaskId === "string" ? record.currentTaskId : undefined,
    completedTaskCount: typeof record.completedTaskCount === "number"
      ? record.completedTaskCount
      : tasks.filter((task) => task.status === "completed").length,
    tasks,
    runHistory: Array.isArray(record.runHistory) ? record.runHistory : [],
    finalReview: record.finalReview && typeof record.finalReview === "object"
      ? {
          status: record.finalReview.status === "completed"
            || record.finalReview.status === "failed"
            || record.finalReview.status === "blocked"
            ? record.finalReview.status
            : "pending",
          jobId: typeof record.finalReview.jobId === "string" ? record.finalReview.jobId : undefined,
          summary: typeof record.finalReview.summary === "string" ? record.finalReview.summary : undefined,
          verified: typeof record.finalReview.verified === "boolean" ? record.finalReview.verified : undefined,
          reviewedAt: typeof record.finalReview.reviewedAt === "string" ? record.finalReview.reviewedAt : undefined,
        }
      : { status: "pending" },
    completedAt: typeof record.completedAt === "string" ? record.completedAt : undefined,
  };
}

export function buildGoalRecord(input: CreateGoalInput): GoalRecord {
  const now = new Date().toISOString();
  const tasks = Array.isArray(input.tasks) && input.tasks.length > 0
    ? input.tasks.map((task, index) => createGoalTask(task, index))
    : buildDefaultTasks(input.goal);

  return {
    id: `goal_${randomUUID()}`,
    goal: input.goal.trim(),
    status: "ready",
    createdAt: now,
    updatedAt: now,
    completedTaskCount: 0,
    tasks,
    runHistory: [],
    finalReview: {
      status: "pending",
    },
  };
}

export function syncGoalMirrorFiles(record: GoalRecord): void {
  mkdirSync(goalDir(record.id), { recursive: true });
  const inputMd = `# Goal Input\n\n${record.goal}\n`;
  const planMd = [
    "# Goal Plan",
    "",
    `- Goal ID: ${record.id}`,
    `- Status: ${record.status}`,
    `- Created At: ${record.createdAt}`,
    `- Updated At: ${record.updatedAt}`,
    `- Completed Tasks: ${record.completedTaskCount}/${record.tasks.length}`,
    record.currentTaskId ? `- Current Task ID: ${record.currentTaskId}` : "- Current Task ID: none",
    `- Final Review Status: ${record.finalReview.status}`,
    record.completedAt ? `- Completed At: ${record.completedAt}` : "- Completed At: none",
    "",
  ].join("\n");
  const tasksMd = [
    "# Goal Tasks",
    "",
    ...record.tasks.map((task, index) => {
      const lines = [
        `${index + 1}. [${task.status}] ${task.title}`,
        `   - ID: ${task.id}`,
        `   - Kind: ${task.kind}`,
        `   - Mode: ${task.mode}`,
        `   - Description: ${task.description}`,
      ];
      if (task.lastJobId) {
        lines.push(`   - Last Job: ${task.lastJobId}`);
      }
      if (task.outputSummary) {
        lines.push(`   - Output: ${task.outputSummary}`);
      }
      if (task.verificationSummary) {
        lines.push(`   - Verification: ${task.verificationSummary}`);
      }
      if (task.notes) {
        lines.push(`   - Notes: ${task.notes}`);
      }
      return lines.join("\n");
    }),
    "",
    "## Final Review",
    "",
    `- Status: ${record.finalReview.status}`,
    record.finalReview.jobId ? `- Job ID: ${record.finalReview.jobId}` : "- Job ID: none",
    record.finalReview.summary ? `- Summary: ${record.finalReview.summary}` : "- Summary: none",
    typeof record.finalReview.verified === "boolean" ? `- Verified: ${record.finalReview.verified}` : "- Verified: unknown",
    record.finalReview.reviewedAt ? `- Reviewed At: ${record.finalReview.reviewedAt}` : "- Reviewed At: none",
    "",
  ].join("\n");

  writeFileSync(goalInputMirrorPath(record.id), inputMd, "utf8");
  writeFileSync(goalPlanMirrorPath(record.id), planMd, "utf8");
  writeFileSync(goalTasksMirrorPath(record.id), tasksMd, "utf8");
}

export function persistGoal(record: GoalRecord): string {
  ensureGoalsRoot();
  mkdirSync(goalDir(record.id), { recursive: true });
  const path = goalRecordPath(record.id);
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  syncGoalMirrorFiles(record);
  return path;
}

export function appendGoalEvent(goalId: string, event: Omit<GoalEventRecord, "id" | "time"> & { id?: string; time?: string }): GoalEventRecord {
  ensureGoalsRoot();
  mkdirSync(goalDir(goalId), { recursive: true });
  const persisted: GoalEventRecord = {
    id: event.id ?? `goalevt_${randomUUID().slice(0, 8)}`,
    time: event.time ?? new Date().toISOString(),
    type: event.type,
    title: event.title,
    summary: event.summary,
    status: event.status,
    meta: event.meta,
  };
  appendFileSync(goalEventsPath(goalId), `${JSON.stringify(persisted)}\n`, "utf8");
  return persisted;
}

export function readGoalEvents(goalId: string): GoalEventRecord[] {
  const path = goalEventsPath(goalId);
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as GoalEventRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readGoal(goalId: string): GoalRecord | null {
  try {
    return normalizeGoalRecord(JSON.parse(readFileSync(goalRecordPath(goalId), "utf8")) as Partial<GoalRecord>);
  } catch {
    return null;
  }
}

export function updateGoal(goalId: string, updater: (record: GoalRecord) => GoalRecord): GoalRecord | null {
  const record = readGoal(goalId);
  if (!record) {
    return null;
  }
  const next = updater(record);
  persistGoal(next);
  return next;
}

export function listGoals(): Array<{ id: string; goal: string; status: GoalRecord["status"]; updatedAt: string; createdAt: string }> {
  ensureGoalsRoot();
  return (readdirSync(goalsRoot(), { withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const record = readGoal(entry.name);
      if (!record) {
        return [];
      }
      return [{
        id: record.id,
        goal: record.goal,
        status: record.status,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
      }];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function summarizeGoals(): {
  total: number;
  byStatus: Record<GoalRecord["status"], number>;
  waitingReview: number;
  running: number;
  blocked: number;
} {
  const byStatus: Record<GoalRecord["status"], number> = {
    initializing: 0,
    ready: 0,
    running: 0,
    waiting_review: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
  };
  const goals = listGoals();
  for (const goal of goals) {
    byStatus[goal.status] += 1;
  }
  return {
    total: goals.length,
    byStatus,
    waitingReview: byStatus.waiting_review,
    running: byStatus.running,
    blocked: byStatus.blocked,
  };
}
