export type GoalTaskMode = "task" | "team";
export type GoalTaskKind = "goal_task" | "large_check";

export type GoalStatus =
  | "initializing"
  | "ready"
  | "running"
  | "waiting_review"
  | "blocked"
  | "completed"
  | "failed";

export type GoalTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

export interface GoalTask {
  id: string;
  title: string;
  description: string;
  mode: GoalTaskMode;
  kind: GoalTaskKind;
  status: GoalTaskStatus;
  notes?: string;
  outputSummary?: string;
  verificationSummary?: string;
  lastJobId?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface GoalRunRecord {
  jobId: string;
  taskId: string;
  mode: GoalTaskMode;
  status: "completed" | "failed" | "blocked";
  verified: boolean;
  createdAt: string;
}

export interface GoalFinalReviewRecord {
  jobId?: string;
  status: "pending" | "completed" | "failed" | "blocked";
  summary?: string;
  verified?: boolean;
  reviewedAt?: string;
}

export interface GoalEventRecord {
  id: string;
  time: string;
  type:
    | "goal.created"
    | "goal.run_next_started"
    | "goal.run_next_completed"
    | "goal.retry_started"
    | "goal.retry_completed"
    | "goal.resumed"
    | "goal.review_started"
    | "goal.review_completed";
  title: string;
  summary: string;
  status: "running" | "success" | "blocked" | "failed" | "completed";
  meta: Record<string, unknown>;
}

export interface GoalRecord {
  id: string;
  goal: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  currentTaskId?: string;
  completedTaskCount: number;
  tasks: GoalTask[];
  runHistory: GoalRunRecord[];
  finalReview: GoalFinalReviewRecord;
  completedAt?: string;
}

export interface GoalTaskInput {
  title: string;
  description: string;
  mode?: GoalTaskMode;
  kind?: GoalTaskKind;
}

export interface CreateGoalInput {
  goal: string;
  tasks?: GoalTaskInput[];
}
