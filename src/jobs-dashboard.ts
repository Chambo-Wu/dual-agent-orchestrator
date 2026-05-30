type JobDashboardAction = {
  id?: string;
  label?: string;
  kind?: string;
  href?: string;
  method?: string;
  emphasis?: string;
};

type JobDashboardItem = {
  id: string;
  goal: string;
  mode?: string;
  status: string;
  saved_at?: string;
  verified?: boolean;
  artifact_count?: number;
  step_count?: number;
  latest_step?: {
    status?: string;
    latest_executor_status?: string | null;
  } | null;
  control?: {
    resumedToJobId?: string;
  };
  recovery?: {
    auto_resume_status?: string | null;
    auto_resume_queue_position?: number | null;
    auto_resume_batch_size?: number | null;
    auto_resume_concurrency?: number | null;
    auto_resume_failure_message?: string | null;
  } | null;
  follow?: {
    job_id?: string;
  } | null;
  actions?: JobDashboardAction[];
  timeline_url?: string;
  events_url?: string;
  stream_url?: string;
  intent_route?: {
    kind?: string;
    reason?: string;
    source?: string;
  } | null;
  candidate_skills?: Array<{
    skillId?: string;
    score?: number;
    reasons?: string[];
    source?: string;
  }>;
  selected_skill?: {
    skill_id?: string;
    skill_action?: string;
    skill_install_status?: string;
    skill_reason?: string;
  } | null;
  workflow_summary?: {
    skill_verification?: {
      title?: string;
      verification_status?: string;
      verification_label?: string;
      action_required?: boolean;
      summary?: string | null;
      outcome_summary?: string | null;
      next_action?: string | null;
      missing_requirements?: string[];
    } | null;
    skill_evolution?: {
      proposal_count?: number;
      latest_proposal_id?: string;
      latest_status?: string;
      latest_patch_summary?: string;
      latest_change_summary?: string;
      latest_rationale_summary?: string;
      latest_changed_files?: string[];
      latest_validation_summary?: {
        passed?: boolean;
        reason_code?: string;
        auto_accept_ready?: boolean;
        isolated_replay?: boolean;
        same_input_readiness?: string;
        replay_headline?: string;
        candidate_replay?: {
          status?: string;
          verification_status?: string;
          event_count?: number;
          terminal_event_type?: string;
        } | null;
      } | null;
      latest_ops_summary?: {
        queue_state?: string;
        funnel_stage?: string;
        age_bucket?: string;
        actionable?: boolean;
        blocked_stage?: string | null;
        auto_accept_ready?: boolean;
        auto_accept_eligible?: boolean;
        dynamic_risk_tier?: string;
        dynamic_risk_cooldown_active?: boolean;
        dynamic_risk_cooldown_until?: string | null;
        effective_automation_ceiling?: string | null;
        eligibility_reasons?: string[];
        dynamic_risk_reasons?: string[];
        stuck_state?: {
          stuck?: boolean;
          stage?: string | null;
          reasons?: string[];
        };
        rollback_available?: boolean;
      } | null;
    } | null;
  } | null;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAction(action: JobDashboardAction): string {
  const label = escapeHtml(action.label || "Open");
  const klass = action.emphasis === "primary" ? "action-button primary" : "action-button";
  if (action.kind === "api" && action.method === "POST" && action.href) {
    return `<button type="button" class="${klass}" data-api-action="${escapeHtml(action.href)}">${label}</button>`;
  }
  return `<a class="${klass}" href="${escapeHtml(action.href || "#")}">${label}</a>`;
}

function formatIntentRouteLabel(kind?: string): string {
  switch (kind) {
    case "direct_answer":
      return "Direct Answer";
    case "research":
      return "Research";
    case "goal":
      return "Goal";
    case "coding":
      return "Coding";
    default:
      return kind || "Unknown";
  }
}

export function renderJobsDashboardHtml(
  initialItems: JobDashboardItem[],
  options?: {
    dataUrl?: string;
  },
): string {
  const dataUrl = options?.dataUrl ?? "/v1/jobs";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Job Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d1117;
      color: #c9d1d9;
    }
    .page {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      margin-bottom: 20px;
    }
    .hero h1 {
      margin: 0 0 8px 0;
      font-size: 26px;
      color: #f0f6fc;
    }
    .hero p {
      margin: 0;
      max-width: 760px;
      color: #8b949e;
      font-size: 14px;
      line-height: 1.5;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      min-width: 320px;
      justify-content: flex-end;
    }
    .toolbar input, .toolbar select {
      min-height: 40px;
      min-width: 170px;
      background: #161b22;
      color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .summary-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 14px;
    }
    .summary-label {
      color: #8b949e;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .summary-value {
      color: #f0f6fc;
      font-size: 26px;
      font-weight: 700;
    }
    .status-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .route-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .route-card {
      background: linear-gradient(180deg, rgba(88,166,255,0.12), rgba(17,23,35,0.92));
      border: 1px solid rgba(88,166,255,0.22);
      border-radius: 10px;
      padding: 14px;
      cursor: pointer;
      transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
    }
    .route-card:hover {
      border-color: rgba(88,166,255,0.5);
      transform: translateY(-1px);
    }
    .route-card.active {
      border-color: rgba(88,166,255,0.9);
      box-shadow: 0 0 0 1px rgba(88,166,255,0.25), 0 10px 24px rgba(1, 4, 9, 0.22);
    }
    .route-card-label {
      color: #8cc7ff;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .route-card-value {
      color: #f0f6fc;
      font-size: 24px;
      font-weight: 700;
    }
    .status-tab {
      border: 1px solid #30363d;
      background: #111723;
      color: #c9d1d9;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .status-tab.active {
      background: #1f6feb;
      border-color: #1f6feb;
      color: #f0f6fc;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(380px, 1.2fr) minmax(320px, 0.9fr);
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      overflow: hidden;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid #21262d;
      background: #111723;
    }
    .panel-title {
      margin: 0;
      font-size: 14px;
      color: #f0f6fc;
    }
    .panel-meta {
      color: #8b949e;
      font-size: 12px;
    }
    .loading-banner {
      margin: 10px 10px 0;
      border: 1px solid rgba(88,166,255,0.32);
      border-radius: 8px;
      background: rgba(88,166,255,0.1);
      color: #8cc7ff;
      padding: 10px 12px;
      font-size: 12px;
    }
    .loading-banner[hidden] {
      display: none;
    }
    .pagination {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      padding: 10px 12px 14px;
      border-top: 1px solid #21262d;
      background: #111723;
      flex-wrap: wrap;
    }
    .pagination-meta {
      color: #8b949e;
      font-size: 12px;
    }
    .pagination-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .pagination-button {
      border: 1px solid #30363d;
      background: #161b22;
      color: #c9d1d9;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .pagination-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .job-list {
      padding: 10px;
      display: grid;
      gap: 10px;
      max-height: 70vh;
      overflow: auto;
    }
    .job-card {
      border: 1px solid #2d333b;
      border-radius: 8px;
      padding: 14px;
      background: #0f141b;
      cursor: pointer;
    }
    .job-card:hover {
      border-color: #3b82f6;
      background: #111923;
    }
    .job-card.active {
      border-color: #1f6feb;
      background: #111c2f;
      box-shadow: inset 0 0 0 1px rgba(31,111,235,0.18);
    }
    .job-card-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .job-goal {
      margin: 0;
      color: #f0f6fc;
      font-size: 15px;
      line-height: 1.4;
      font-weight: 600;
    }
    .job-id {
      color: #8b949e;
      font-size: 12px;
      margin-top: 4px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid #30363d;
      padding: 5px 9px;
      font-size: 11px;
      white-space: nowrap;
    }
    .status-running { color: #58a6ff; border-color: rgba(88,166,255,0.45); }
    .status-completed { color: #3fb950; border-color: rgba(63,185,80,0.45); }
    .status-blocked, .status-awaiting_approval { color: #d29922; border-color: rgba(210,153,34,0.45); }
    .status-failed, .status-cancelled { color: #f85149; border-color: rgba(248,81,73,0.45); }
    .job-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 5px 9px;
      background: #161b22;
      border: 1px solid #2d333b;
      color: #8b949e;
      font-size: 11px;
    }
    .chip.route-chip {
      border-color: rgba(88,166,255,0.35);
      background: rgba(88,166,255,0.12);
      color: #8cc7ff;
    }
    .route-subtle {
      color: #8b949e;
      font-size: 11px;
      margin: -2px 0 8px 0;
      line-height: 1.45;
    }
    .job-recovery {
      color: #c9d1d9;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .job-footer {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      color: #8b949e;
      font-size: 12px;
    }
    .detail {
      min-height: 70vh;
      display: flex;
      flex-direction: column;
    }
    .detail-body {
      padding: 16px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .detail-empty {
      padding: 24px 16px;
      color: #8b949e;
      font-size: 14px;
    }
    .detail-heading {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .detail-heading h2 {
      margin: 0 0 6px 0;
      color: #f0f6fc;
      font-size: 20px;
      line-height: 1.35;
    }
    .detail-subtle {
      color: #8b949e;
      font-size: 12px;
      line-height: 1.5;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid #2d333b;
      border-radius: 8px;
      padding: 12px;
      background: #0f141b;
    }
    .metric-label {
      color: #8b949e;
      font-size: 11px;
      margin-bottom: 6px;
    }
    .metric-value {
      color: #f0f6fc;
      font-size: 20px;
      font-weight: 700;
    }
    .section {
      border: 1px solid #2d333b;
      border-radius: 8px;
      padding: 14px;
      background: #0f141b;
    }
    .section h3 {
      margin: 0 0 10px 0;
      font-size: 13px;
      color: #f0f6fc;
    }
    .section p {
      margin: 0;
      color: #c9d1d9;
      font-size: 13px;
      line-height: 1.6;
    }
    .kv {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 8px 12px;
      align-items: start;
      font-size: 13px;
    }
    .kv-key {
      color: #8b949e;
    }
    .kv-value {
      color: #c9d1d9;
      word-break: break-word;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .action-button {
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 8px 12px;
      background: transparent;
      color: #c9d1d9;
      text-decoration: none;
      cursor: pointer;
      font-size: 12px;
    }
    .action-button.primary {
      background: #1f6feb;
      border-color: #1f6feb;
      color: #f0f6fc;
    }
    .empty {
      padding: 30px 18px;
      color: #8b949e;
      text-align: center;
      font-size: 14px;
    }
    @media (max-width: 1100px) {
      .summary {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .route-summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .layout {
        grid-template-columns: 1fr;
      }
      .job-list, .detail {
        max-height: none;
      }
    }
    @media (max-width: 720px) {
      .page {
        padding: 16px;
      }
      .hero {
        flex-direction: column;
      }
      .toolbar {
        width: 100%;
        justify-content: stretch;
      }
      .toolbar input, .toolbar select {
        width: 100%;
      }
      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .route-summary {
        grid-template-columns: 1fr;
      }
      .metrics {
        grid-template-columns: 1fr;
      }
      .kv {
        grid-template-columns: 1fr;
        gap: 4px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div>
        <h1>Job Dashboard</h1>
        <p>Track persisted jobs without digging through raw responses. The list stays live, recovery state is summarized, and follow-up actions stay close to the job that needs them.</p>
      </div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search by goal or job id">
        <select id="status-filter" autocomplete="off">
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="blocked">Blocked</option>
          <option value="awaiting_approval">Awaiting approval</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select id="route-filter" autocomplete="off">
          <option value="">All routes</option>
          <option value="direct_answer">Direct Answer</option>
          <option value="research">Research</option>
          <option value="goal">Goal</option>
          <option value="coding">Coding</option>
        </select>
      </div>
    </div>

    <div id="summary" class="summary"></div>
    <div id="route-summary" class="route-summary"></div>
    <div id="status-tabs" class="status-tabs"></div>

    <div class="layout">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Jobs</h2>
          <div id="list-meta" class="panel-meta"></div>
        </div>
        <div id="loading-banner" class="loading-banner" hidden>Loading jobs...</div>
        <div id="job-list" class="job-list"></div>
        <div id="empty" class="empty" hidden>No jobs matched the current filter.</div>
      </section>

      <aside class="panel detail">
        <div class="panel-header">
          <h2 class="panel-title">Selected Job</h2>
          <div id="detail-meta" class="panel-meta"></div>
        </div>
        <div id="detail" class="detail-body"></div>
      </aside>
    </div>
  </div>

  <script>
    let jobs = [];
    let selectedJobId = jobs.length ? jobs[0].id : '';
    let activeStatusTab = '';
    let activeRouteFilter = '';
    let page = 1;
    let pageSize = 50;
    let totalJobs = 0;
    let totalPages = 1;
    let statusCounts = {};
    let routeCounts = {};
    let refreshTimer = null;
    let searchDebounce = null;
    let loading = false;

    const summary = document.getElementById('summary');
    const routeSummary = document.getElementById('route-summary');
    const statusTabs = document.getElementById('status-tabs');
    const listMeta = document.getElementById('list-meta');
    const detailMeta = document.getElementById('detail-meta');
    const jobList = document.getElementById('job-list');
    const loadingBanner = document.getElementById('loading-banner');
    const pagination = document.createElement('div');
    const detail = document.getElementById('detail');
    const emptyState = document.getElementById('empty');
    const searchInput = document.getElementById('search');
    const statusFilter = document.getElementById('status-filter');
    const routeFilter = document.getElementById('route-filter');
    pagination.id = 'pagination';
    pagination.className = 'pagination';
    jobList.insertAdjacentElement('afterend', pagination);

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function truncate(value, max) {
      const text = String(value || '');
      if (text.length <= max) return text;
      return text.slice(0, Math.max(0, max - 1)) + '...';
    }

    function formatStatus(status) {
      const text = String(status || '').trim();
      if (!text) return 'Unknown';
      return text.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    }

    function normalizeStatus(status) {
      return String(status || '').trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '');
    }

    function statusClass(status) {
      return 'status-badge status-' + String(status || '').replaceAll(/[^a-z_]/g, '');
    }

    function formatTime(value) {
      if (!value) return 'Unknown';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    }

    function formatRelativeTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const diffMs = Date.now() - date.getTime();
      const diffMin = Math.round(diffMs / 60000);
      if (Math.abs(diffMin) < 1) return 'just now';
      if (Math.abs(diffMin) < 60) return diffMin + 'm ago';
      const diffHr = Math.round(diffMin / 60);
      if (Math.abs(diffHr) < 24) return diffHr + 'h ago';
      const diffDay = Math.round(diffHr / 24);
      return diffDay + 'd ago';
    }

    function formatRecovery(item) {
      const recovery = item.recovery || {};
      if (!recovery.auto_resume_status) return 'No active recovery signal.';
      if (recovery.auto_resume_status === 'failed') {
        return recovery.auto_resume_failure_message || 'Automatic resume failed. Manual follow-up is needed.';
      }
      if (recovery.auto_resume_status === 'running') {
        return 'Automatic resume is currently running for this job.';
      }
      if (recovery.auto_resume_status === 'queued') {
        const queueText = typeof recovery.auto_resume_queue_position === 'number' && typeof recovery.auto_resume_batch_size === 'number'
          ? recovery.auto_resume_queue_position + ' of ' + recovery.auto_resume_batch_size
          : 'queued';
        const concurrency = typeof recovery.auto_resume_concurrency === 'number'
          ? ' Service concurrency is ' + recovery.auto_resume_concurrency + '.'
          : '';
        return 'Automatic resume is queued (' + queueText + ').' + concurrency;
      }
      if (recovery.auto_resume_status === 'succeeded' && item.follow && item.follow.job_id) {
        return 'Execution continued in resumed job ' + item.follow.job_id + '.';
      }
      return 'Recovery state: ' + formatStatus(recovery.auto_resume_status) + '.';
    }

    function getIntentKind(item) {
      return item && item.intent_route && item.intent_route.kind ? String(item.intent_route.kind) : 'unknown';
    }

    function latestSummary(item) {
      if (!item.latest_step) {
        return 'No step updates yet.';
      }
      const stepStatus = item.latest_step.status ? formatStatus(item.latest_step.status) : 'Unknown';
      const executorStatus = item.latest_step.latest_executor_status
        ? ' Executor: ' + formatStatus(item.latest_step.latest_executor_status) + '.'
        : '';
      return 'Latest step is ' + stepStatus + '.' + executorStatus;
    }

    function formatSelectedSkill(item) {
      const selectedSkill = item && item.selected_skill ? item.selected_skill : null;
      if (!selectedSkill || !selectedSkill.skill_id) return '';
      const installStatus = selectedSkill.skill_install_status ? ' (' + selectedSkill.skill_install_status + ')' : '';
      return selectedSkill.skill_id + installStatus;
    }

    function formatCandidateSkills(item) {
      const candidates = item && Array.isArray(item.candidate_skills) ? item.candidate_skills : [];
      if (candidates.length === 0) return '';
      return candidates.slice(0, 3).map((candidate) => {
        const skillId = candidate && candidate.skillId ? String(candidate.skillId) : 'unknown';
        const score = candidate && typeof candidate.score === 'number' ? ' (' + String(candidate.score) + ')' : '';
        return skillId + score;
      }).join(', ');
    }

    function formatSkillVerification(item) {
      const verification = item && item.workflow_summary && item.workflow_summary.skill_verification
        ? item.workflow_summary.skill_verification
        : null;
      if (!verification || !verification.verification_status) return '';
      const title = verification.title ? String(verification.title) : 'Skill verification';
      const label = verification.verification_label ? String(verification.verification_label) : String(verification.verification_status);
      const summary = verification.outcome_summary ? ' - ' + String(verification.outcome_summary) : '';
      const nextAction = verification.action_required && verification.next_action ? ' Next: ' + String(verification.next_action) : '';
      return title + ' (' + label + ')' + summary + nextAction;
    }

    function formatSkillEvolution(item) {
      const evolution = item && item.workflow_summary && item.workflow_summary.skill_evolution
        ? item.workflow_summary.skill_evolution
        : null;
      if (!evolution || !evolution.latest_status) return '';
      const proposalCount = typeof evolution.proposal_count === 'number'
        ? ' Proposals: ' + evolution.proposal_count + '.'
        : '';
      const changeSummary = evolution.latest_change_summary ? ' ' + String(evolution.latest_change_summary) : '';
      const rationaleSummary = evolution.latest_rationale_summary ? ' Why: ' + String(evolution.latest_rationale_summary) : '';
      const patchSummary = !changeSummary && evolution.latest_patch_summary ? ' ' + String(evolution.latest_patch_summary) : '';
      const validation = evolution.latest_validation_summary || null;
      const replaySummary = validation && validation.isolated_replay
        ? ' Replay: ' + String(validation.same_input_readiness || 'unknown')
          + ', ' + String(validation.candidate_replay && validation.candidate_replay.terminal_event_type
            ? validation.candidate_replay.terminal_event_type
            : 'no_terminal_event')
          + ', ' + String(validation.candidate_replay && typeof validation.candidate_replay.event_count === 'number'
            ? validation.candidate_replay.event_count
            : 0) + ' events.'
        : '';
      const decisionSummary = validation && validation.reason_code
        ? ' Decision: ' + String(validation.reason_code) + '.'
        : '';
      const ops = evolution.latest_ops_summary || null;
      const opsSummary = ops && ops.queue_state
        ? ' Ops: ' + String(ops.queue_state) + ', ' + String(ops.funnel_stage || 'unknown_stage') + ', ' + String(ops.age_bucket || 'unknown_age') + '.'
        : '';
      const eligibilitySummary = ops && ops.auto_accept_eligible === false && Array.isArray(ops.eligibility_reasons) && ops.eligibility_reasons.length > 0
        ? ' Eligibility: ' + String(ops.eligibility_reasons[0]) + '.'
        : '';
      const dynamicRiskSummary = ops && ops.dynamic_risk_tier
        ? ' Dynamic risk: ' + String(ops.dynamic_risk_tier)
          + (ops.effective_automation_ceiling ? ', ceiling ' + String(ops.effective_automation_ceiling) : '') + '.'
        : '';
      const cooldownSummary = ops && ops.dynamic_risk_cooldown_active
        ? ' Cooldown: active until ' + String(ops.dynamic_risk_cooldown_until || 'unknown') + '.'
        : '';
      const stuckSummary = ops && ops.stuck_state && ops.stuck_state.stuck && Array.isArray(ops.stuck_state.reasons) && ops.stuck_state.reasons.length > 0
        ? ' Stuck: ' + String(ops.stuck_state.reasons[0]) + '.'
        : '';
      const blockSummary = ops && ops.blocked_stage
        ? ' Blocked: ' + String(ops.blocked_stage) + '.'
        : '';
      return String(evolution.latest_status) + '.' + proposalCount + changeSummary + patchSummary + rationaleSummary + decisionSummary + replaySummary + opsSummary + eligibilitySummary + dynamicRiskSummary + cooldownSummary + stuckSummary + blockSummary;
    }

    function renderActions(actions, item) {
      const merged = Array.isArray(actions) ? [...actions] : [];
      if (item && item.timeline_url) {
        merged.push({
          id: 'open_timeline',
          label: 'Open Timeline',
          kind: 'link',
          href: item.timeline_url,
          emphasis: merged.length === 0 ? 'primary' : 'secondary',
        });
      }
      if (item && item.events_url) {
        merged.push({
          id: 'open_events',
          label: 'Events',
          kind: 'link',
          href: item.events_url,
          emphasis: 'secondary',
        });
      }
      if (merged.length === 0) {
        return '<span class="detail-subtle">No direct action</span>';
      }
      return '<div class="actions">' + merged.map((action) => {
        const label = escapeHtml(action.label || 'Open');
        const klass = action.emphasis === 'primary' ? 'action-button primary' : 'action-button';
        if (action.kind === 'api' && action.method === 'POST' && action.href) {
          return '<button type="button" class="' + klass + '" data-api-action="' + escapeHtml(action.href) + '">' + label + '</button>';
        }
        return '<a class="' + klass + '" href="' + escapeHtml(action.href || '#') + '">' + label + '</a>';
      }).join('') + '</div>';
    }

    function ensureSelectedJob(items) {
      if (!items.length) {
        selectedJobId = '';
        return null;
      }
      const existing = items.find((item) => item.id === selectedJobId);
      if (existing) return existing;
      selectedJobId = items[0].id;
      return items[0];
    }

    function readCount(map, key) {
      if (!map) return 0;
      return Number(map[key] || 0);
    }

    function sumCounts(map) {
      if (!map) return 0;
      return Object.values(map).reduce((total, value) => total + Number(value || 0), 0);
    }

    function renderSummary() {
      const cards = [
        ['Visible Jobs', totalJobs],
        ['Running', readCount(statusCounts, 'running')],
        ['Blocked', readCount(statusCounts, 'blocked')],
        ['Needs Approval', readCount(statusCounts, 'awaiting_approval')],
        ['Failed', readCount(statusCounts, 'failed')],
      ];
      summary.innerHTML = cards.map(([label, value]) =>
        '<div class="summary-card"><div class="summary-label">' + escapeHtml(String(label)) + '</div><div class="summary-value">' + escapeHtml(String(value)) + '</div></div>'
      ).join('');
    }

    function renderRouteSummary() {
      const cards = [
        ['direct_answer', 'Direct Answer', readCount(routeCounts, 'direct_answer')],
        ['research', 'Research', readCount(routeCounts, 'research')],
        ['goal', 'Goal', readCount(routeCounts, 'goal')],
        ['coding', 'Coding', readCount(routeCounts, 'coding')],
      ];
      routeSummary.innerHTML = cards.map(([kind, label, value]) =>
        '<button type="button" class="route-card' + ((activeRouteFilter || '') === kind ? ' active' : '') + '" data-route-card="' + escapeHtml(String(kind)) + '"><div class="route-card-label">' + escapeHtml(String(label)) + '</div><div class="route-card-value">' + escapeHtml(String(value)) + '</div></button>'
      ).join('');
      routeSummary.querySelectorAll('[data-route-card]').forEach((card) => {
        card.addEventListener('click', () => {
          const nextRoute = card.getAttribute('data-route-card') || '';
          activeRouteFilter = activeRouteFilter === nextRoute ? '' : nextRoute;
          routeFilter.value = activeRouteFilter;
          page = 1;
          void refreshJobs();
        });
      });
    }

    function renderTabs() {
      const tabs = [
        { value: '', label: 'All', count: sumCounts(statusCounts) },
        { value: 'running', label: 'Running', count: readCount(statusCounts, 'running') },
        { value: 'blocked', label: 'Blocked', count: readCount(statusCounts, 'blocked') },
        { value: 'awaiting_approval', label: 'Needs Approval', count: readCount(statusCounts, 'awaiting_approval') },
        { value: 'failed', label: 'Failed', count: readCount(statusCounts, 'failed') },
        { value: 'completed', label: 'Completed', count: readCount(statusCounts, 'completed') },
      ];
      statusTabs.innerHTML = tabs.map((tab) => {
        const active = (activeStatusTab || '') === tab.value ? ' active' : '';
        return '<button type="button" class="status-tab' + active + '" data-status-tab="' + escapeHtml(tab.value) + '">' + escapeHtml(tab.label) + ' (' + escapeHtml(String(tab.count)) + ')</button>';
      }).join('');
      statusTabs.querySelectorAll('[data-status-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          const nextStatus = button.getAttribute('data-status-tab') || '';
          activeStatusTab = nextStatus;
          statusFilter.value = activeStatusTab;
          page = 1;
          void refreshJobs();
        });
      });
    }

    function renderJobList(items) {
      loadingBanner.hidden = !loading;
      listMeta.textContent = loading
        ? 'Loading jobs...'
        : 'Page ' + page + ' of ' + totalPages + ' - ' + items.length + ' shown of ' + totalJobs;
      emptyState.hidden = items.length > 0 || loading;
      jobList.style.display = items.length > 0 ? 'grid' : (loading ? 'grid' : 'none');
      jobList.innerHTML = loading && items.length === 0
        ? '<div class="empty">Loading jobs...</div>'
        : items.map((item) => {
        const active = item.id === selectedJobId ? ' active' : '';
        const recovery = formatRecovery(item);
        const saved = formatRelativeTime(item.saved_at) || formatTime(item.saved_at);
        return '<article class="job-card' + active + '" data-job-id="' + escapeHtml(item.id) + '">'
          + '<div class="job-card-top"><div><h3 class="job-goal">' + escapeHtml(truncate(item.goal || 'Untitled job', 120)) + '</h3><div class="job-id">' + escapeHtml(item.id) + '</div></div><span class="' + statusClass(item.status) + '">' + escapeHtml(formatStatus(item.status)) + '</span></div>'
          + '<div class="job-strip">'
          + '<span class="chip">' + escapeHtml(formatStatus(item.mode || 'task')) + '</span>'
          + (item.intent_route && item.intent_route.kind ? '<span class="chip route-chip">Route: ' + escapeHtml(formatIntentRouteLabel(item.intent_route.kind)) + '</span>' : '')
          + (item.selected_skill && item.selected_skill.skill_id ? '<span class="chip route-chip">Skill: ' + escapeHtml(formatSelectedSkill(item)) + '</span>' : '')
          + '<span class="chip">' + escapeHtml(String(item.step_count || 0)) + ' steps</span>'
          + '<span class="chip">' + escapeHtml(String(item.artifact_count || 0)) + ' artifacts</span>'
          + '<span class="chip">' + escapeHtml(item.verified === true ? 'Verified' : item.verified === false ? 'Needs verification' : 'Verification n/a') + '</span>'
          + '</div>'
          + (item.intent_route && item.intent_route.reason ? '<div class="route-subtle">' + escapeHtml(item.intent_route.reason) + '</div>' : '')
          + '<div class="job-recovery">' + escapeHtml(recovery) + '</div>'
          + '<div class="job-footer"><span>' + escapeHtml(latestSummary(item)) + '</span><span>' + escapeHtml(saved) + '</span></div>'
          + '</article>';
      }).join('');
      jobList.querySelectorAll('[data-job-id]').forEach((card) => {
        card.addEventListener('click', () => {
          selectedJobId = card.getAttribute('data-job-id') || '';
          renderDetail(jobs.find((item) => item.id === selectedJobId) || null);
          jobList.querySelectorAll('[data-job-id]').forEach((itemCard) => {
            itemCard.classList.toggle('active', itemCard.getAttribute('data-job-id') === selectedJobId);
          });
        });
      });
    }

    function renderDetail(item) {
      if (!item) {
        detailMeta.textContent = 'No selection';
        detail.innerHTML = '<div class="detail-empty">Pick a job from the left to see its current state, recovery note, and direct actions.</div>';
        return;
      }
      detailMeta.textContent = formatTime(item.saved_at);
      const resumedTo = item.control && item.control.resumedToJobId ? item.control.resumedToJobId : '';
      detail.innerHTML = ''
        + '<div class="detail-heading"><div><h2>' + escapeHtml(item.goal || 'Untitled job') + '</h2><div class="detail-subtle">' + escapeHtml(item.id) + '</div></div><span class="' + statusClass(item.status) + '">' + escapeHtml(formatStatus(item.status)) + '</span></div>'
        + '<div class="metrics">'
        +   '<div class="metric"><div class="metric-label">Steps</div><div class="metric-value">' + escapeHtml(String(item.step_count || 0)) + '</div></div>'
        +   '<div class="metric"><div class="metric-label">Artifacts</div><div class="metric-value">' + escapeHtml(String(item.artifact_count || 0)) + '</div></div>'
        +   '<div class="metric"><div class="metric-label">Verification</div><div class="metric-value" style="font-size:15px">' + escapeHtml(item.verified === true ? 'Verified' : item.verified === false ? 'Pending' : 'N/A') + '</div></div>'
        + '</div>'
        + '<section class="section"><h3>Recovery</h3><p>' + escapeHtml(formatRecovery(item)) + '</p></section>'
        + '<section class="section"><h3>Current Readout</h3><div class="kv">'
        +   '<div class="kv-key">Mode</div><div class="kv-value">' + escapeHtml(formatStatus(item.mode || 'task')) + '</div>'
        +   '<div class="kv-key">Intent route</div><div class="kv-value">' + escapeHtml(item.intent_route && item.intent_route.kind ? formatIntentRouteLabel(item.intent_route.kind) : 'Unknown') + (item.intent_route && item.intent_route.source ? ' - ' + escapeHtml(item.intent_route.source) : '') + '</div>'
        +   '<div class="kv-key">Route reason</div><div class="kv-value">' + escapeHtml(item.intent_route && item.intent_route.reason ? item.intent_route.reason : 'Not recorded') + '</div>'
        +   '<div class="kv-key">Selected skill</div><div class="kv-value">' + escapeHtml(formatSelectedSkill(item) || 'Not recorded') + '</div>'
        +   '<div class="kv-key">Skill candidates</div><div class="kv-value">' + escapeHtml(formatCandidateSkills(item) || 'Not recorded') + '</div>'
        +   '<div class="kv-key">Skill verification</div><div class="kv-value">' + escapeHtml(formatSkillVerification(item) || 'Not recorded') + '</div>'
        +   '<div class="kv-key">Skill evolution</div><div class="kv-value">' + escapeHtml(formatSkillEvolution(item) || 'Not recorded') + '</div>'
        +   '<div class="kv-key">Latest step</div><div class="kv-value">' + escapeHtml(latestSummary(item)) + '</div>'
        +   '<div class="kv-key">Saved</div><div class="kv-value">' + escapeHtml(formatTime(item.saved_at)) + '</div>'
        +   '<div class="kv-key">Resumed to</div><div class="kv-value">' + escapeHtml(resumedTo || (item.follow && item.follow.job_id) || '-') + '</div>'
        + '</div></section>'
        + (item.selected_skill && item.selected_skill.skill_reason ? '<section class="section"><h3>Skill Selection</h3><p>' + escapeHtml(item.selected_skill.skill_reason) + '</p></section>' : '')
        + '<section class="section"><h3>Actions</h3>' + renderActions(item.actions, item) + '</section>';
      bindApiActions();
    }

    function renderPagination() {
      pagination.innerHTML = ''
        + '<div class="pagination-meta">Page ' + page + ' of ' + totalPages + ' - ' + totalJobs + ' total</div>'
        + '<div class="pagination-actions">'
        + '<button type="button" class="pagination-button" data-page-prev' + (page <= 1 ? ' disabled' : '') + '>Prev</button>'
        + '<button type="button" class="pagination-button" data-page-next' + (page >= totalPages ? ' disabled' : '') + '>Next</button>'
        + '</div>';
      pagination.querySelector('[data-page-prev]').addEventListener('click', () => {
        if (page <= 1) return;
        page -= 1;
        void refreshJobs();
      });
      pagination.querySelector('[data-page-next]').addEventListener('click', () => {
        if (page >= totalPages) return;
        page += 1;
        void refreshJobs();
      });
    }

    function renderDashboard() {
      renderSummary();
      renderRouteSummary();
      renderTabs();
      renderJobList(jobs);
      renderPagination();
      const selected = ensureSelectedJob(jobs);
      renderDetail(selected);
    }

    function buildDataUrl() {
      const url = new URL('${dataUrl}', window.location.origin);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(pageSize));
      if (activeStatusTab) url.searchParams.set('status', activeStatusTab);
      if (activeRouteFilter) url.searchParams.set('route', activeRouteFilter);
      const query = (searchInput.value || '').trim();
      if (query) url.searchParams.set('q', query);
      return url.toString();
    }

    async function refreshJobs() {
      loading = true;
      renderDashboard();
      try {
        const response = await fetch(buildDataUrl());
        if (!response.ok) return;
        const payload = await response.json();
        jobs = Array.isArray(payload.data) ? payload.data : [];
        const paginationData = payload.pagination || {};
        page = typeof paginationData.page === 'number' ? paginationData.page : page;
        pageSize = typeof paginationData.page_size === 'number' ? paginationData.page_size : pageSize;
        totalJobs = typeof paginationData.total === 'number' ? paginationData.total : jobs.length;
        totalPages = typeof paginationData.total_pages === 'number' ? paginationData.total_pages : Math.max(1, Math.ceil(totalJobs / Math.max(pageSize, 1)));
        statusCounts = payload.counts && payload.counts.by_status ? payload.counts.by_status : {};
        routeCounts = payload.counts && payload.counts.by_route ? payload.counts.by_route : {};
        loading = false;
        if (jobs.length > 0) {
          selectedJobId = jobs.some((item) => item.id === selectedJobId) ? selectedJobId : jobs[0].id;
        } else {
          selectedJobId = '';
        }
        renderDashboard();
      } catch {
        // Ignore polling failures.
      } finally {
        loading = false;
        renderDashboard();
      }
    }

    function bindApiActions() {
      document.querySelectorAll('[data-api-action]').forEach((button) => {
        if (button.dataset.bound === 'true') return;
        button.dataset.bound = 'true';
        button.addEventListener('click', async () => {
          const href = button.getAttribute('data-api-action');
          if (!href) return;
          const original = button.textContent || 'Run';
          button.textContent = 'Starting...';
          button.disabled = true;
          try {
            const response = await fetch(href, { method: 'POST' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            await refreshJobs();
          } catch {
            button.textContent = original;
            button.disabled = false;
          }
        });
      });
    }

    searchInput.value = '';
    statusFilter.value = '';
    routeFilter.value = '';

    searchInput.addEventListener('input', () => {
      if (searchDebounce) {
        clearTimeout(searchDebounce);
      }
      page = 1;
      searchDebounce = setTimeout(() => {
        void refreshJobs();
      }, 250);
    });
    statusFilter.addEventListener('change', () => {
      activeStatusTab = normalizeStatus(statusFilter.value || '');
      statusFilter.value = activeStatusTab;
      page = 1;
      void refreshJobs();
    });
    routeFilter.addEventListener('change', () => {
      activeRouteFilter = routeFilter.value || '';
      page = 1;
      void refreshJobs();
    });

    renderDashboard();
    void refreshJobs();
    refreshTimer = setInterval(refreshJobs, 5000);
  </script>
</body>
</html>`;
}
