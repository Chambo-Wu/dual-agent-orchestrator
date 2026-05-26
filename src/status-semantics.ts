import type { Job, TaskRun } from "./types.js";
import type { WorkflowUiEvent } from "./workflow-ui-events.js";

export function mapTaskRunStatusToUiStatus(status: TaskRun["status"]): WorkflowUiEvent["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "awaiting_approval":
      return "awaiting_approval";
    case "in_progress":
    case "pending":
    case "skipped":
    default:
      return "running";
  }
}

export function mapJobStatusToUiStatus(status: Job["status"]): WorkflowUiEvent["status"] {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "awaiting_approval":
      return "awaiting_approval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "blocked":
    default:
      return "blocked";
  }
}

export function mapJobStatusToLifecycleType(status: Job["status"]): string {
  switch (status) {
    case "queued":
      return "job.queued";
    case "running":
      return "job.started";
    case "awaiting_approval":
      return "job.awaiting_approval";
    case "completed":
      return "job.completed";
    case "failed":
      return "job.failed";
    case "cancelled":
      return "job.cancelled";
    case "blocked":
    default:
      return "job.blocked";
  }
}

export function describeJobState(status: Job["status"]): string {
  switch (status) {
    case "running":
      return "Job is currently running.";
    case "queued":
      return "Job is queued.";
    case "awaiting_approval":
      return "Job is waiting for approval.";
    case "cancelled":
      return "Job was cancelled.";
    default:
      return `Job finished with status ${status}.`;
  }
}
