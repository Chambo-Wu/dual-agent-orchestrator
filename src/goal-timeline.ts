import type { GoalEventRecord, GoalRecord } from "./goal-types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

export function renderGoalTimelineHtml(
  record: GoalRecord,
  events: GoalEventRecord[],
  options?: {
    routeBasePath?: string;
    apiBasePath?: string;
  },
): string {
  const routeBasePath = options?.routeBasePath ?? "/v1/goals";
  const apiBasePath = options?.apiBasePath ?? routeBasePath;
  const currentTask = record.tasks.find((task) => task.id === record.currentTaskId) ?? null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Goal Timeline - ${escapeHtml(record.id)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f3efe8;
      color: #1f2430;
    }
    .page {
      max-width: 1320px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
      gap: 16px;
      margin-bottom: 18px;
    }
    .card {
      background: rgba(255,255,255,0.88);
      border: 1px solid rgba(84,69,49,0.14);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 10px 30px rgba(48, 35, 16, 0.06);
    }
    h1, h2, h3, p {
      margin-top: 0;
    }
    h1 {
      margin-bottom: 10px;
      font-size: 30px;
    }
    .subtle {
      color: #6b6f78;
      line-height: 1.5;
    }
    .chips, .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #f6f1e7;
      border: 1px solid #ddcfb7;
      font-size: 12px;
      color: #5c5242;
    }
    .action-button {
      appearance: none;
      text-decoration: none;
      border: 1px solid #b89e72;
      background: #fffaf1;
      color: #4d3e24;
      border-radius: 11px;
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
    }
    .action-button.primary {
      background: #b56a2f;
      border-color: #b56a2f;
      color: #ffffff;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
      gap: 16px;
    }
    .timeline {
      position: relative;
      padding-left: 24px;
    }
    .timeline::before {
      content: "";
      position: absolute;
      left: 8px;
      top: 8px;
      bottom: 8px;
      width: 2px;
      background: linear-gradient(180deg, #b56a2f, #dfc8a1);
    }
    .event {
      position: relative;
      margin-bottom: 14px;
      padding: 14px 14px 14px 18px;
      border-radius: 14px;
      background: #fffdf8;
      border: 1px solid #eadcc4;
    }
    .event::before {
      content: "";
      position: absolute;
      left: -22px;
      top: 18px;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #b56a2f;
      box-shadow: 0 0 0 4px #f3efe8;
    }
    .event h3 {
      margin-bottom: 6px;
      font-size: 15px;
    }
    .event p {
      margin-bottom: 8px;
      line-height: 1.45;
    }
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .task {
      padding: 12px;
      border-radius: 12px;
      background: #fffdf8;
      border: 1px solid #eadcc4;
    }
    .task-title {
      margin: 0 0 8px 0;
      font-size: 14px;
    }
    pre {
      margin: 10px 0 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      color: #5c5242;
      background: #f8f3ea;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #eadcc4;
    }
    @media (max-width: 980px) {
      .hero, .layout {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="card">
        <h1>Goal Timeline</h1>
        <p class="subtle">${escapeHtml(record.goal)}</p>
        <div class="chips">
          <span class="chip">Goal ID: ${escapeHtml(record.id)}</span>
          <span class="chip">Status: ${escapeHtml(record.status)}</span>
          <span class="chip">Tasks: ${record.completedTaskCount}/${record.tasks.length}</span>
          <span class="chip">Final review: ${escapeHtml(record.finalReview.status)}</span>
        </div>
      </div>
      <div class="card">
        <h2>Controls</h2>
        <div class="actions">
          <button type="button" class="action-button primary" data-api-action="${escapeHtml(`${apiBasePath}/${record.id}/run-next`)}">Run Next</button>
          <button type="button" class="action-button" data-api-action="${escapeHtml(`${apiBasePath}/${record.id}/retry`)}">Retry</button>
          <button type="button" class="action-button" data-api-action="${escapeHtml(`${apiBasePath}/${record.id}/resume`)}">Resume</button>
          <button type="button" class="action-button" data-api-action="${escapeHtml(`${apiBasePath}/${record.id}/review`)}">Review</button>
          <a class="action-button" href="${escapeHtml(`${routeBasePath}/${record.id}`)}">Open JSON</a>
          <a class="action-button" href="${escapeHtml(`${routeBasePath}/${record.id}/events`)}">Events JSON</a>
        </div>
        <p class="subtle" style="margin-top:12px;">Current task: ${escapeHtml(currentTask ? currentTask.title : "None")}</p>
      </div>
    </section>

    <section class="layout">
      <div class="card">
        <h2>Events</h2>
        <div class="timeline">
          ${events.length === 0
            ? `<div class="event"><h3>No events yet</h3><p class="subtle">This goal has been created, but it has not emitted any persisted timeline events yet.</p></div>`
            : events.map((event) => `
              <article class="event">
                <h3>${escapeHtml(event.title)}</h3>
                <p>${escapeHtml(event.summary)}</p>
                <div class="chips">
                  <span class="chip">${escapeHtml(event.type)}</span>
                  <span class="chip">${escapeHtml(event.status)}</span>
                  <span class="chip">${escapeHtml(event.time)}</span>
                </div>
                ${event.meta && Object.keys(event.meta).length > 0 ? `<pre>${escapeHtml(JSON.stringify(event.meta, null, 2))}</pre>` : ""}
              </article>
            `).join("")}
        </div>
      </div>
      <div class="card">
        <h2>Planned Tasks</h2>
        <div class="task-list">
          ${record.tasks.map((task) => `
            <article class="task">
              <h3 class="task-title">${escapeHtml(task.title)}</h3>
              <div class="chips">
                <span class="chip">${escapeHtml(task.status)}</span>
                <span class="chip">${escapeHtml(task.mode)}</span>
                <span class="chip">${escapeHtml(task.kind)}</span>
                ${task.lastJobId ? `<span class="chip">Job: ${escapeHtml(task.lastJobId)}</span>` : ""}
              </div>
              <p class="subtle" style="margin:10px 0 0 0;">${escapeHtml(truncate(task.description, 220))}</p>
              ${task.outputSummary ? `<pre>${escapeHtml(task.outputSummary)}</pre>` : ""}
            </article>
          `).join("")}
        </div>
      </div>
    </section>
  </div>

  <script>
    document.querySelectorAll('[data-api-action]').forEach((node) => {
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
          window.location.reload();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
          node.disabled = false;
        }
      });
    });
  </script>
</body>
</html>`;
}
