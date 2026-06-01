const titles = {
  run: ["执行模型任务", "选择模型路由、执行模式与审批策略。"],
  models: ["模型与角色", "配置 OpenAI-compatible 模型、agent role 和执行路由。"],
  jobs: ["Jobs Dashboard", "查看任务历史、时间线、事件、artifact 与恢复动作。"],
  goals: ["Goals Dashboard", "管理 GoalMode 的计划、run-next、retry、resume 与 review。"],
  skills: ["Skill Evolution Ops", "查看 proposal queue、accepted history、rollback guide 与运营指标。"],
  health: ["运行健康", "查看模型健康、服务日志与当前配置路径。"],
};

let appState = null;
let serverStatus = null;
let currentView = "run";
let currentJob = null;
let eventSource = null;
let logLines = [];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function optionList(items, selected, label = (item) => item.label || item.id) {
  return items.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selected ? " selected" : ""}>${escapeHtml(label(item))}</option>`).join("");
}

function apiBase() {
  return serverStatus?.apiBase || `http://127.0.0.1:${appState?.port || 9898}`;
}

function setView(view) {
  currentView = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  $("#view-title").textContent = titles[view][0];
  $("#view-subtitle").textContent = titles[view][1];
  loadView(view);
}

function renderServer() {
  const running = Boolean(serverStatus?.running);
  $("#server-dot").classList.toggle("running", running);
  $("#server-label").textContent = running ? `running ${serverStatus.pid || ""}` : "stopped";
  $("#api-base").textContent = apiBase();
}

function renderRunForm() {
  $("#task-route").innerHTML = optionList(appState.routes, appState.activeRouteId);
  $("#route-pill").textContent = appState.activeRouteId;
}

function modelTemplate(model, index) {
  return `
    <article class="item" data-model-index="${index}">
      <div class="item-grid">
        <label><span>ID</span><input data-field="id" value="${escapeHtml(model.id)}"></label>
        <label><span>名称</span><input data-field="label" value="${escapeHtml(model.label)}"></label>
        <label><span>角色</span>
          <select data-field="role">
            ${["planner", "executor", "worker", "verifier", "synthesizer", "planner_proxy"].map((role) => `<option value="${role}"${role === model.role ? " selected" : ""}>${role}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="item-grid">
        <label><span>API URL</span><input data-field="baseUrl" value="${escapeHtml(model.baseUrl)}"></label>
        <label><span>API Key</span><input data-field="apiKey" type="password" value="${escapeHtml(model.apiKey)}"></label>
        <label><span>模型 ID</span><input data-field="modelId" value="${escapeHtml(model.modelId)}"></label>
      </div>
      <div class="item-grid">
        <label><span>Timeout</span><input data-field="timeoutMs" type="number" min="1" value="${model.timeoutMs}"></label>
        <label><span>Max Tokens</span><input data-field="maxTokens" type="number" min="1" value="${model.maxTokens}"></label>
        <label><span>Temperature</span><input data-field="temperature" type="number" step="0.1" value="${model.temperature}"></label>
      </div>
      <div class="item-grid">
        <label><span>允许工具</span><input data-field="toolsAllow" value="${escapeHtml(model.toolsAllow || "")}"></label>
        <label><span>禁用工具</span><input data-field="toolsDeny" value="${escapeHtml(model.toolsDeny || "")}"></label>
        <label><span>并发</span><input data-field="maxConcurrency" type="number" min="1" value="${model.maxConcurrency || 1}"></label>
      </div>
      <div class="item-actions">
        <button data-remove-model="${index}">删除</button>
      </div>
    </article>
  `;
}

function routeTemplate(route, index) {
  return `
    <article class="item" data-route-index="${index}">
      <div class="item-grid wide">
        <label><span>ID</span><input data-field="id" value="${escapeHtml(route.id)}"></label>
        <label><span>名称</span><input data-field="label" value="${escapeHtml(route.label)}"></label>
      </div>
      <div class="item-grid wide">
        <label><span>Planner</span><select data-field="plannerModelId">${optionList(appState.models, route.plannerModelId, (item) => `${item.label} · ${item.modelId}`)}</select></label>
        <label><span>Executor</span><select data-field="executorModelId">${optionList(appState.models, route.executorModelId, (item) => `${item.label} · ${item.modelId}`)}</select></label>
      </div>
      <label><span>描述</span><input data-field="description" value="${escapeHtml(route.description || "")}"></label>
      <div class="item-actions">
        <button data-remove-route="${index}">删除</button>
      </div>
    </article>
  `;
}

function renderModels() {
  $("#models-list").innerHTML = appState.models.map(modelTemplate).join("");
  $("#routes-list").innerHTML = appState.routes.map(routeTemplate).join("");
  $("#server-api-key").value = appState.apiKey;
  $("#server-port").value = appState.port;
}

function collectModelsState() {
  const models = $$("#models-list .item").map((item) => {
    const read = (field) => item.querySelector(`[data-field="${field}"]`)?.value?.trim() || "";
    return {
      id: read("id"),
      label: read("label"),
      role: read("role"),
      baseUrl: read("baseUrl"),
      apiKey: read("apiKey"),
      modelId: read("modelId"),
      timeoutMs: Number(read("timeoutMs")) || 60000,
      maxTokens: Number(read("maxTokens")) || 4096,
      temperature: Number(read("temperature")),
      toolsAllow: read("toolsAllow"),
      toolsDeny: read("toolsDeny"),
      maxConcurrency: Number(read("maxConcurrency")) || 1,
    };
  }).filter((model) => model.id && model.baseUrl && model.modelId);

  const routes = $$("#routes-list .item").map((item) => {
    const read = (field) => item.querySelector(`[data-field="${field}"]`)?.value?.trim() || "";
    return {
      id: read("id"),
      label: read("label"),
      plannerModelId: read("plannerModelId"),
      executorModelId: read("executorModelId"),
      description: read("description"),
    };
  }).filter((route) => route.id && route.plannerModelId && route.executorModelId);

  return {
    ...appState,
    apiKey: $("#server-api-key").value.trim() || "dual-agent-local",
    port: Number($("#server-port").value) || 9898,
    activeRouteId: routes.some((route) => route.id === appState.activeRouteId) ? appState.activeRouteId : routes[0]?.id,
    models,
    routes,
  };
}

function appendEventLine(line) {
  const log = $("#event-log");
  log.textContent = `${line}\n${log.textContent}`.slice(0, 12000);
}

function renderJobSummary(goal, output, status) {
  const parts = [];
  if (goal) parts.push(`Goal\n${goal}`);
  if (output) {
    parts.push(`${status === "failed" ? "Failure" : "Final Answer"}\n${output}`);
  } else if (status && status !== "running") {
    parts.push(`Status\n${status}`);
  }
  $("#job-summary").textContent = parts.join("\n\n").trim();
}

function renderJobLinks(jobId) {
  currentJob = jobId;
  $("#open-job").disabled = !jobId;
  $("#open-timeline").disabled = !jobId;
  $("#open-events").disabled = !jobId;
}

async function refreshJobResult(jobId) {
  if (!jobId || currentJob !== jobId) return;
  const result = await window.desktop.apiRequest(`/v1/jobs/${encodeURIComponent(jobId)}`);
  if (!result.ok) return;
  const job = result.body?.job || {};
  $("#job-status").textContent = job.status || $("#job-status").textContent || "completed";
  renderJobSummary(job.goal || "", job.output || "", job.status || "");
}

function connectJobStream(jobId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${apiBase()}/jobs/${encodeURIComponent(jobId)}/stream`);
  eventSource.addEventListener("job.snapshot", (event) => {
    const data = JSON.parse(event.data);
    $("#job-status").textContent = data.status || "running";
    renderJobSummary(data.goal || "", data.output_preview || "", data.status || "running");
  });
  eventSource.addEventListener("job.event", (event) => {
    const data = JSON.parse(event.data);
    appendEventLine(`[${data.status}] ${data.type} · ${data.title || data.summary || ""}`);
    if (data.type === "job.completed" || data.type === "job.failed" || data.type === "job.cancelled") {
      $("#job-status").textContent = data.status;
      refreshJobResult(jobId).catch(() => {});
    }
  });
  eventSource.onerror = () => appendEventLine("stream disconnected");
}

async function submitTask(event) {
  event.preventDefault();
  const goal = $("#task-goal").value.trim();
  if (!goal) return;
  const routeId = $("#task-route").value;
  appState.activeRouteId = routeId;
  $("#route-pill").textContent = routeId;
  $("#job-status").textContent = "running";
  renderJobSummary(goal, "", "running");
  $("#event-log").textContent = "";
  const body = {
    goal,
    mode: $("#task-mode").value,
    model_route: routeId,
    policy: {
      async: $("#task-async").checked,
      approval_mode: $("#approval-mode").value === "always" ? "always" : undefined,
    },
  };
  const result = await window.desktop.apiRequest("/v1/jobs", { method: "POST", body });
  if (!result.ok) {
    $("#job-status").textContent = `failed ${result.status}`;
    $("#job-summary").textContent = JSON.stringify(result.body, null, 2);
    return;
  }
  const jobId = result.body.job_id || result.body.job?.id;
  renderJobLinks(jobId);
  appendEventLine(`accepted ${jobId}`);
  if (jobId) connectJobStream(jobId);
}

async function loadHealth() {
  const result = await window.desktop.apiRequest("/health");
  const roles = result.body?.runtime?.team_agents?.roles || [];
  $("#agent-registry").innerHTML = Array.isArray(roles) && roles.length > 0
    ? roles.map((entry) => {
        const role = entry.role || "unknown";
        const status = entry.status || "unknown";
        const route = entry.agent_id || entry.fallback_to || entry.model || "not configured";
        return `<div class="agent-row"><span>${escapeHtml(role)}</span><strong>${escapeHtml(status)}</strong><small>${escapeHtml(route)}</small></div>`;
      }).join("")
    : `<div class="agent-row muted"><span>team agents</span><strong>unknown</strong><small>not reported</small></div>`;
  $("#health-json").textContent = JSON.stringify(result.body, null, 2);
}

async function loadView(view) {
  if (!appState || !serverStatus) return;
  if (view === "jobs") $("#jobs-frame").src = `${apiBase()}/jobs/dashboard`;
  if (view === "goals") $("#goals-frame").src = `${apiBase()}/goals/dashboard`;
  if (view === "skills") $("#skills-frame").src = `${apiBase()}/skill-evolution/ops`;
  if (view === "health") await loadHealth();
}

function openCurrentExternal() {
  const base = apiBase();
  const urls = {
    run: currentJob ? `${base}/jobs/${currentJob}/timeline` : `${base}/jobs/dashboard`,
    models: `${base}/v1/models`,
    jobs: `${base}/jobs/dashboard`,
    goals: `${base}/goals/dashboard`,
    skills: `${base}/skill-evolution/ops`,
    health: `${base}/health`,
  };
  window.desktop.openExternal(urls[currentView]);
}

function bindEvents() {
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  $("#task-form").addEventListener("submit", submitTask);
  $("#task-route").addEventListener("change", () => {
    appState.activeRouteId = $("#task-route").value;
    $("#route-pill").textContent = appState.activeRouteId;
  });
  $("#add-model").addEventListener("click", () => {
    appState.models.push({
      id: `model-${appState.models.length + 1}`,
      label: "New model",
      role: "worker",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "",
      modelId: "model-id",
      timeoutMs: 60000,
      maxTokens: 4096,
      temperature: 0,
      maxConcurrency: 1,
    });
    renderModels();
  });
  $("#add-route").addEventListener("click", () => {
    const planner = appState.models.find((model) => model.role === "planner") || appState.models[0];
    const executor = appState.models.find((model) => model.role === "worker" || model.role === "executor") || planner;
    appState.routes.push({
      id: `route-${appState.routes.length + 1}`,
      label: "New route",
      plannerModelId: planner?.id || "",
      executorModelId: executor?.id || "",
      description: "",
    });
    renderModels();
  });
  $("#models-list").addEventListener("click", (event) => {
    const index = event.target.dataset?.removeModel;
    if (index === undefined) return;
    appState.models.splice(Number(index), 1);
    renderModels();
  });
  $("#routes-list").addEventListener("click", (event) => {
    const index = event.target.dataset?.removeRoute;
    if (index === undefined) return;
    appState.routes.splice(Number(index), 1);
    renderModels();
  });
  $("#save-models").addEventListener("click", async () => {
    appState = collectModelsState();
    const result = await window.desktop.saveState(appState);
    appState = result.state;
    serverStatus = result.status;
    renderServer();
    renderRunForm();
    renderModels();
    await loadHealth().catch(() => {});
  });
  $("#start-server").addEventListener("click", async () => {
    serverStatus = (await window.desktop.startServer()).status;
    renderServer();
  });
  $("#restart-server").addEventListener("click", async () => {
    serverStatus = (await window.desktop.restartServer()).status;
    renderServer();
  });
  $("#stop-server").addEventListener("click", async () => {
    serverStatus = (await window.desktop.stopServer()).status;
    renderServer();
  });
  $("#reload-health").addEventListener("click", loadHealth);
  $("#refresh-view").addEventListener("click", () => loadView(currentView));
  $("#open-browser").addEventListener("click", openCurrentExternal);
  $("#open-job").addEventListener("click", () => currentJob && window.desktop.openExternal(`${apiBase()}/jobs/${currentJob}`));
  $("#open-timeline").addEventListener("click", () => currentJob && window.desktop.openExternal(`${apiBase()}/jobs/${currentJob}/timeline`));
  $("#open-events").addEventListener("click", () => currentJob && window.desktop.openExternal(`${apiBase()}/jobs/${currentJob}/events`));
  window.desktop.onServerLog((line) => {
    if (!line) return;
    logLines.push(line);
    logLines = logLines.slice(-200);
    $("#server-log").textContent = logLines.join("\n");
  });
  window.desktop.onServerStatus((status) => {
    serverStatus = status;
    renderServer();
  });
}

async function init() {
  const initial = await window.desktop.getState();
  appState = initial.state;
  serverStatus = initial.server;
  logLines = serverStatus.log || [];
  $("#server-log").textContent = logLines.join("\n");
  bindEvents();
  renderServer();
  renderRunForm();
  renderModels();
  setView("run");
}

init().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message || String(error))}</pre>`;
});
