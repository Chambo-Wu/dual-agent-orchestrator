import { mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_ROOT } from "./paths.js";
import type { Artifact, Job, Plan, TaskRun } from "./types.js";

export interface JobControlState {
  cancellationRequestedAt?: string;
  cancelledAt?: string;
  retryOf?: string;
  retriedAt?: string;
  retriedToJobId?: string;
}

export interface StoredJobRecord {
  savedAt: string;
  job: Job;
  plan: Plan;
  taskRuns: TaskRun[];
  artifacts: Artifact[];
  control?: JobControlState;
}

function jobsRoot(): string {
  return resolve(RUNTIME_ROOT, "jobs");
}

function jobDir(jobId: string): string {
  return resolve(jobsRoot(), jobId);
}

function jobRecordPath(jobId: string): string {
  return resolve(jobDir(jobId), "record.json");
}

function ensureJobsRoot(): void {
  mkdirSync(jobsRoot(), { recursive: true });
}

export function persistJobRecord(payload: {
  job: Job;
  plan: Plan;
  taskRuns: TaskRun[];
  artifacts: Artifact[];
}): string {
  ensureJobsRoot();
  mkdirSync(jobDir(payload.job.id), { recursive: true });
  const record: StoredJobRecord = {
    savedAt: new Date().toISOString(),
    job: payload.job,
    plan: payload.plan,
    taskRuns: payload.taskRuns,
    artifacts: payload.artifacts,
    control: {},
  };
  const path = jobRecordPath(payload.job.id);
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return path;
}

export function readJobRecord(jobId: string): StoredJobRecord | null {
  try {
    return JSON.parse(readFileSync(jobRecordPath(jobId), "utf8")) as StoredJobRecord;
  } catch {
    return null;
  }
}

export function listStoredJobs(): Array<{ id: string; savedAt: string; status: Job["status"]; goal: string }> {
  ensureJobsRoot();
  return (readdirSync(jobsRoot(), { withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const record = readJobRecord(entry.name);
      if (!record) return [];
      return [{
        id: record.job.id,
        savedAt: record.savedAt,
        status: record.job.status,
        goal: record.job.goal,
      }];
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function updateJobControlState(jobId: string, update: Partial<JobControlState>): StoredJobRecord | null {
  const record = readJobRecord(jobId);
  if (!record) {
    return null;
  }
  const next: StoredJobRecord = {
    ...record,
    control: {
      ...record.control,
      ...update,
    },
  };
  writeFileSync(jobRecordPath(jobId), JSON.stringify(next, null, 2), "utf8");
  return next;
}
