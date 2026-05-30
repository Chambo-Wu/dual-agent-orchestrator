import type { GoalStatus, GoalTaskStatus } from "./goal-types.js";

type GoalDashboardAction = {
  label: string;
  href?: string;
  method?: string;
  kind?: "link" | "api";
  emphasis?: "primary" | "secondary";
};

export type GoalDashboardItem = {
  id: string;
  goal: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
  completed_task_count: number;
  total_task_count: number;
  current_task?: {
    id: string;
    title: string;
    status: GoalTaskStatus;
    mode: string;
  } | null;
  final_review_status: string;
  timeline_url: string;
  events_url: string;
  detail_url: string;
  actions: GoalDashboardAction[];
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function summarize(items: GoalDashboardItem[]): Record<string, number> {
  const byStatus: Record<string, number> = {
    all: items.length,
    ready: 0,
    running: 0,
    blocked: 0,
    waiting_review: 0,
    completed: 0,
    failed: 0,
    initializing: 0,
  };
  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  }
  return byStatus;
}

export function renderGoalsDashboardHtml(
  initialItems: GoalDashboardItem[],
  options?: { dataUrl?: string },
): string {
  const dataUrl = options?.dataUrl ?? "/v1/goals";
  const summary = summarize(initialItems);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Goal Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1220;
      color: #dce7f3;
    }
    .page {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      margin-bottom: 18px;
    }
    .hero h1 {
      margin: 0 0 8px 0;
      font-size: 28px;
      color: #f8fbff;
    }
    .hero p {
      margin: 0;
      color: #9db0c3;
      max-width: 820px;
      line-height: 1.5;
      font-size: 14px;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
      min-width: 280px;
    }
    .toolbar input, .toolbar select {
      min-height: 40px;
      min-width: 180px;
      border-radius: 10px;
      border: 1px solid #314158;
      background: #111a2b;
      color: #dce7f3;
      padding: 8px 12px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .summary-card, .panel {
      background: #111a2b;
      border: 1px solid #223149;
      border-radius: 14px;
    }
    .summary-card {
      padding: 14px;
    }
    .summary-label {
      color: #8ea2b8;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .summary-value {
      font-size: 26px;
      font-weight: 700;
      color: #f8fbff;
    }
    .status-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .status-tab {
      border: 1px solid #314158;
      border-radius: 999px;
      background: #0f1726;
      color: #dce7f3;
      padding: 8px 12px;
      cursor: pointer;
    }
    .status-tab.active {
      background: #2d6cdf;
      border-color: #2d6cdf;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(420px, 1.2fr) minmax(320px, 0.9fr);
      gap: 16px;
    }
    .panel-header {
      padding: 16px 18px;
      border-bottom: 1px solid #223149;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-header h2 {
      margin: 0;
      font-size: 16px;
    }
    .goal-list {
      display: flex;
      flex-direction: column;
    }
    .goal-row {
      padding: 16px 18px;
      border-top: 1px solid #1d2a40;
      cursor: pointer;
    }
    .goal-row:first-child {
      border-top: 0;
    }
    .goal-row.active {
      background: linear-gradient(90deg, rgba(45,108,223,0.16), rgba(17,26,43,0.96));
    }
    .goal-title {
      margin: 0 0 10px 0;
      color: #f8fbff;
      font-size: 15px;
      line-height: 1.4;
    }
    .meta, .details-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 999px;
      background: #0c1422;
      border: 1px solid #2b3a52;
      color: #a8bbcf;
      font-size: 12px;
    }
    .panel-body {
      padding: 18px;
    }
    .details-grid {
      margin-bottom: 14px;
    }
    .detail-block {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      background: #0c1422;
      border: 1px solid #223149;
      margin-bottom: 12px;
    }
    .detail-block h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
      color: #8ea2b8;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .detail-block p {
      margin: 0;
      line-height: 1.5;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .action-button {
      appearance: none;
      text-decoration: none;
      border: 1px solid #314158;
      background: #15243b;
      color: #dce7f3;
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      font: inherit;
    }
    .action-button.primary {
      background: #2d6cdf;
      border-color: #2d6cdf;
      color: #ffffff;
    }
    .empty {
      padding: 22px 18px;
      color: #8ea2b8;
    }
    @media (max-width: 980px) {
      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .layout {
        grid-template-columns: 1fr;
      }
      .hero {
        flex-direction: column;
      }
      .toolbar {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div>
        <h1>Goal Dashboard</h1>
        <p>Review persisted goals, inspect their current task and final review state, then jump into each goal timeline or continue execution from the built-in controls.</p>
      </div>
      <div class="toolbar">
        <input id="goal-search" type="search" placeholder="Search goals">
        <select id="status-filter">
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="running">Running</option>
          <option value="blocked">Blocked</option>
          <option value="waiting_review">Waiting review</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="initializing">Initializing</option>
        </select>
      </div>
    </section>

    <section class="summary">
      <div class="summary-card"><div class="summary-label">Total</div><div class="summary-value">${summary.all}</div></div>
      <div class="summary-card"><div class="summary-label">Ready</div><div class="summary-value">${summary.ready}</div></div>
      <div class="summary-card"><div class="summary-label">Running</div><div class="summary-value">${summary.running}</div></div>
      <div class="summary-card"><div class="summary-label">Blocked</div><div class="summary-value">${summary.blocked}</div></div>
      <div class="summary-card"><div class="summary-label">Waiting Review</div><div class="summary-value">${summary.waiting_review}</div></div>
      <div class="summary-card"><div class="summary-label">Completed</div><div class="summary-value">${summary.completed}</div></div>
    </section>

    <div class="status-tabs" id="status-tabs"></div>

    <section class="layout">
      <div class="panel">
        <div class="panel-header">
          <h2>Goals</h2>
          <span id="result-count">${initialItems.length} items</span>
        </div>
        <div id="goal-list" class="goal-list"></div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Details</h2>
          <a class="action-button" id="open-detail-link" href="#">Open JSON</a>
        </div>
        <div id="goal-detail" class="panel-body"></div>
      </div>
    </section>
  </div>

  <script>
    const initialItems = ${JSON.stringify(initialItems)};
    const dataUrl = ${JSON.stringify(dataUrl)};
    let allItems = Array.isArray(initialItems) ? initialItems : [];
    let activeStatus = '';
    let activeId = allItems[0]?.id || '';

    const goalList = document.getElementById('goal-list');
    const goalDetail = document.getElementById('goal-detail');
    const goalSearch = document.getElementById('goal-search');
    const statusFilter = document.getElementById('status-filter');
    const resultCount = document.getElementById('result-count');
    const statusTabs = document.getElementById('status-tabs');
    const openDetailLink = document.getElementById('open-detail-link');

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function formatDate(value) {
      if (!value) return 'n/a';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function renderStatusTabs(items) {
      const counts = items.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});
      const tabs = [
        { value: '', label: 'All', count: items.length },
        { value: 'ready', label: 'Ready', count: counts.ready || 0 },
        { value: 'running', label: 'Running', count: counts.running || 0 },
        { value: 'blocked', label: 'Blocked', count: counts.blocked || 0 },
        { value: 'waiting_review', label: 'Waiting review', count: counts.waiting_review || 0 },
        { value: 'completed', label: 'Completed', count: counts.completed || 0 },
        { value: 'failed', label: 'Failed', count: counts.failed || 0 },
      ];
      statusTabs.innerHTML = tabs.map((tab) => {
        const active = activeStatus === tab.value ? 'active' : '';
        return '<button class="status-tab ' + active + '" data-status-tab="' + tab.value + '">' + tab.label + ' (' + tab.count + ')</button>';
      }).join('');
      statusTabs.querySelectorAll('[data-status-tab]').forEach((node) => {
        node.addEventListener('click', () => {
          const nextStatus = node.getAttribute('data-status-tab') || '';
          activeStatus = activeStatus === nextStatus ? '' : nextStatus;
          statusFilter.value = activeStatus;
          render();
        });
      });
    }

    function filteredItems() {
      const keyword = (goalSearch.value || '').trim().toLowerCase();
      return allItems.filter((item) => {
        if (activeStatus && item.status !== activeStatus) return false;
        if (!keyword) return true;
        return item.goal.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword);
      });
    }

    function renderList(items) {
      resultCount.textContent = items.length + ' items';
      if (!items.length) {
        goalList.innerHTML = '<div class="empty">No matching goals.</div>';
        return;
      }
      if (!items.some((item) => item.id === activeId)) {
        activeId = items[0].id;
      }
      goalList.innerHTML = items.map((item) => {
        const active = item.id === activeId ? 'active' : '';
        const currentTask = item.current_task ? item.current_task.title : 'No active task';
        return '<article class="goal-row ' + active + '" data-goal-id="' + item.id + '">'
          + '<h3 class="goal-title">' + escapeHtml(item.goal) + '</h3>'
          + '<div class="meta">'
          + '<span class="chip">' + item.status + '</span>'
          + '<span class="chip">' + item.completed_task_count + '/' + item.total_task_count + ' tasks</span>'
          + '<span class="chip">' + escapeHtml(currentTask) + '</span>'
          + '</div>'
          + '</article>';
      }).join('');
      goalList.querySelectorAll('[data-goal-id]').forEach((node) => {
        node.addEventListener('click', () => {
          activeId = node.getAttribute('data-goal-id') || '';
          render();
        });
      });
    }

    function renderDetail(item) {
      if (!item) {
        goalDetail.innerHTML = '<div class="empty">Select a goal to inspect it.</div>';
        openDetailLink.href = '#';
        return;
      }
      openDetailLink.href = item.detail_url;
      const actions = Array.isArray(item.actions) ? item.actions : [];
      goalDetail.innerHTML = ''
        + '<div class="detail-block"><h3>Goal</h3><p>' + escapeHtml(item.goal) + '</p></div>'
        + '<div class="details-grid">'
        + '<span class="chip">Status: ' + item.status + '</span>'
        + '<span class="chip">Tasks: ' + item.completed_task_count + '/' + item.total_task_count + '</span>'
        + '<span class="chip">Final review: ' + item.final_review_status + '</span>'
        + '</div>'
        + '<div class="detail-block"><h3>Current Task</h3><p>' + escapeHtml(item.current_task ? item.current_task.title + ' (' + item.current_task.status + ')' : 'No current task') + '</p></div>'
        + '<div class="detail-block"><h3>Timestamps</h3><p>Created: ' + formatDate(item.created_at) + '<br>Updated: ' + formatDate(item.updated_at) + '</p></div>'
        + '<div class="actions">' + actions.map((action) => {
            const klass = action.emphasis === 'primary' ? 'action-button primary' : 'action-button';
            if (action.kind === 'api' && action.method === 'POST' && action.href) {
              return '<button type="button" class="' + klass + '" data-api-action="' + action.href + '">' + escapeHtml(action.label) + '</button>';
            }
            return '<a class="' + klass + '" href="' + (action.href || '#') + '">' + escapeHtml(action.label) + '</a>';
          }).join('') + '</div>';

      goalDetail.querySelectorAll('[data-api-action]').forEach((node) => {
        node.addEventListener('click', async () => {
          const href = node.getAttribute('data-api-action');
          if (!href) return;
          node.disabled = true;
          try {
            const response = await fetch(href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}));
              throw new Error(payload?.error?.message || 'Request failed');
            }
            await refresh();
          } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
          } finally {
            node.disabled = false;
          }
        });
      });
    }

    function render() {
      const items = filteredItems();
      renderStatusTabs(allItems);
      renderList(items);
      renderDetail(items.find((item) => item.id === activeId) || null);
    }

    async function refresh() {
      const response = await fetch(dataUrl);
      const payload = await response.json();
      allItems = Array.isArray(payload?.data) ? payload.data : [];
      render();
    }

    goalSearch.addEventListener('input', render);
    statusFilter.addEventListener('change', () => {
      activeStatus = statusFilter.value || '';
      render();
    });

    render();
  </script>
</body>
</html>`;
}
