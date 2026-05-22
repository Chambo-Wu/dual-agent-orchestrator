import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_ROOT } from "./paths.js";
import type { TraceEvent, TraceEventType } from "./trace.js";
import type { Task } from "./types.js";

export interface DashboardData {
  runId: string;
  goal: string;
  startedAt: string;
  completedAt: string;
  tasks: TaskSummary[];
  trace: readonly TraceEvent[];
  summary: { totalTasks: number; completed: number; failed: number; blocked: number; tools: number; loops: number; artifacts: number };
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  verified?: boolean;
  result?: string;
  dependsOn?: readonly string[];
}

export function buildDashboardData(
  runId: string,
  goal: string,
  tasks: readonly Task[],
  traceEvents: readonly TraceEvent[],
  startedAt: string,
): DashboardData {
  const now = new Date().toISOString();
  const taskSummaries: TaskSummary[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    verified: t.verified,
    result: t.result?.slice(0, 500),
    dependsOn: t.dependsOn,
  }));

  const tools = traceEvents.filter((e) => e.type.startsWith("tool.")).length;
  const loops = traceEvents.filter((e) => e.type === "loop.detected").length;
  const artifacts = traceEvents.filter((e) => e.type.startsWith("artifact.")).length;

  return {
    runId,
    goal,
    startedAt,
    completedAt: now,
    tasks: taskSummaries,
    trace: traceEvents,
    summary: {
      totalTasks: tasks.length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      tools,
      loops,
      artifacts,
    },
  };
}

export function exportDashboardJson(data: DashboardData): string {
  const dir = resolve(RUNTIME_ROOT, "dashboard");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${data.runId}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

export function renderDashboardHtml(data: DashboardData): string {
  const statusColor = (s: string) => {
    switch (s) {
      case "completed": return "#4caf50";
      case "failed": return "#f44336";
      case "blocked": return "#ff9800";
      case "in_progress": return "#2196f3";
      case "pending": return "#9e9e9e";
      default: return "#757575";
    }
  };

  const tasksHtml = data.tasks.map((t) => `
    <tr>
      <td style="font-family:monospace;font-size:12px">${t.id.slice(0, 8)}</td>
      <td>${t.title}</td>
      <td><span style="color:${statusColor(t.status)};font-weight:bold">${t.status}</span></td>
      <td>${t.assignee ?? "-"}</td>
      <td>${t.verified === true ? "✓" : t.verified === false ? "✗" : "-"}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${t.result?.slice(0, 100) ?? "-"}</td>
    </tr>`).join("\n");

  const traceHtml = data.trace.slice(-50).map((e) => `
    <tr>
      <td style="font-family:monospace;font-size:11px">${e.timestamp.slice(11, 19)}</td>
      <td>${e.type}</td>
      <td>${e.taskId?.slice(0, 8) ?? "-"}</td>
      <td>${e.tool ?? "-"}</td>
      <td>${e.duration ?? "-"}</td>
    </tr>`).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Run Dashboard - ${data.runId}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; background: #fafafa; }
  h1 { color: #333; } h2 { color: #555; margin-top: 30px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
  th { background: #f5f5f5; }
  .summary { display: flex; gap: 20px; margin: 15px 0; }
  .summary-card { background: white; border-radius: 8px; padding: 15px 25px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary-card .label { font-size: 12px; color: #888; }
  .summary-card .value { font-size: 28px; font-weight: bold; }
</style></head><body>
<h1>Run Dashboard</h1>
<p><strong>Goal:</strong> ${data.goal}</p>
<p><strong>Run ID:</strong> ${data.runId}</p>
<p><strong>Started:</strong> ${data.startedAt} &nbsp; <strong>Completed:</strong> ${data.completedAt}</p>

<div class="summary">
  <div class="summary-card"><div class="label">Total Tasks</div><div class="value">${data.summary.totalTasks}</div></div>
  <div class="summary-card"><div class="label" style="color:#4caf50">Completed</div><div class="value">${data.summary.completed}</div></div>
  <div class="summary-card"><div class="label" style="color:#f44336">Failed</div><div class="value">${data.summary.failed}</div></div>
  <div class="summary-card"><div class="label" style="color:#ff9800">Blocked</div><div class="value">${data.summary.blocked}</div></div>
  <div class="summary-card"><div class="label">Tool Calls</div><div class="value">${data.summary.tools}</div></div>
  <div class="summary-card"><div class="label">Loops</div><div class="value">${data.summary.loops}</div></div>
</div>

<h2>Tasks</h2>
<table><tr><th>ID</th><th>Title</th><th>Status</th><th>Assignee</th><th>Verified</th><th>Result</th></tr>
${tasksHtml}
</table>

<h2>Trace (last 50 events)</h2>
<table><tr><th>Time</th><th>Type</th><th>Task</th><th>Tool</th><th>Duration</th></tr>
${traceHtml}
</table>
</body></html>`;
}

export function exportDashboardHtml(data: DashboardData): string {
  const dir = resolve(RUNTIME_ROOT, "dashboard");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${data.runId}.html`);
  writeFileSync(path, renderDashboardHtml(data), "utf8");
  return path;
}
