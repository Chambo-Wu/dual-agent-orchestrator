import type { WorkflowUiEvent } from "./workflow-ui-events.js";

// ---------------------------------------------------------------------------
// Timeline HTML Generator
// ---------------------------------------------------------------------------

export function renderTimelineHtml(
  jobId: string,
  events: WorkflowUiEvent[],
  goal?: string,
  status?: string,
): string {
  const latestStep = events.reduce((max, e) => Math.max(max, e.step ?? 0), 0);

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
      </div>
    </div>

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

    function createEventCard(event) {
      const card = document.createElement('div');
      card.className = 'event-card agent-' + event.agent + ' status-' + event.status;
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
  </script>
</body>
</html>`;
}

function renderEventCard(event: WorkflowUiEvent): string {
  return `<div class="event-card agent-${event.agent} status-${event.status}" onclick="this.classList.toggle('expanded')">
  <div class="event-header">
    <span class="event-title">${escapeHtml(event.title)}</span>
    <span class="event-time">${formatTime(event.time)}</span>
  </div>
  <div class="event-summary">${escapeHtml(event.summary)}</div>
  <div class="event-tags">
    <span class="tag">${event.agent}</span>
    <span class="tag">${event.type}</span>
    ${event.step ? `<span class="tag">step ${event.step}</span>` : ""}
  </div>
  <pre class="event-meta">${escapeHtml(JSON.stringify(event.meta, null, 2))}</pre>
</div>`;
}

function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
