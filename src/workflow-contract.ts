import { randomUUID } from "node:crypto";
import type { Artifact, ExecutorArtifact, ExecutorOutput, Job, JobMode, JobStatus, Plan, TaskRun, TaskRunStatus } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function mapJobStatusToTaskRunStatus(status: JobStatus): TaskRunStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
    case "cancelled":
      return "blocked";
    case "queued":
    case "running":
    case "awaiting_approval":
    default:
      return "pending";
  }
}

function mapExecutorArtifact(artifact: ExecutorArtifact, sourceTaskRunId?: string): Artifact {
  return {
    id: createId("artifact"),
    type: artifact.type,
    path: artifact.path,
    contentPreview: artifact.content_preview,
    source: "executor",
    sourceTaskRunId,
  };
}

export function collectArtifactsFromExecutorHistory(executorHistory: readonly ExecutorOutput[], sourceTaskRunId?: string): Artifact[] {
  return executorHistory.flatMap((item) => item.artifacts.map((artifact) => mapExecutorArtifact(artifact, sourceTaskRunId)));
}

export function createTaskRunRecord(params: {
  id?: string;
  title: string;
  description: string;
  status: TaskRunStatus;
  assignee?: string;
  dependsOn?: readonly string[];
  verified?: boolean;
  output?: string;
  artifacts?: readonly Artifact[];
  attempts?: number;
  executorHistory?: readonly ExecutorOutput[];
}): TaskRun {
  return {
    id: params.id ?? createId("taskrun"),
    title: params.title,
    description: params.description,
    status: params.status,
    assignee: params.assignee,
    dependsOn: params.dependsOn ?? [],
    verified: params.verified ?? false,
    output: params.output ?? "",
    artifacts: [...(params.artifacts ?? [])],
    attempts: params.attempts ?? 0,
    executorHistory: params.executorHistory ? [...params.executorHistory] : undefined,
  };
}

export function createPlanRecord(params: {
  id?: string;
  goal: string;
  mode: JobMode;
  taskRunIds: readonly string[];
  summary?: string;
}): Plan {
  return {
    id: params.id ?? createId("plan"),
    goal: params.goal,
    mode: params.mode,
    taskRunIds: [...params.taskRunIds],
    summary: params.summary,
  };
}

export function createJobRecord(params: {
  id?: string;
  goal: string;
  mode: JobMode;
  status: JobStatus;
  verified: boolean;
  output: string;
  plan: Plan;
  taskRuns: readonly TaskRun[];
  artifacts?: readonly Artifact[];
  memorySummary?: string;
}): Job {
  return {
    id: params.id ?? createId("job"),
    goal: params.goal,
    mode: params.mode,
    status: params.status,
    verified: params.verified,
    output: params.output,
    plan: params.plan,
    taskRuns: [...params.taskRuns],
    artifacts: [...(params.artifacts ?? params.taskRuns.flatMap((taskRun) => taskRun.artifacts))],
    memorySummary: params.memorySummary,
  };
}

export function buildSingleTaskContract(params: {
  jobId?: string;
  planId?: string;
  taskRunId?: string;
  goal: string;
  title?: string;
  description?: string;
  assignee?: string;
  mode?: JobMode;
  status: JobStatus;
  verified: boolean;
  output: string;
  executorHistory: readonly ExecutorOutput[];
}): { job: Job; plan: Plan; taskRuns: TaskRun[]; artifacts: Artifact[] } {
  const taskRunId = params.taskRunId ?? createId("taskrun");
  const artifacts = collectArtifactsFromExecutorHistory(params.executorHistory, taskRunId);
  const taskRun = createTaskRunRecord({
    id: taskRunId,
    title: params.title ?? params.goal,
    description: params.description ?? params.goal,
    status: mapJobStatusToTaskRunStatus(params.status),
    assignee: params.assignee,
    verified: params.verified,
    output: params.output,
    artifacts,
    attempts: params.executorHistory.length,
    executorHistory: params.executorHistory,
  });
  const plan = createPlanRecord({
    id: params.planId,
    goal: params.goal,
    mode: params.mode ?? "task",
    taskRunIds: [taskRun.id],
    summary: "Single-task orchestration result.",
  });
  const job = createJobRecord({
    id: params.jobId,
    goal: params.goal,
    mode: params.mode ?? "task",
    status: params.status,
    verified: params.verified,
    output: params.output,
    plan,
    taskRuns: [taskRun],
    artifacts,
  });

  return {
    job,
    plan,
    taskRuns: [taskRun],
    artifacts,
  };
}
