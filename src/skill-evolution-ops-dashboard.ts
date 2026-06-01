type SkillEvolutionOpsPayload = {
  summary?: Record<string, unknown>;
  proposal_queue?: Array<Record<string, unknown>>;
  accepted_history?: Array<Record<string, unknown>>;
  rollback_guides?: Array<Record<string, unknown>>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSkillEvolutionOpsDashboardHtml(
  initialPayload: SkillEvolutionOpsPayload,
  options?: {
    dataUrl?: string;
  },
): string {
  const dataUrl = options?.dataUrl ?? "/skill-evolution/ops/data";
  const initialJson = JSON.stringify(initialPayload).replaceAll("</", "<\\/");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skill Evolution Ops</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --panel-soft: #111723;
      --border: #30363d;
      --text: #f0f6fc;
      --muted: #8b949e;
      --accent: #58a6ff;
      --success: #3fb950;
      --warn: #d29922;
      --danger: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 40px;
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    .subtle { color: var(--muted); font-size: 12px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .button, .tab {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      text-decoration: none;
      font: inherit;
    }
    .button:hover, .tab:hover, .tab.active {
      border-color: rgba(88,166,255,0.72);
      background: var(--panel-soft);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      padding: 12px;
      min-height: 74px;
    }
    .metric-label { color: var(--muted); font-size: 12px; }
    .metric-value { font-size: 24px; font-weight: 700; margin-top: 5px; }
    .layout {
      display: grid;
      grid-template-columns: minmax(360px, 0.9fr) minmax(420px, 1.1fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      min-height: 160px;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
    }
    .panel-header h2 { margin: 0; font-size: 15px; }
    .tabs { display: flex; gap: 8px; padding: 12px 14px 0; flex-wrap: wrap; }
    .tab { font-size: 12px; }
    .list { display: grid; gap: 10px; padding: 14px; }
    .item {
      width: 100%;
      text-align: left;
      border: 1px solid var(--border);
      background: #0d1117;
      color: var(--text);
      border-radius: 8px;
      padding: 11px;
      cursor: pointer;
    }
    .item:hover, .item.active { border-color: rgba(88,166,255,0.8); background: var(--panel-soft); }
    .item-title { font-weight: 650; margin-bottom: 4px; overflow-wrap: anywhere; }
    .item-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border);
      background: rgba(48,54,61,0.42);
      color: var(--muted);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .chip.success { color: var(--success); border-color: rgba(63,185,80,0.45); }
    .chip.warn { color: var(--warn); border-color: rgba(210,153,34,0.45); }
    .chip.danger { color: var(--danger); border-color: rgba(248,81,73,0.45); }
    .detail { padding: 14px; display: grid; gap: 14px; }
    .detail h3 { margin: 0 0 8px; font-size: 13px; }
    .kv {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 8px 12px;
    }
    .kv-key { color: var(--muted); }
    .kv-value { overflow-wrap: anywhere; }
    .section {
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }
    .bar-grid { display: grid; gap: 8px; }
    .bar-row { display: grid; grid-template-columns: 130px 1fr 44px; gap: 8px; align-items: center; }
    .bar-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { height: 8px; background: #0d1117; border-radius: 999px; border: 1px solid var(--border); overflow: hidden; }
    .bar-fill { height: 100%; background: var(--accent); }
    .empty { color: var(--muted); padding: 18px; }
    @media (max-width: 900px) {
      main { width: min(100vw - 20px, 760px); padding-top: 16px; }
      header { align-items: flex-start; flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
      .kv { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 92px 1fr 36px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Skill Evolution Ops</h1>
        <div class="subtle" id="generated-at">Generated from local control-plane state</div>
      </div>
      <div class="toolbar">
        <a class="button" href="/jobs/dashboard">Jobs</a>
        <button type="button" class="button" id="refresh">Refresh</button>
      </div>
    </header>
    <section class="metrics" id="metrics"></section>
    <section class="layout">
      <div class="panel">
        <div class="panel-header">
          <h2>Queues</h2>
          <span class="subtle" id="list-meta"></span>
        </div>
        <div class="tabs" id="tabs"></div>
        <div class="list" id="list"></div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Proposal Detail</h2>
          <span class="subtle" id="detail-meta"></span>
        </div>
        <div class="detail" id="detail"></div>
      </div>
    </section>
  </main>
  <script>
    const dataUrl = '${escapeHtml(dataUrl)}';
    let payload = ${initialJson};
    let activeTab = 'queue';
    let selectedId = '';

    const metrics = document.getElementById('metrics');
    const generatedAt = document.getElementById('generated-at');
    const listMeta = document.getElementById('list-meta');
    const tabs = document.getElementById('tabs');
    const list = document.getElementById('list');
    const detail = document.getElementById('detail');
    const detailMeta = document.getElementById('detail-meta');

    function escapeHtmlClient(value) {
      return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function asArray(value) { return Array.isArray(value) ? value : []; }
    function summary() { return payload && payload.summary ? payload.summary : {}; }
    function count(value) { return Number(value || 0); }
    function statusClass(value) {
      const text = String(value || '');
      if (text.includes('failed') || text === 'high') return 'danger';
      if (text.includes('blocked') || text.includes('over_') || text === 'medium') return 'warn';
      if (text.includes('accepted') || text === 'low' || text === 'validated') return 'success';
      return '';
    }
    function readPath(object, path, fallback = '') {
      let current = object;
      for (const key of path) {
        if (!current || typeof current !== 'object') return fallback;
        current = current[key];
      }
      return current ?? fallback;
    }
    function currentItems() {
      if (activeTab === 'accepted') return asArray(payload.accepted_history);
      if (activeTab === 'rollback') return asArray(payload.rollback_guides);
      if (activeTab === 'stuck') {
        return asArray(payload.proposal_queue).filter((item) => readPath(item, ['ops_summary', 'stuck_state', 'stuck'], false) === true);
      }
      return asArray(payload.proposal_queue);
    }
    function itemId(item) {
      return String(item.id || item.proposal_id || '');
    }
    function renderMetrics() {
      const s = summary();
      const cards = [
        ['Queue', s.queue_count],
        ['Accepted', s.accepted_count],
        ['Rollback', s.rollback_available_count],
        ['Stuck', s.stuck_count],
        ['High Risk', readPath(s, ['dynamic_risk', 'high'], 0)],
        ['Over 1h', readPath(s, ['aging_buckets', 'over_1h'], 0) + readPath(s, ['aging_buckets', 'over_24h'], 0)],
      ];
      metrics.innerHTML = cards.map(([label, value]) => '<div class="metric"><div class="metric-label">' + escapeHtmlClient(label) + '</div><div class="metric-value">' + escapeHtmlClient(count(value)) + '</div></div>').join('');
      generatedAt.textContent = payload.generated_at ? 'Generated ' + new Date(payload.generated_at).toLocaleString() : 'Generated from local control-plane state';
    }
    function renderTabs() {
      const tabsData = [
        ['queue', 'Proposal Queue', asArray(payload.proposal_queue).length],
        ['accepted', 'Accepted History', asArray(payload.accepted_history).length],
        ['rollback', 'Rollback Guides', asArray(payload.rollback_guides).length],
        ['stuck', 'Stuck', asArray(payload.proposal_queue).filter((item) => readPath(item, ['ops_summary', 'stuck_state', 'stuck'], false) === true).length],
      ];
      tabs.innerHTML = tabsData.map(([id, label, value]) => '<button type="button" class="tab' + (activeTab === id ? ' active' : '') + '" data-tab="' + id + '">' + escapeHtmlClient(label) + ' (' + escapeHtmlClient(value) + ')</button>').join('');
      tabs.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          activeTab = button.getAttribute('data-tab') || 'queue';
          selectedId = '';
          render();
        });
      });
    }
    function renderBars(title, map) {
      const entries = Object.entries(map || {});
      if (entries.length === 0) return '';
      const max = Math.max(1, ...entries.map(([, value]) => count(value)));
      return '<div class="section"><h3>' + escapeHtmlClient(title) + '</h3><div class="bar-grid">' + entries.map(([label, value]) => {
        const width = Math.round((count(value) / max) * 100);
        return '<div class="bar-row"><div class="bar-label">' + escapeHtmlClient(label) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><div>' + escapeHtmlClient(count(value)) + '</div></div>';
      }).join('') + '</div></div>';
    }
    function renderItem(item) {
      const id = itemId(item);
      const status = String(item.status || (item.rollback_available === true ? 'rollback_available' : 'rollback_missing'));
      const ops = item.ops_summary || {};
      const title = item.skill_id ? String(item.skill_id) + ' / ' + id : id;
      const selected = id && id === selectedId ? ' active' : '';
      const age = ops.age_bucket || item.age_bucket || '';
      const stuck = readPath(ops, ['stuck_state', 'stuck'], false);
      return '<button type="button" class="item' + selected + '" data-id="' + escapeHtmlClient(id) + '">'
        + '<div class="item-title">' + escapeHtmlClient(title || 'proposal') + '</div>'
        + '<div class="subtle">' + escapeHtmlClient(item.change_summary || item.patch_summary || item.reason || 'No summary') + '</div>'
        + '<div class="item-meta">'
        + '<span class="chip ' + statusClass(status) + '">' + escapeHtmlClient(status) + '</span>'
        + (ops.funnel_stage ? '<span class="chip">' + escapeHtmlClient(ops.funnel_stage) + '</span>' : '')
        + (age ? '<span class="chip ' + statusClass(age) + '">' + escapeHtmlClient(age) + '</span>' : '')
        + (ops.dynamic_risk_tier ? '<span class="chip ' + statusClass(ops.dynamic_risk_tier) + '">risk ' + escapeHtmlClient(ops.dynamic_risk_tier) + '</span>' : '')
        + (stuck ? '<span class="chip warn">stuck</span>' : '')
        + '</div></button>';
    }
    function renderList() {
      const items = currentItems();
      if (!selectedId && items.length > 0) selectedId = itemId(items[0]);
      listMeta.textContent = String(items.length) + ' item(s)';
      list.innerHTML = items.length === 0 ? '<div class="empty">No items in this view.</div>' : items.map(renderItem).join('');
      list.querySelectorAll('[data-id]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedId = button.getAttribute('data-id') || '';
          render();
        });
      });
    }
    function selectedItem() {
      const id = selectedId;
      return currentItems().find((item) => itemId(item) === id) || null;
    }
    function renderDetail() {
      const item = selectedItem();
      if (!item) {
        detailMeta.textContent = 'No selection';
        detail.innerHTML = '<div class="empty">Select a proposal, accepted item, or rollback guide.</div>'
          + renderBars('Funnel', readPath(payload, ['summary', 'funnel'], {}))
          + renderBars('Aging', readPath(payload, ['summary', 'aging_buckets'], {}))
          + renderBars('Dynamic Risk', readPath(payload, ['summary', 'dynamic_risk'], {}))
          + renderBars('Stuck Categories', readPath(payload, ['summary', 'stuck_categories'], {}));
        return;
      }
      const ops = item.ops_summary || {};
      const validation = item.validation_summary || {};
      const rollback = item.rollback || item;
      const stuckReasons = asArray(readPath(ops, ['stuck_state', 'reasons'], []));
      const stuckCategories = asArray(readPath(ops, ['stuck_state', 'categories'], []));
      const eligibilityReasons = asArray(ops.eligibility_reasons || readPath(item, ['eligibility', 'reasons'], []));
      const replayPayloads = asArray(validation.runtime_replay_task_payloads);
      const categorySummary = stuckCategories.map((category) => String(category.category || 'stuck') + ':' + String(category.severity || 'unknown') + ' - ' + String(category.action_hint || category.reason || '')).join(' | ');
      detailMeta.textContent = item.created_at ? new Date(item.created_at).toLocaleString() : '';
      detail.innerHTML = '<div class="kv">'
        + '<div class="kv-key">ID</div><div class="kv-value">' + escapeHtmlClient(itemId(item)) + '</div>'
        + '<div class="kv-key">Skill</div><div class="kv-value">' + escapeHtmlClient(item.skill_id || '') + '</div>'
        + '<div class="kv-key">Status</div><div class="kv-value">' + escapeHtmlClient(item.status || '') + '</div>'
        + '<div class="kv-key">Queue State</div><div class="kv-value">' + escapeHtmlClient(ops.queue_state || '') + '</div>'
        + '<div class="kv-key">Funnel</div><div class="kv-value">' + escapeHtmlClient(ops.funnel_stage || '') + '</div>'
        + '<div class="kv-key">Age</div><div class="kv-value">' + escapeHtmlClient(ops.age_bucket || '') + '</div>'
        + '<div class="kv-key">Risk</div><div class="kv-value">' + escapeHtmlClient(ops.dynamic_risk_tier || readPath(item, ['dynamic_risk', 'tier'], '')) + '</div>'
        + '<div class="kv-key">Auto Accept</div><div class="kv-value">' + escapeHtmlClient(String(ops.auto_accept_eligible ?? validation.auto_accept_ready ?? false)) + '</div>'
        + '<div class="kv-key">Replay Stability</div><div class="kv-value">' + escapeHtmlClient(validation.replay_stability_score ?? 'n/a') + '</div>'
        + '<div class="kv-key">Rollback</div><div class="kv-value">' + escapeHtmlClient(rollback.rollback_available === true ? rollback.rollback_path || 'available' : 'not available') + '</div>'
        + '</div>'
        + '<div class="section"><h3>Change</h3><div class="subtle">' + escapeHtmlClient(item.change_summary || item.patch_summary || 'No change summary') + '</div></div>'
        + '<div class="section"><h3>Blockers</h3><div class="subtle">' + escapeHtmlClient([...stuckReasons, ...eligibilityReasons].join(' | ') || 'No blocker reasons recorded.') + '</div></div>'
        + '<div class="section"><h3>Stuck Categories</h3><div class="subtle">' + escapeHtmlClient(categorySummary || 'No stuck category recorded.') + '</div></div>'
        + '<div class="section"><h3>Validation</h3><div class="subtle">' + escapeHtmlClient(validation.replay_headline || validation.reason_code || 'No validation summary') + '</div></div>'
        + '<div class="section"><h3>Replay Tasks</h3><div class="subtle">' + escapeHtmlClient(replayPayloads.map((task) => String(task.title || task.taskRunId || 'task') + ':' + String(task.status || 'unknown')).join(' | ') || 'No runtime replay task payloads recorded.') + '</div></div>'
        + '<div class="section"><h3>Rollback Guide</h3><div class="subtle">' + escapeHtmlClient(asArray(rollback.guide).join(' | ') || 'No rollback guide available.') + '</div></div>';
    }
    function render() {
      renderMetrics();
      renderTabs();
      renderList();
      renderDetail();
    }
    async function refresh() {
      try {
        const response = await fetch(dataUrl);
        if (!response.ok) return;
        payload = await response.json();
        selectedId = '';
        render();
      } catch {}
    }
    document.getElementById('refresh').addEventListener('click', () => { void refresh(); });
    render();
  </script>
</body>
</html>`;
}
