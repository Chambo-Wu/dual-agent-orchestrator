import { getFailureCategoryLabel, getFailureCategoryTitle } from "./failure-classification.js";
import type { WorkflowUiEvent } from "./workflow-ui-events.js";

// ---------------------------------------------------------------------------
// Timeline HTML Generator
// ---------------------------------------------------------------------------

export function renderTimelineHtml(
  jobId: string,
  events: WorkflowUiEvent[],
  goal?: string,
  status?: string,
  workflowSummary?: {
    current_task?: { id?: string; title?: string; status?: string } | null;
    awaiting_approval_task?: { title?: string; status?: string } | null;
    task_counts?: Record<string, number>;
    dag?: {
      workflow_count?: number;
      edge_count?: number;
      workflows?: Array<{
        workflow_id?: string;
        status?: string;
        superseded_by?: string;
        task_count?: number;
        completed_count?: number;
        tasks?: Array<{
          id?: string;
          task_id?: string;
          title?: string;
          status?: string;
          assignee?: string | null;
          depends_on?: string[];
          verified?: boolean;
          attempts?: number;
          superseded?: boolean;
          superseded_by?: string | null;
        }>;
      }>;
    };
    replan_history?: Array<{
      index?: number;
      superseded_workflow_id?: string;
      replacement_workflow_id?: string;
      failed_task_id?: string;
      summary?: string;
    }>;
  },
): string {
  const latestStep = events.reduce((max, e) => Math.max(max, e.step ?? 0), 0);
  const failureSummary = summarizeFailures(events);
  const runtimeAnalysis = summarizeRuntimeAnalysis(events);
  const currentTaskId = workflowSummary?.current_task?.id;
  const currentTaskTitle = workflowSummary?.current_task?.title;
  const currentTaskStatus = workflowSummary?.current_task?.status;
  const approvalTaskTitle = workflowSummary?.awaiting_approval_task?.title;
  const taskCounts = workflowSummary?.task_counts;
  const dag = workflowSummary?.dag;
  const replanHistory = workflowSummary?.replan_history ?? [];
  const taskCountSummary = taskCounts
    ? `Tasks: ${taskCounts.completed ?? 0} completed, ${taskCounts.awaiting_approval ?? 0} awaiting approval, ${taskCounts.in_progress ?? 0} in progress, ${taskCounts.pending ?? 0} pending`
    : "";
  const failureSummaryText = formatFailureSummaryDisplay(failureSummary);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Workflow Timeline - ${escapeHtml(jobId)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.6;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .header h1 {
      font-size: 18px;
      color: #f0f6fc;
      margin-bottom: 8px;
    }
    .header .meta {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: #8b949e;
    }
    .header .meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .workflow-panels {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr);
      gap: 16px;
      margin-bottom: 20px;
    }
    .panel {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px;
    }
    .panel h2 {
      font-size: 15px;
      color: #f0f6fc;
      margin-bottom: 12px;
    }
    .panel .subtle {
      color: #8b949e;
      font-size: 12px;
      margin-bottom: 10px;
    }
    .workflow-lanes {
      display: grid;
      gap: 12px;
    }
    .workflow-lane {
      border: 1px solid #30363d;
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(88,166,255,0.06), rgba(13,17,23,0.2));
      padding: 12px;
    }
    .workflow-lane.superseded {
      background: linear-gradient(180deg, rgba(210,153,34,0.10), rgba(13,17,23,0.2));
    }
    .workflow-lane.is-focus-dimmed {
      opacity: 0.45;
      transition: opacity 0.18s ease;
    }
    .workflow-lane.is-focused {
      border-color: rgba(88,166,255,0.8);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.3), 0 10px 24px rgba(1, 4, 9, 0.28);
    }
    .lane-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .lane-title {
      font-size: 13px;
      font-weight: 600;
      color: #f0f6fc;
    }
    .lane-meta {
      font-size: 12px;
      color: #8b949e;
    }
    .workflow-graph {
      position: relative;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .workflow-graph-inner {
      position: relative;
      min-width: 100%;
    }
    .graph-columns {
      display: flex;
      gap: 18px;
      align-items: flex-start;
      position: relative;
      z-index: 1;
    }
    .graph-column {
      min-width: 220px;
      display: grid;
      gap: 12px;
    }
    .graph-column-label {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #8b949e;
      padding-left: 4px;
    }
    .graph-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
      z-index: 0;
    }
    .graph-edge {
      fill: none;
      stroke: rgba(88, 166, 255, 0.34);
      stroke-width: 2;
      transition: stroke 0.18s ease, stroke-width 0.18s ease, opacity 0.18s ease;
    }
    .graph-edge.superseded {
      stroke: rgba(210, 153, 34, 0.34);
    }
    .graph-edge.is-highlighted {
      stroke: rgba(88, 166, 255, 0.95);
      stroke-width: 3;
      opacity: 1;
    }
    .graph-edge.superseded.is-highlighted {
      stroke: rgba(240, 185, 58, 0.95);
    }
    .graph-edge.is-dimmed {
      opacity: 0.18;
    }
    .task-card {
      border: 1px solid #30363d;
      border-radius: 8px;
      background: #0d1117;
      padding: 10px;
      transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease, opacity 0.18s ease;
    }
    .task-card.status-completed { border-color: rgba(63,185,80,0.55); }
    .task-card.status-failed { border-color: rgba(248,81,73,0.55); }
    .task-card.status-skipped { border-color: rgba(210,153,34,0.55); }
    .task-card.status-awaiting_approval { border-color: rgba(88,166,255,0.55); }
    .task-card.is-current-task {
      border-color: rgba(88,166,255,0.95);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.4), 0 10px 28px rgba(31, 111, 235, 0.16);
    }
    .task-card.is-highlighted {
      border-color: rgba(88,166,255,0.95);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.3), 0 8px 20px rgba(31, 111, 235, 0.14);
      transform: translateY(-1px);
      opacity: 1;
    }
    .task-card.is-dimmed {
      opacity: 0.5;
    }
    .task-card.is-analysis-match {
      border-color: rgba(88,166,255,0.95);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.28), 0 8px 20px rgba(31, 111, 235, 0.14);
      opacity: 1;
    }
    .task-card.is-analysis-dimmed {
      opacity: 0.4;
    }
    .task-card-title {
      font-size: 13px;
      font-weight: 600;
      color: #f0f6fc;
      margin-bottom: 6px;
    }
    .task-card-meta, .task-card-deps {
      font-size: 12px;
      color: #8b949e;
      margin-top: 4px;
    }
    .history-list {
      display: grid;
      gap: 10px;
    }
    .history-actions {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 10px;
    }
    .history-clear {
      border: 1px solid #30363d;
      border-radius: 999px;
      background: transparent;
      color: #8b949e;
      font-size: 12px;
      padding: 4px 10px;
      cursor: pointer;
      transition: border-color 0.18s ease, color 0.18s ease, background 0.18s ease;
    }
    .history-clear:hover {
      border-color: rgba(88,166,255,0.55);
      color: #c9d1d9;
      background: #111723;
    }
    .history-item {
      border: 1px solid #30363d;
      border-radius: 8px;
      background: #0d1117;
      padding: 10px;
    }
    .history-item[data-superseded-workflow-id],
    .history-item[data-replacement-workflow-id] {
      cursor: pointer;
      transition: border-color 0.18s ease, background 0.18s ease;
    }
    .history-item[data-superseded-workflow-id]:hover,
    .history-item[data-replacement-workflow-id]:hover {
      border-color: rgba(88,166,255,0.55);
      background: #111723;
    }
    .history-item.is-focused {
      border-color: rgba(88,166,255,0.75);
      background: rgba(17, 23, 35, 0.95);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.22);
    }
    .history-item.is-dimmed {
      opacity: 0.55;
    }
    .history-item strong {
      color: #f0f6fc;
    }
    .history-focus-state {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(88,166,255,0.12);
      color: #8cc7ff;
      font-size: 11px;
      letter-spacing: 0.02em;
    }
    .history-focus-state[hidden] {
      display: none;
    }
    .history-focus-hint {
      margin-top: 6px;
      font-size: 11px;
      color: #8b949e;
    }
    .history-focus-hint[hidden] {
      display: none;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-running { background: #1f6feb33; color: #58a6ff; }
    .status-success { background: #23863633; color: #3fb950; }
    .status-failed { background: #f8514933; color: #f85149; }
    .status-completed { background: #23863633; color: #3fb950; }
    .status-blocked { background: #9e6a0333; color: #d29922; }

    .timeline {
      position: relative;
      padding-left: 24px;
    }
    .timeline::before {
      content: '';
      position: absolute;
      left: 11px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #30363d;
    }

    .event-card {
      position: relative;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .event-card:hover {
      border-color: #58a6ff;
    }
    .event-card.is-analysis-match {
      border-color: rgba(88,166,255,0.9);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.25), 0 8px 18px rgba(31, 111, 235, 0.12);
    }
    .event-card.is-analysis-dimmed {
      opacity: 0.42;
    }
    .event-card::before {
      content: '';
      position: absolute;
      left: -18px;
      top: 16px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #30363d;
      border: 2px solid #0d1117;
    }

    .event-card.agent-planner { border-left: 3px solid #58a6ff; }
    .event-card.agent-planner::before { background: #58a6ff; }

    .event-card.agent-executor { border-left: 3px solid #3fb950; }
    .event-card.agent-executor::before { background: #3fb950; }

    .event-card.agent-tool { border-left: 3px solid #8b949e; }
    .event-card.agent-tool::before { background: #8b949e; }

    .event-card.agent-system { border-left: 3px solid #d29922; }
    .event-card.agent-system::before { background: #d29922; }

    .event-card.status-failed { border-left-color: #f85149; }
    .event-card.status-failed::before { background: #f85149; }

    .event-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .event-title {
      font-size: 14px;
      font-weight: 600;
      color: #f0f6fc;
    }
    .event-time {
      font-size: 12px;
      color: #8b949e;
    }
    .event-summary {
      font-size: 13px;
      color: #8b949e;
      margin-bottom: 8px;
    }
    .event-meta {
      display: none;
      background: #0d1117;
      border-radius: 4px;
      padding: 8px;
      font-size: 12px;
      font-family: monospace;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .event-card.expanded .event-meta {
      display: block;
    }
    .event-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      background: #30363d;
      color: #8b949e;
    }
    .analysis-chip {
      border: 1px solid #30363d;
      border-radius: 999px;
      background: transparent;
      color: #c9d1d9;
      font-size: 12px;
      padding: 4px 10px;
      cursor: pointer;
      transition: border-color 0.18s ease, color 0.18s ease, background 0.18s ease, opacity 0.18s ease;
      text-align: left;
    }
    .analysis-chip:hover {
      border-color: rgba(88,166,255,0.55);
      background: #111723;
    }
    .analysis-chip.is-active {
      border-color: rgba(88,166,255,0.8);
      color: #f0f6fc;
      background: rgba(88,166,255,0.12);
    }
    .analysis-actions {
      display: flex;
      justify-content: flex-end;
      margin: 8px 0 10px 0;
    }
    .analysis-clear {
      border: 1px solid #30363d;
      border-radius: 999px;
      background: transparent;
      color: #8b949e;
      font-size: 12px;
      padding: 4px 10px;
      cursor: pointer;
    }
    .analysis-clear:hover {
      border-color: rgba(88,166,255,0.55);
      color: #c9d1d9;
      background: #111723;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #8b949e;
    }
    .empty-state .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    #events-container {
      min-height: 200px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Workflow Timeline</h1>
      <div class="meta">
        <span>Job: ${escapeHtml(jobId)}</span>
        ${goal ? `<span>Goal: ${escapeHtml(truncate(goal, 80))}</span>` : ""}
        <span>Step: ${latestStep}</span>
        ${status ? `<span class="status-badge status-${status}">${status}</span>` : ""}
        ${currentTaskTitle ? `<span>Current: ${escapeHtml(currentTaskTitle)}${currentTaskStatus ? ` (${escapeHtml(currentTaskStatus)})` : ""}</span>` : ""}
        ${approvalTaskTitle ? `<span>Approval: ${escapeHtml(approvalTaskTitle)}</span>` : ""}
      </div>
      ${taskCountSummary ? `<div class="meta" style="margin-top:8px"><span>${escapeHtml(taskCountSummary)}</span></div>` : ""}
      ${failureSummaryText ? `<div class="meta" style="margin-top:8px"><span>${escapeHtml(failureSummaryText)}</span></div>` : ""}
    </div>

    ${(dag || replanHistory.length > 0 || runtimeAnalysis.hasData) ? `<div class="workflow-panels">
      <section class="panel">
        <h2>Workflow Graph</h2>
        ${dag ? renderDagPanel(dag, currentTaskId) : `<div class="subtle">No workflow DAG data available.</div>`}
      </section>
      <section class="panel">
        <h2>Workflow Analysis</h2>
        ${renderWorkflowAnalysisPanel(replanHistory, runtimeAnalysis)}
      </section>
    </div>` : ""}

    <div id="events-container" class="timeline">
      ${events.length === 0
        ? `<div class="empty-state">
            <div class="icon">⏳</div>
            <p>等待事件...</p>
          </div>`
        : events.map((e) => renderEventCard(e)).join("\n")}
    </div>
  </div>

  <script>
    const jobId = ${JSON.stringify(jobId)};
    const container = document.getElementById('events-container');

    // SSE subscription
    const es = new EventSource('/v1/jobs/' + jobId + '/stream');

    es.addEventListener('job.snapshot', (e) => {
      const data = JSON.parse(e.data);
      console.log('Snapshot:', data);
    });

    es.addEventListener('job.event', (e) => {
      const event = JSON.parse(e.data);

      // Remove empty state if present
      const emptyState = container.querySelector('.empty-state');
      if (emptyState) emptyState.remove();

      // Append new event card
      const card = createEventCard(event);
      container.appendChild(card);

      // Auto-scroll
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    es.addEventListener('heartbeat', (e) => {
      // Connection alive
    });

    es.onerror = () => {
      console.warn('SSE connection error, will retry...');
    };

    initializeWorkflowInteractions();

    function createEventCard(event) {
      const failureCategory = typeof event.meta?.failure_category === 'string' ? event.meta.failure_category : '';
      const failureCategoryLabel = typeof event.meta?.failure_category_label === 'string'
        ? event.meta.failure_category_label
        : (failureCategory ? escapeHtml(failureCategory) : '');
      const artifactId = typeof event.meta?.artifact_id === 'string' ? event.meta.artifact_id : '';
      const relatedTaskRunId = typeof event.meta?.related_task_run_id === 'string' ? event.meta.related_task_run_id : '';
      const card = document.createElement('div');
      card.className = 'event-card agent-' + event.agent + ' status-' + event.status;
      card.setAttribute('data-event-type', event.type || '');
      if (event.taskRunId) card.setAttribute('data-task-run-id', event.taskRunId);
      if (artifactId) card.setAttribute('data-artifact-id', artifactId);
      if (relatedTaskRunId) card.setAttribute('data-related-task-run-id', relatedTaskRunId);
      if (event.meta?.tool) card.setAttribute('data-event-tool', event.meta.tool);
      if (failureCategory) card.setAttribute('data-failure-category', failureCategory);
      if (event.meta?.verification_check_name) card.setAttribute('data-verification-check-name', event.meta.verification_check_name);
      if (event.meta?.verification_check_status) card.setAttribute('data-verification-check-status', event.meta.verification_check_status);
      if (Array.isArray(event.meta?.related_artifact_ids)) card.setAttribute('data-related-artifact-ids', event.meta.related_artifact_ids.join(','));
      card.innerHTML = \`
        <div class="event-header">
          <span class="event-title">\${escapeHtml(event.title)}</span>
          <span class="event-time">\${formatTime(event.time)}</span>
        </div>
        <div class="event-summary">\${escapeHtml(event.summary)}</div>
        <div class="event-tags">
          <span class="tag">\${event.agent}</span>
          <span class="tag">\${event.type}</span>
          \${event.step ? '<span class="tag">step ' + event.step + '</span>' : ''}
          \${failureCategoryLabel ? '<span class="tag" title="' + escapeHtml(failureCategory) + '">' + failureCategoryLabel + '</span>' : ''}
        </div>
        <pre class="event-meta">\${escapeHtml(JSON.stringify(event.meta, null, 2))}</pre>
      \`;
      card.addEventListener('click', () => card.classList.toggle('expanded'));
      return card;
    }

    function escapeHtml(text) {
      if (!text) return '';
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatTime(time) {
      if (!time) return '';
      const d = new Date(time);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function initializeWorkflowInteractions() {
      const lanes = Array.from(document.querySelectorAll('.workflow-lane[data-workflow-id]'));
      const historyItems = Array.from(document.querySelectorAll('.history-item[data-superseded-workflow-id], .history-item[data-replacement-workflow-id]'));
      const clearButtons = Array.from(document.querySelectorAll('[data-clear-workflow-focus]'));
      const analysisChips = Array.from(document.querySelectorAll('[data-analysis-filter]'));
      const analysisClearButtons = Array.from(document.querySelectorAll('[data-clear-analysis-filter]'));
      const eventCards = Array.from(document.querySelectorAll('.event-card'));
      const analysisTaskCards = Array.from(document.querySelectorAll('.task-card[data-task-id]'));
      let focusedWorkflowId = null;
      let activeAnalysisFilter = null;
      const focusParamName = 'workflowFocus';
      const analysisKindParamName = 'analysisFilter';
      const analysisValueParamName = 'analysisValue';

      const readFocusedWorkflowIdFromUrl = () => {
        try {
          const url = new URL(window.location.href);
          const raw = url.searchParams.get(focusParamName);
          return raw && raw.trim().length > 0 ? raw.trim() : null;
        } catch {
          return null;
        }
      };

      const writeFocusedWorkflowIdToUrl = (workflowId) => {
        try {
          const url = new URL(window.location.href);
          if (workflowId) {
            url.searchParams.set(focusParamName, workflowId);
          } else {
            url.searchParams.delete(focusParamName);
          }
          window.history.replaceState(null, '', url.toString());
        } catch {
          // Best effort only: focus state still works even if URL persistence fails.
        }
      };

      const readAnalysisFilterFromUrl = () => {
        try {
          const url = new URL(window.location.href);
          const kind = url.searchParams.get(analysisKindParamName);
          const value = url.searchParams.get(analysisValueParamName);
          return kind && value ? { kind, value } : null;
        } catch {
          return null;
        }
      };

      const writeAnalysisFilterToUrl = (kind, value) => {
        try {
          const url = new URL(window.location.href);
          if (kind && value) {
            url.searchParams.set(analysisKindParamName, kind);
            url.searchParams.set(analysisValueParamName, value);
          } else {
            url.searchParams.delete(analysisKindParamName);
            url.searchParams.delete(analysisValueParamName);
          }
          window.history.replaceState(null, '', url.toString());
        } catch {
          // Best effort only: analysis state still works even if URL persistence fails.
        }
      };

      const getHistoryFocusMeta = (item) => {
        const supersededWorkflowId = item.getAttribute('data-superseded-workflow-id');
        const replacementWorkflowId = item.getAttribute('data-replacement-workflow-id');
        const stateEl = item.querySelector('[data-focus-state]');
        const hintEl = item.querySelector('[data-focus-hint]');
        return { supersededWorkflowId, replacementWorkflowId, stateEl, hintEl };
      };

      const updateHistoryItemCopy = (item, activeWorkflowId = null) => {
        const { supersededWorkflowId, replacementWorkflowId, stateEl, hintEl } = getHistoryFocusMeta(item);
        if (!stateEl || !hintEl) {
          return;
        }
        if (!supersededWorkflowId && !replacementWorkflowId) {
          stateEl.hidden = true;
          hintEl.hidden = true;
          return;
        }

        if (!activeWorkflowId) {
          stateEl.hidden = true;
          hintEl.hidden = false;
          hintEl.textContent = supersededWorkflowId
            ? 'Click to focus superseded lane'
            : 'Click to focus replacement lane';
          return;
        }

        stateEl.hidden = false;
        hintEl.hidden = false;
        if (activeWorkflowId === supersededWorkflowId) {
          stateEl.textContent = 'Focused: superseded lane';
          hintEl.textContent = replacementWorkflowId
            ? 'Click again to switch to replacement lane'
            : 'Click again to clear focus';
          return;
        }
        if (activeWorkflowId === replacementWorkflowId) {
          stateEl.textContent = 'Focused: replacement lane';
          hintEl.textContent = supersededWorkflowId
            ? 'Click again to switch to superseded lane'
            : 'Click again to clear focus';
          return;
        }

        stateEl.hidden = true;
        hintEl.hidden = false;
        hintEl.textContent = supersededWorkflowId
          ? 'Click to focus superseded lane'
          : 'Click to focus replacement lane';
      };

      const clearWorkflowFocus = () => {
        focusedWorkflowId = null;
        writeFocusedWorkflowIdToUrl(null);
        lanes.forEach((lane) => {
          lane.classList.remove('is-focused', 'is-focus-dimmed');
        });
        historyItems.forEach((item) => {
          item.classList.remove('is-focused', 'is-dimmed');
          updateHistoryItemCopy(item, null);
        });
      };

      const clearAnalysisFilter = () => {
        activeAnalysisFilter = null;
        writeAnalysisFilterToUrl(null, null);
        analysisChips.forEach((chip) => chip.classList.remove('is-active'));
        eventCards.forEach((card) => {
          card.classList.remove('is-analysis-match', 'is-analysis-dimmed');
        });
        analysisTaskCards.forEach((card) => {
          card.classList.remove('is-analysis-match', 'is-analysis-dimmed');
        });
      };

      const applyAnalysisFilter = (kind, value, sourceChip) => {
        if (!kind || !value) {
          clearAnalysisFilter();
          return null;
        }
        if (activeAnalysisFilter && activeAnalysisFilter.kind === kind && activeAnalysisFilter.value === value) {
          clearAnalysisFilter();
          return null;
        }
        activeAnalysisFilter = { kind, value };
        writeAnalysisFilterToUrl(kind, value);
        let firstMatch = null;
        const matchedTaskIds = new Set();
        const matchedArtifactIds = new Set();
        const matchedWorkflowIds = new Set();
        analysisChips.forEach((chip) => chip.classList.toggle('is-active', chip === sourceChip));
        eventCards.forEach((card) => {
          const eventTool = card.getAttribute('data-event-tool');
          const failureCategory = card.getAttribute('data-failure-category');
          const eventType = card.getAttribute('data-event-type');
          const verificationCheckName = card.getAttribute('data-verification-check-name');
          const verificationCheckStatus = card.getAttribute('data-verification-check-status');
          const relatedArtifactIds = (card.getAttribute('data-related-artifact-ids') || '').split(',').filter(Boolean);
          const taskRunId = card.getAttribute('data-task-run-id');
          const relatedTaskRunId = card.getAttribute('data-related-task-run-id');
          const artifactId = card.getAttribute('data-artifact-id');
          const matches = kind === 'tool'
            ? eventTool === value
            : kind === 'failure_category'
              ? failureCategory === value
              : kind === 'verifier'
                ? eventType === value
                : kind === 'verification_check'
                  ? (verificationCheckName + ':' + verificationCheckStatus) === value
                  : kind === 'artifact'
                    ? artifactId === value || relatedArtifactIds.includes(value)
                    : false;
          card.classList.toggle('is-analysis-match', matches);
          card.classList.toggle('is-analysis-dimmed', !matches);
          if (matches && !firstMatch) {
            firstMatch = card;
            card.classList.add('expanded');
          } else if (!matches) {
            card.classList.remove('expanded');
          }
          if (matches && taskRunId) {
            matchedTaskIds.add(taskRunId);
          }
          if (matches && relatedTaskRunId) {
            matchedTaskIds.add(relatedTaskRunId);
          }
          if (matches && artifactId) {
            matchedArtifactIds.add(artifactId);
          }
          if (matches) {
            relatedArtifactIds.forEach((item) => matchedArtifactIds.add(item));
          }
        });
        analysisTaskCards.forEach((card) => {
          const taskId = card.getAttribute('data-task-id');
          const assignee = card.getAttribute('data-assignee');
          const verified = card.getAttribute('data-verified');
          const workflowId = card.getAttribute('data-workflow-id');
          const matches = kind === 'verifier' || kind === 'verification_check'
            ? assignee === 'verifier' || verified === 'true'
            : kind === 'artifact'
              ? !!taskId && (matchedTaskIds.has(taskId) || matchedArtifactIds.size > 0)
              : !!taskId && matchedTaskIds.has(taskId);
          if (kind === 'verifier' || kind === 'verification_check' || kind === 'artifact') {
            card.classList.toggle('is-analysis-match', matches);
            card.classList.toggle('is-analysis-dimmed', !matches);
            if (matches && workflowId) {
              matchedWorkflowIds.add(workflowId);
            }
          } else {
            card.classList.remove('is-analysis-match', 'is-analysis-dimmed');
          }
        });
        return { firstMatch, matchedWorkflowIds };
      };

      const applyWorkflowFocus = (workflowId, sourceItem) => {
        if (!workflowId) {
          clearWorkflowFocus();
          return;
        }
        focusedWorkflowId = workflowId;
        writeFocusedWorkflowIdToUrl(workflowId);
        lanes.forEach((lane) => {
          const laneWorkflowId = lane.getAttribute('data-workflow-id');
          const focused = laneWorkflowId === workflowId;
          lane.classList.toggle('is-focused', focused);
          lane.classList.toggle('is-focus-dimmed', !focused);
        });
        historyItems.forEach((item) => {
          const focused = item === sourceItem;
          item.classList.toggle('is-focused', focused);
          item.classList.toggle('is-dimmed', !focused);
          updateHistoryItemCopy(item, focused ? workflowId : null);
        });
      };

      clearButtons.forEach((button) => {
        button.addEventListener('click', clearWorkflowFocus);
      });
      analysisClearButtons.forEach((button) => {
        button.addEventListener('click', clearAnalysisFilter);
      });
      analysisChips.forEach((chip) => {
        chip.addEventListener('click', () => {
          const kind = chip.getAttribute('data-analysis-filter');
          const value = chip.getAttribute('data-analysis-value');
          const result = applyAnalysisFilter(kind, value, chip);
          const match = result?.firstMatch || eventCards.find((card) => card.classList.contains('is-analysis-match'));
          const preferredWorkflowId = result?.matchedWorkflowIds?.values()?.next()?.value;
          if (preferredWorkflowId) {
            const matchingHistoryItem = historyItems.find((item) => {
              const { supersededWorkflowId, replacementWorkflowId } = getHistoryFocusMeta(item);
              return supersededWorkflowId === preferredWorkflowId || replacementWorkflowId === preferredWorkflowId;
            }) ?? null;
            applyWorkflowFocus(preferredWorkflowId, matchingHistoryItem);
          }
          match?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      });

      historyItems.forEach((item) => {
        updateHistoryItemCopy(item, null);
        item.addEventListener('click', () => {
          const { supersededWorkflowId, replacementWorkflowId } = getHistoryFocusMeta(item);
          const preferredWorkflowId = supersededWorkflowId || replacementWorkflowId;
          const alternateWorkflowId = supersededWorkflowId && replacementWorkflowId && replacementWorkflowId !== preferredWorkflowId
            ? replacementWorkflowId
            : null;

          let nextWorkflowId = preferredWorkflowId;
          if (focusedWorkflowId === preferredWorkflowId && alternateWorkflowId) {
            nextWorkflowId = alternateWorkflowId;
          } else if (focusedWorkflowId === preferredWorkflowId && !alternateWorkflowId) {
            clearWorkflowFocus();
            return;
          } else if (focusedWorkflowId === alternateWorkflowId && preferredWorkflowId) {
            nextWorkflowId = preferredWorkflowId;
          }

          applyWorkflowFocus(nextWorkflowId, item);
          const targetLane = lanes.find((lane) => lane.getAttribute('data-workflow-id') === nextWorkflowId);
          targetLane?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        });
      });

      const initialFocusedWorkflowId = readFocusedWorkflowIdFromUrl();
      if (initialFocusedWorkflowId) {
        const targetLane = lanes.find((lane) => lane.getAttribute('data-workflow-id') === initialFocusedWorkflowId);
        if (targetLane) {
          const matchingHistoryItem = historyItems.find((item) => {
            const { supersededWorkflowId, replacementWorkflowId } = getHistoryFocusMeta(item);
            return supersededWorkflowId === initialFocusedWorkflowId || replacementWorkflowId === initialFocusedWorkflowId;
          }) ?? null;
          applyWorkflowFocus(initialFocusedWorkflowId, matchingHistoryItem);
        } else {
          writeFocusedWorkflowIdToUrl(null);
        }
      }

      const initialAnalysisFilter = readAnalysisFilterFromUrl();
      if (initialAnalysisFilter) {
        const matchingChip = analysisChips.find((chip) =>
          chip.getAttribute('data-analysis-filter') === initialAnalysisFilter.kind
          && chip.getAttribute('data-analysis-value') === initialAnalysisFilter.value,
        ) || null;
        const result = applyAnalysisFilter(initialAnalysisFilter.kind, initialAnalysisFilter.value, matchingChip);
        const preferredWorkflowId = result?.matchedWorkflowIds?.values()?.next()?.value;
        if (preferredWorkflowId) {
          const matchingHistoryItem = historyItems.find((item) => {
            const { supersededWorkflowId, replacementWorkflowId } = getHistoryFocusMeta(item);
            return supersededWorkflowId === preferredWorkflowId || replacementWorkflowId === preferredWorkflowId;
          }) ?? null;
          applyWorkflowFocus(preferredWorkflowId, matchingHistoryItem);
        }
      }

      const graphRoots = document.querySelectorAll('.workflow-graph');
      graphRoots.forEach((root) => {
        const cards = Array.from(root.querySelectorAll('.task-card[data-task-id]'));
        const edges = Array.from(root.querySelectorAll('.graph-edge[data-from][data-to]'));
        if (cards.length === 0 || edges.length === 0) {
          return;
        }

        const upstream = new Map();
        const downstream = new Map();
        edges.forEach((edge) => {
          const from = edge.getAttribute('data-from');
          const to = edge.getAttribute('data-to');
          if (!from || !to) return;
          if (!downstream.has(from)) downstream.set(from, new Set());
          if (!upstream.has(to)) upstream.set(to, new Set());
          downstream.get(from).add(to);
          upstream.get(to).add(from);
        });

        const walk = (seed, adjacency) => {
          const visited = new Set();
          const stack = [seed];
          while (stack.length > 0) {
            const current = stack.pop();
            if (!current || visited.has(current)) continue;
            visited.add(current);
            const next = adjacency.get(current);
            if (!next) continue;
            next.forEach((value) => {
              if (!visited.has(value)) stack.push(value);
            });
          }
          return visited;
        };

        const clearHighlight = () => {
          cards.forEach((card) => {
            card.classList.remove('is-highlighted', 'is-dimmed');
          });
          edges.forEach((edge) => {
            edge.classList.remove('is-highlighted', 'is-dimmed');
          });
        };

        cards.forEach((card) => {
          card.addEventListener('mouseenter', () => {
            const taskId = card.getAttribute('data-task-id');
            if (!taskId) return;
            const related = new Set([taskId]);
            walk(taskId, upstream).forEach((value) => related.add(value));
            walk(taskId, downstream).forEach((value) => related.add(value));

            cards.forEach((candidate) => {
              const candidateId = candidate.getAttribute('data-task-id');
              const active = !!candidateId && related.has(candidateId);
              candidate.classList.toggle('is-highlighted', active);
              candidate.classList.toggle('is-dimmed', !active);
            });

            edges.forEach((edge) => {
              const from = edge.getAttribute('data-from');
              const to = edge.getAttribute('data-to');
              const active = !!from && !!to && related.has(from) && related.has(to);
              edge.classList.toggle('is-highlighted', active);
              edge.classList.toggle('is-dimmed', !active);
            });
          });
          card.addEventListener('mouseleave', clearHighlight);
        });

        const lane = root.closest('.workflow-lane');
        lane?.addEventListener('click', (event) => {
          const laneElement = event.currentTarget;
          if (!(laneElement instanceof HTMLElement)) return;
          const workflowId = laneElement.getAttribute('data-workflow-id');
          if (!workflowId) return;
          if (focusedWorkflowId === workflowId) {
            clearWorkflowFocus();
            return;
          }
          const matchingHistoryItem = historyItems.find((item) =>
            item.getAttribute('data-superseded-workflow-id') === workflowId || item.getAttribute('data-replacement-workflow-id') === workflowId,
          ) || null;
          applyWorkflowFocus(workflowId, matchingHistoryItem);
        });
      });
    }
  </script>
</body>
</html>`;
}

function renderEventCard(event: WorkflowUiEvent): string {
  const failureCategory = typeof event.meta.failure_category === "string" ? event.meta.failure_category : "";
  const failureCategoryLabel = typeof event.meta.failure_category_label === "string"
    ? event.meta.failure_category_label
    : (failureCategory ? getFailureCategoryLabel(failureCategory) : "");
  const eventTool = typeof event.meta.tool === "string" ? event.meta.tool : "";
  const verificationCheckName = typeof event.meta.verification_check_name === "string" ? event.meta.verification_check_name : "";
  const verificationCheckStatus = typeof event.meta.verification_check_status === "string" ? event.meta.verification_check_status : "";
  const relatedArtifactIds = Array.isArray(event.meta.related_artifact_ids)
    ? event.meta.related_artifact_ids.filter((item): item is string => typeof item === "string")
    : [];
  const artifactId = typeof event.meta.artifact_id === "string" ? event.meta.artifact_id : "";
  const relatedTaskRunId = typeof event.meta.related_task_run_id === "string" ? event.meta.related_task_run_id : "";
  return `<div class="event-card agent-${event.agent} status-${event.status}" data-event-type="${escapeHtmlAttribute(event.type)}"${event.taskRunId ? ` data-task-run-id="${escapeHtmlAttribute(event.taskRunId)}"` : ""}${artifactId ? ` data-artifact-id="${escapeHtmlAttribute(artifactId)}"` : ""}${relatedTaskRunId ? ` data-related-task-run-id="${escapeHtmlAttribute(relatedTaskRunId)}"` : ""}${eventTool ? ` data-event-tool="${escapeHtmlAttribute(eventTool)}"` : ""}${failureCategory ? ` data-failure-category="${escapeHtmlAttribute(failureCategory)}"` : ""}${verificationCheckName ? ` data-verification-check-name="${escapeHtmlAttribute(verificationCheckName)}"` : ""}${verificationCheckStatus ? ` data-verification-check-status="${escapeHtmlAttribute(verificationCheckStatus)}"` : ""}${relatedArtifactIds.length > 0 ? ` data-related-artifact-ids="${escapeHtmlAttribute(relatedArtifactIds.join(","))}"` : ""} onclick="this.classList.toggle('expanded')">
  <div class="event-header">
    <span class="event-title">${escapeHtml(event.title)}</span>
    <span class="event-time">${formatTime(event.time)}</span>
  </div>
  <div class="event-summary">${escapeHtml(event.summary)}</div>
  <div class="event-tags">
    <span class="tag">${event.agent}</span>
    <span class="tag">${event.type}</span>
    ${event.step ? `<span class="tag">step ${event.step}</span>` : ""}
    ${failureCategoryLabel ? `<span class="tag" title="${escapeHtmlAttribute(failureCategory)}">${escapeHtml(failureCategoryLabel)}</span>` : ""}
  </div>
  <pre class="event-meta">${escapeHtml(JSON.stringify(event.meta, null, 2))}</pre>
</div>`;
}

function summarizeFailures(events: WorkflowUiEvent[]): {
  total: number;
  byCategory: Record<string, number>;
  latestCategory: string | null;
  latestSummary: string | null;
} {
  const failures = events
    .filter((event) => typeof event.meta.failure_category === "string" && event.meta.failure_category.trim().length > 0)
    .map((event) => ({
      category: event.meta.failure_category as string,
      summary: event.summary,
    }));
  const byCategory: Record<string, number> = {};
  for (const failure of failures) {
    byCategory[failure.category] = (byCategory[failure.category] ?? 0) + 1;
  }
  const latest = failures.at(-1) ?? null;
  return {
    total: failures.length,
    byCategory,
    latestCategory: latest?.category ?? null,
    latestSummary: latest?.summary ?? null,
  };
}

function formatFailureSummaryText(summary: ReturnType<typeof summarizeFailures>): string {
  if (summary.total === 0) {
    return "";
  }
  const parts = Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `${getFailureCategoryLabel(category)}: ${count}`);
  const latest = summary.latestCategory
    ? `Latest issue: ${getFailureCategoryTitle(summary.latestCategory)}${summary.latestSummary ? ` (${truncate(summary.latestSummary, 80)})` : ""}`
    : "";
  return `Failures: ${summary.total} total${parts.length > 0 ? ` · ${parts.join(", ")}` : ""}${latest ? ` · ${latest}` : ""}`;
}

function formatFailureSummaryDisplay(summary: ReturnType<typeof summarizeFailures>): string {
  if (summary.total === 0) {
    return "";
  }
  const parts = Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `${getFailureCategoryLabel(category)}: ${count}`);
  const latest = summary.latestCategory
    ? `Latest issue: ${getFailureCategoryTitle(summary.latestCategory)}${summary.latestSummary ? ` (${truncate(summary.latestSummary, 80)})` : ""}`
    : "";
  return `Issues: ${summary.total} total${parts.length > 0 ? ` · ${parts.join(", ")}` : ""}${latest ? ` · ${latest}` : ""}`;
}

function summarizeRuntimeAnalysis(events: WorkflowUiEvent[]): {
  hasData: boolean;
  toolUsage: Array<{ name: string; count: number }>;
  blockerPoints: Array<{ label: string; count: number }>;
  verificationSignals: { passed: number; failed: number };
  verificationChecks: Array<{ name: string; status: string; count: number }>;
  artifactSignals: {
    created: number;
    items: Array<{ id: string; label: string; count: number }>;
  };
} {
  const toolCounts = new Map<string, number>();
  const blockerCounts = new Map<string, number>();
  const verificationCheckCounts = new Map<string, { name: string; status: string; count: number }>();
  const artifactCounts = new Map<string, { id: string; label: string; count: number }>();
  let verificationPassed = 0;
  let verificationFailed = 0;
  let artifactCreated = 0;

  for (const event of events) {
    const tool = typeof event.meta.tool === "string" ? event.meta.tool.trim() : "";
    if (tool && (event.type === "tool.start" || event.type === "tool.result" || event.type === "tool.failed")) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }

    if (event.type === "system.verification_passed") {
      verificationPassed += 1;
    }
    if (event.type === "system.verification_failed") {
      verificationFailed += 1;
    }
    if (event.type.startsWith("system.verification_check_")) {
      const name = typeof event.meta.verification_check_name === "string" && event.meta.verification_check_name.trim().length > 0
        ? event.meta.verification_check_name.trim()
        : "verification_check";
      const status = typeof event.meta.verification_check_status === "string" && event.meta.verification_check_status.trim().length > 0
        ? event.meta.verification_check_status.trim()
        : event.status;
      const key = `${name}:${status}`;
      const current = verificationCheckCounts.get(key) ?? { name, status, count: 0 };
      current.count += 1;
      verificationCheckCounts.set(key, current);
    }
    if (event.type === "artifact.created") {
      artifactCreated += 1;
      const artifactId = typeof event.meta.artifact_id === "string" && event.meta.artifact_id.trim().length > 0
        ? event.meta.artifact_id.trim()
        : "";
      if (artifactId) {
        const path = typeof event.meta.path === "string" && event.meta.path.trim().length > 0
          ? event.meta.path.trim()
          : "";
        const label = path ? path.split(/[\\/]/).pop() || artifactId : artifactId;
        const current = artifactCounts.get(artifactId) ?? { id: artifactId, label, count: 0 };
        current.count += 1;
        artifactCounts.set(artifactId, current);
      }
    }

    if (event.status === "blocked" || event.status === "awaiting_approval" || event.type.endsWith(".failed")) {
      const failureCategory = typeof event.meta.failure_category === "string" && event.meta.failure_category.trim().length > 0
        ? event.meta.failure_category.trim()
        : "";
      const label = failureCategory || event.title || event.type;
      blockerCounts.set(label, (blockerCounts.get(label) ?? 0) + 1);
    }
  }

  const toolUsage = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const blockerPoints = [...blockerCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const verificationChecks = [...verificationCheckCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.status.localeCompare(b.status));
  const artifactItems = [...artifactCounts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    hasData: toolUsage.length > 0 || blockerPoints.length > 0 || verificationPassed > 0 || verificationFailed > 0 || verificationChecks.length > 0 || artifactCreated > 0,
    toolUsage,
    blockerPoints,
    verificationSignals: {
      passed: verificationPassed,
      failed: verificationFailed,
    },
    verificationChecks,
    artifactSignals: {
      created: artifactCreated,
      items: artifactItems,
    },
  };
}

function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function formatTime(time: string): string {
  if (!time) return "";
  try {
    const d = new Date(time);
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return time;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function renderDagPanel(
  dag: NonNullable<Parameters<typeof renderTimelineHtml>[4]>["dag"],
  currentTaskId?: string,
): string {
  const workflows = dag?.workflows ?? [];
  if (workflows.length === 0) {
    return `<div class="subtle">No workflow DAG data available.</div>`;
  }
  const header = `<div class="subtle">${dag?.workflow_count ?? workflows.length} workflow lane(s), ${dag?.edge_count ?? 0} dependency edge(s)</div>`;
  const lanes = workflows.map((workflow) => {
    const tasks = workflow.tasks ?? [];
    const laneClass = workflow.status === "superseded" ? "workflow-lane superseded" : "workflow-lane";
    const workflowId = workflow.workflow_id ?? "workflow";
    const graph = renderWorkflowDependencyGraph(tasks, workflow.status === "superseded", workflowId, currentTaskId);
    return `
      <div class="${laneClass}" data-workflow-id="${escapeHtmlAttribute(workflowId)}">
        <div class="lane-header">
          <div class="lane-title">${escapeHtml(workflowId)}</div>
          <div class="lane-meta">${escapeHtml(workflow.status ?? "active")} · ${workflow.completed_count ?? 0}/${workflow.task_count ?? tasks.length} completed</div>
        </div>
        ${workflow.superseded_by ? `<div class="subtle">Superseded by ${escapeHtml(workflow.superseded_by)}</div>` : ""}
        ${graph}
      </div>`;
  }).join("");
  return `${header}<div class="workflow-lanes">${lanes}</div>`;
}

function renderReplanHistoryPanel(replanHistory: NonNullable<Parameters<typeof renderTimelineHtml>[4]>["replan_history"]): string {
  if (!replanHistory || replanHistory.length === 0) {
    return `<div class="subtle">No replans recorded for this workflow.</div>`;
  }
  return `<div class="subtle">${replanHistory.length} replans recorded</div>
  <div class="history-actions">
    <button type="button" class="history-clear" data-clear-workflow-focus>Show all lanes</button>
  </div>
  <div class="history-list">${replanHistory.map((entry) => `
    <div class="history-item"${entry.superseded_workflow_id ? ` data-superseded-workflow-id="${escapeHtmlAttribute(entry.superseded_workflow_id)}"` : ""}${entry.replacement_workflow_id ? ` data-replacement-workflow-id="${escapeHtmlAttribute(entry.replacement_workflow_id)}"` : ""}>
      ${entry.superseded_workflow_id && entry.replacement_workflow_id
        ? `<div><strong>#${entry.index ?? "?"}</strong> ${escapeHtml(entry.superseded_workflow_id)} -> ${escapeHtml(entry.replacement_workflow_id)}</div>
           ${entry.failed_task_id ? `<div class="subtle">Failed task: ${escapeHtml(entry.failed_task_id)}</div>` : ""}
           <div class="history-focus-state" data-focus-state hidden></div>
           <div class="history-focus-hint" data-focus-hint>Click to focus superseded lane</div>`
        : `<div>${escapeHtml(entry.summary ?? `Replan #${entry.index ?? "?"}`)}</div>`}
    </div>`).join("")}</div>`;
}

function renderWorkflowDependencyGraph(
  tasks: NonNullable<NonNullable<NonNullable<Parameters<typeof renderTimelineHtml>[4]>["dag"]>["workflows"]>[number]["tasks"],
  superseded: boolean,
  workflowId: string,
  currentTaskId?: string,
): string {
  if (!tasks || tasks.length === 0) {
    return `<div class="subtle">No tasks in this workflow.</div>`;
  }
  const levels = assignTaskLevels(tasks);
  const maxLevel = Math.max(...tasks.map((task) => levels.get(task.task_id ?? task.id ?? "") ?? 0));
  const columns = Array.from({ length: maxLevel + 1 }, (_, level) =>
    tasks.filter((task) => (levels.get(task.task_id ?? task.id ?? "") ?? 0) === level),
  );
  const columnWidth = 238;
  const cardHeight = 126;
  const cardGap = 12;
  const laneGap = 18;
  const svgWidth = Math.max(360, columns.length * columnWidth + Math.max(0, columns.length - 1) * laneGap);
  let svgHeight = 0;
  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, columnIndex) => {
    column.forEach((task, rowIndex) => {
      const x = columnIndex * (columnWidth + laneGap);
      const y = 26 + rowIndex * (cardHeight + cardGap);
      positions.set(task.task_id ?? task.id ?? "", { x, y });
      svgHeight = Math.max(svgHeight, y + cardHeight);
    });
  });
  const edges = tasks.flatMap((task) => {
    const targetId = task.task_id ?? task.id ?? "";
    const targetPos = positions.get(targetId);
    if (!targetPos || !task.depends_on) {
      return [];
    }
    return task.depends_on.flatMap((depId) => {
      const sourcePos = positions.get(depId);
      if (!sourcePos) {
        return [];
      }
      const startX = sourcePos.x + columnWidth - 8;
      const startY = sourcePos.y + cardHeight / 2;
      const endX = targetPos.x + 8;
      const endY = targetPos.y + cardHeight / 2;
      const bend = Math.max(28, (endX - startX) / 2);
      return [`<path class="graph-edge${superseded ? " superseded" : ""}" data-from="${escapeHtmlAttribute(depId)}" data-to="${escapeHtmlAttribute(targetId)}" data-workflow-id="${escapeHtmlAttribute(workflowId)}" d="M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}" />`];
    });
  }).join("");

  const columnHtml = columns.map((column, columnIndex) => `
    <div class="graph-column">
      <div class="graph-column-label">Stage ${columnIndex + 1}</div>
      ${column.map((task) => `
        <div class="task-card status-${escapeHtml(task.status ?? "pending")}${task.task_id === currentTaskId || task.id === currentTaskId ? " is-current-task" : ""}" data-task-id="${escapeHtmlAttribute(task.task_id ?? task.id ?? "")}" data-workflow-id="${escapeHtmlAttribute(workflowId)}" data-depends-on="${escapeHtmlAttribute((task.depends_on ?? []).join(","))}" data-assignee="${escapeHtmlAttribute(task.assignee ?? "")}" data-verified="${task.verified ? "true" : "false"}">
          <div class="task-card-title">${escapeHtml(task.title ?? task.task_id ?? "task")}</div>
          <div class="task-card-meta">Task: ${escapeHtml(task.task_id ?? task.id ?? "")} · Status: ${escapeHtml(task.status ?? "unknown")}</div>
          ${task.assignee ? `<div class="task-card-meta">Assignee: ${escapeHtml(task.assignee)}</div>` : ""}
          ${typeof task.attempts === "number" ? `<div class="task-card-meta">Attempts: ${task.attempts}${task.verified ? " · verified" : ""}</div>` : ""}
          ${(task.depends_on && task.depends_on.length > 0) ? `<div class="task-card-deps">Depends on: ${escapeHtml(task.depends_on.join(", "))}</div>` : `<div class="task-card-deps">Entry node</div>`}
          ${task.superseded_by ? `<div class="task-card-deps">Superseded by: ${escapeHtml(task.superseded_by)}</div>` : ""}
        </div>`).join("")}
    </div>`).join("");

  return `<div class="workflow-graph">
    <div class="workflow-graph-inner" style="width:${svgWidth}px; min-height:${Math.max(150, svgHeight + 4)}px">
      <svg class="graph-svg" viewBox="0 0 ${svgWidth} ${Math.max(150, svgHeight + 4)}" preserveAspectRatio="none">${edges}</svg>
      <div class="graph-columns">${columnHtml}</div>
    </div>
  </div>`;
}

function renderWorkflowAnalysisPanel(
  replanHistory: NonNullable<Parameters<typeof renderTimelineHtml>[4]>["replan_history"],
  runtimeAnalysis: ReturnType<typeof summarizeRuntimeAnalysis>,
): string {
  const replanSection = `<h3 style="font-size:13px;margin:0 0 10px 0;color:#f0f6fc;">Replan History</h3>${renderReplanHistoryPanel(replanHistory)}`;
  const verificationSection = `<div class="subtle">Verification: ${runtimeAnalysis.verificationSignals.passed} passed, ${runtimeAnalysis.verificationSignals.failed} failed</div>`;
  const analysisActions = `<div class="analysis-actions"><button type="button" class="analysis-clear" data-clear-analysis-filter>Show all events</button></div>`;
  const verificationFilterSection = (runtimeAnalysis.verificationSignals.passed > 0 || runtimeAnalysis.verificationSignals.failed > 0)
    ? `<div class="history-list" style="margin-bottom:12px">
        ${runtimeAnalysis.verificationSignals.passed > 0 ? `<button type="button" class="analysis-chip" data-analysis-filter="verifier" data-analysis-value="system.verification_passed"><strong>Verification passed</strong> · ${runtimeAnalysis.verificationSignals.passed}</button>` : ""}
        ${runtimeAnalysis.verificationSignals.failed > 0 ? `<button type="button" class="analysis-chip" data-analysis-filter="verifier" data-analysis-value="system.verification_failed"><strong>Verification failed</strong> · ${runtimeAnalysis.verificationSignals.failed}</button>` : ""}
      </div>`
    : "";
  const verificationCheckSection = runtimeAnalysis.verificationChecks.length > 0
    ? `<div class="subtle">Verification checks</div><div class="history-list" style="margin-bottom:12px">${runtimeAnalysis.verificationChecks.slice(0, 8).map((entry) => `
        <button type="button" class="analysis-chip" data-analysis-filter="verification_check" data-analysis-value="${escapeHtmlAttribute(`${entry.name}:${entry.status}`)}"><strong>${escapeHtml(entry.name)}</strong> · ${escapeHtml(entry.status)} · ${entry.count}</button>
      `).join("")}</div>`
    : "";
  const artifactSection = runtimeAnalysis.artifactSignals.created > 0
    ? `<div class="subtle">Artifact output</div><div class="history-list" style="margin-bottom:12px">
        <button type="button" class="analysis-chip" data-analysis-filter="artifact_group" data-analysis-value="artifact.created"><strong>Artifacts created</strong> · ${runtimeAnalysis.artifactSignals.created}</button>
        ${runtimeAnalysis.artifactSignals.items.slice(0, 6).map((entry) => `
          <button type="button" class="analysis-chip" data-analysis-filter="artifact" data-analysis-value="${escapeHtmlAttribute(entry.id)}"><strong>${escapeHtml(entry.label)}</strong> · ${entry.count}</button>
        `).join("")}
      </div>`
    : "";
  const toolSection = runtimeAnalysis.toolUsage.length > 0
    ? `<div class="subtle">Tool activity</div><div class="history-list">${runtimeAnalysis.toolUsage.slice(0, 6).map((entry) => `
        <button type="button" class="analysis-chip" data-analysis-filter="tool" data-analysis-value="${escapeHtmlAttribute(entry.name)}"><strong>${escapeHtml(entry.name)}</strong> · ${entry.count}</button>
      `).join("")}</div>`
    : `<div class="subtle">Tool activity will appear once tool events are recorded.</div>`;
  const blockerSection = runtimeAnalysis.blockerPoints.length > 0
    ? `<div class="subtle" style="margin-top:12px">Common issues</div><div class="history-list">${runtimeAnalysis.blockerPoints.slice(0, 6).map((entry) => `
        <button type="button" class="analysis-chip" data-analysis-filter="failure_category" data-analysis-value="${escapeHtmlAttribute(entry.label)}"><strong>${escapeHtml(entry.label)}</strong> · ${entry.count}</button>
      `).join("")}</div>`
    : `<div class="subtle" style="margin-top:12px">No issue signals recorded.</div>`;
  return `${replanSection}<div style="margin-top:16px"><h3 style="font-size:13px;margin:0 0 10px 0;color:#f0f6fc;">Runtime Analysis</h3>${verificationSection}${analysisActions}${verificationFilterSection}${verificationCheckSection}${artifactSection}${toolSection}${blockerSection}</div>`;
}

function assignTaskLevels(
  tasks: NonNullable<NonNullable<NonNullable<Parameters<typeof renderTimelineHtml>[4]>["dag"]>["workflows"]>[number]["tasks"],
): Map<string, number> {
  const taskList = tasks ?? [];
  const tasksById = new Map(taskList.map((task) => [task.task_id ?? task.id ?? "", task]));
  const memo = new Map<string, number>();

  const visit = (taskId: string, visiting: Set<string>): number => {
    if (memo.has(taskId)) {
      return memo.get(taskId)!;
    }
    if (visiting.has(taskId)) {
      return 0;
    }
    visiting.add(taskId);
    const task = tasksById.get(taskId);
    const level = Math.max(
      0,
      ...((task?.depends_on ?? []).map((depId) => visit(depId, visiting) + 1)),
    );
    visiting.delete(taskId);
    memo.set(taskId, level);
    return level;
  };

  for (const task of taskList) {
    visit(task.task_id ?? task.id ?? "", new Set<string>());
  }
  return memo;
}
