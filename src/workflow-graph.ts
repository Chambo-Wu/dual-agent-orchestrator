import type { TaskRun } from "./types.js";

export interface WorkflowGraphTaskNode {
  id: string;
  task_id: string;
  title: string;
  status: TaskRun["status"];
  assignee: string | null;
  depends_on: readonly string[];
  verified: boolean;
  attempts: number;
  superseded: boolean;
  superseded_by: string | null;
}

export interface WorkflowGraphLane {
  workflow_id: string;
  status: "active" | "superseded";
  superseded_by?: string;
  task_count: number;
  completed_count: number;
  tasks: WorkflowGraphTaskNode[];
}

export interface WorkflowReplanHistoryEntry {
  index: number;
  superseded_workflow_id?: string;
  replacement_workflow_id?: string;
  failed_task_id?: string;
  summary?: string;
}

export interface WorkflowGraph {
  workflow_id: string;
  workflow_count: number;
  edge_count: number;
  workflows: WorkflowGraphLane[];
  replan_history: WorkflowReplanHistoryEntry[];
}

function parseSupersededTitle(title: string): { cleanTitle: string; supersededBy?: string } {
  const match = title.match(/\s+\[superseded by ([^\]]+)\]\s*$/);
  if (!match) {
    return { cleanTitle: title };
  }
  return {
    cleanTitle: title.slice(0, match.index).trim(),
    supersededBy: match[1]?.trim(),
  };
}

function deriveWorkflowIdentity(taskRun: TaskRun, activeWorkflowId: string): {
  workflowId: string;
  taskId: string;
  superseded: boolean;
  supersededBy?: string;
  displayTitle: string;
} {
  const titleInfo = parseSupersededTitle(taskRun.title);
  const archivedSeparator = taskRun.id.indexOf(":");
  if (archivedSeparator > 0) {
    return {
      workflowId: taskRun.id.slice(0, archivedSeparator),
      taskId: taskRun.id.slice(archivedSeparator + 1),
      superseded: true,
      supersededBy: titleInfo.supersededBy,
      displayTitle: titleInfo.cleanTitle,
    };
  }
  return {
    workflowId: activeWorkflowId,
    taskId: taskRun.id,
    superseded: false,
    displayTitle: titleInfo.cleanTitle,
  };
}

export function parseWorkflowReplanHistory(planSummary: string | undefined): WorkflowReplanHistoryEntry[] {
  const summary = planSummary ?? "";
  const marker = "History:";
  const markerIndex = summary.indexOf(marker);
  if (markerIndex < 0) {
    return [];
  }
  const historyText = summary.slice(markerIndex + marker.length).trim();
  if (!historyText) {
    return [];
  }

  return historyText
    .split("|")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk, index) => {
      const match = chunk.match(/^\d+\.\s+(.+?)\s+->\s+(.+?)\s+\(failed task:\s+([^)]+)\)$/);
      if (!match) {
        return {
          index: index + 1,
          summary: chunk,
        };
      }
      return {
        index: index + 1,
        superseded_workflow_id: match[1]?.trim(),
        replacement_workflow_id: match[2]?.trim(),
        failed_task_id: match[3]?.trim(),
      };
    });
}

export function buildWorkflowGraph(
  workflowId: string,
  taskRuns: readonly TaskRun[],
  planSummary?: string,
): WorkflowGraph {
  const workflowGroups = new Map<string, WorkflowGraphLane>();

  for (const taskRun of taskRuns) {
    const identity = deriveWorkflowIdentity(taskRun, workflowId);
    const existing = workflowGroups.get(identity.workflowId) ?? {
      workflow_id: identity.workflowId,
      status: identity.superseded ? "superseded" : "active",
      superseded_by: identity.supersededBy,
      task_count: 0,
      completed_count: 0,
      tasks: [],
    };
    existing.tasks.push({
      id: taskRun.id,
      task_id: identity.taskId,
      title: identity.displayTitle,
      status: taskRun.status,
      assignee: taskRun.assignee ?? null,
      depends_on: taskRun.dependsOn,
      verified: taskRun.verified,
      attempts: taskRun.attempts,
      superseded: identity.superseded,
      superseded_by: identity.supersededBy ?? null,
    });
    workflowGroups.set(identity.workflowId, existing);
  }

  const workflows = [...workflowGroups.values()]
    .map((group) => ({
      ...group,
      task_count: group.tasks.length,
      completed_count: group.tasks.filter((task) => task.status === "completed").length,
    }))
    .sort((a, b) => {
      if (a.workflow_id === workflowId) return 1;
      if (b.workflow_id === workflowId) return -1;
      return a.workflow_id.localeCompare(b.workflow_id);
    });

  return {
    workflow_id: workflowId,
    workflow_count: workflows.length,
    edge_count: taskRuns.reduce((count, taskRun) => count + taskRun.dependsOn.length, 0),
    workflows,
    replan_history: parseWorkflowReplanHistory(planSummary),
  };
}
