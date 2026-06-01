const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const WORKSPACE_CONFIG = path.join(PROJECT_ROOT, "config", "config.yml");

let mainWindow = null;
let serverProcess = null;
let serverLog = [];

function dataDir() {
  const dir = path.join(app.getPath("userData"), "desktop");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath() {
  return path.join(dataDir(), "state.json");
}

function activeConfigPath() {
  return WORKSPACE_CONFIG;
}

function defaultState() {
  return {
    apiKey: "dual-agent-local",
    port: 9898,
    activeRouteId: "desktop-default",
    models: [
      {
        id: "planner-local",
        label: "Planner",
        role: "planner",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "env:PLANNER_API_KEY",
        modelId: "GLM-5",
        timeoutMs: 120000,
        maxTokens: 8192,
        temperature: 0.2,
      },
      {
        id: "executor-local",
        label: "Executor",
        role: "worker",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "env:EXECUTOR_API_KEY",
        modelId: "qwen/qwen3-4b-2507",
        timeoutMs: 60000,
        maxTokens: 4096,
        temperature: 0,
      },
      {
        id: "verifier-local",
        label: "Verifier",
        role: "verifier",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "env:EXECUTOR_API_KEY",
        modelId: "qwen/qwen3-4b-2507",
        timeoutMs: 60000,
        maxTokens: 2048,
        temperature: 0,
      },
    ],
    routes: [
      {
        id: "desktop-default",
        label: "Desktop default",
        plannerModelId: "planner-local",
        executorModelId: "executor-local",
        description: "Planner plus executor route from the Electron profile.",
      },
    ],
  };
}

function readState() {
  const stored = readStoredState();
  const fromConfig = readStateFromWorkspaceConfig();
  const base = fromConfig || stored || defaultState();
  return normalizeState({
    ...base,
    apiKey: stored?.apiKey || base.apiKey,
    port: stored?.port || base.port,
    activeRouteId: stored?.activeRouteId || base.activeRouteId,
  });
}

function writeState(state) {
  const normalized = normalizeState(state);
  writeFileSync(statePath(), JSON.stringify(normalized, null, 2), "utf8");
  writeGeneratedConfig(normalized);
  return normalized;
}

function readStoredState() {
  try {
    return normalizeState(JSON.parse(readFileSync(statePath(), "utf8")));
  } catch {
    return null;
  }
}

function readStateFromWorkspaceConfig() {
  if (!existsSync(WORKSPACE_CONFIG)) return null;
  try {
    const raw = readFileSync(WORKSPACE_CONFIG, "utf8");
    const sections = extractTopLevelSections(raw);
    const plannerSection = parseScalarBlock(sections.get("planner") || "");
    const executorSection = parseScalarBlock(sections.get("executor") || "");
    const models = [
      modelFromSection("planner.default", "Planner", "planner", plannerSection),
      modelFromSection("executor.default", "Executor", "worker", executorSection),
    ];

    const registry = parseNamedBlocks(sections.get("models") || "");
    for (const [id, block] of registry) {
      const values = parseScalarBlock(block);
      models.push(modelFromSection(id, id, values.role === "planner" ? "planner" : "executor", values));
    }

    const agents = parseNamedBlocks(sections.get("agents") || "");
    for (const [id, block] of agents) {
      const values = parseNestedModelBlock(block);
      models.push(modelFromSection(id, id, values.role || "worker", values));
    }

    const routes = [
      {
        id: "dual-agent-orchestrator",
        label: "config/config.yml default",
        plannerModelId: "planner.default",
        executorModelId: "executor.default",
        description: "Default route loaded from config/config.yml.",
      },
      ...models
        .filter((model) => model.role === "executor" || model.role === "worker")
        .filter((model) => model.id !== "executor.default")
        .map((model) => ({
          id: `route-${model.id}`,
          label: model.label,
          plannerModelId: "planner.default",
          executorModelId: model.id,
          description: `Planner default plus ${model.id}.`,
        })),
    ];

    return {
      ...defaultState(),
      activeRouteId: "dual-agent-orchestrator",
      models,
      routes,
    };
  } catch {
    return null;
  }
}

function extractTopLevelSections(raw) {
  const sections = new Map();
  const lines = raw.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (match) {
      current = match[1];
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([key, value]) => [key, value.join("\n")]));
}

function parseScalarBlock(block) {
  const result = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s{2,}([A-Za-z0-9_]+):\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1]] = unquoteYaml(match[2]);
  }
  return result;
}

function parseNamedBlocks(block) {
  const result = new Map();
  let current = null;
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*$/);
    if (match) {
      current = match[1];
      result.set(current, []);
      continue;
    }
    if (current) result.get(current).push(line);
  }
  return new Map([...result].map(([key, value]) => [key, value.join("\n")]));
}

function parseNestedModelBlock(block) {
  const roleMatch = block.match(/^\s{4}role:\s*(.+?)\s*$/m);
  const modelMatch = block.match(/^\s{4}model:\s*$/m);
  const modelBlock = modelMatch
    ? block.slice(modelMatch.index + modelMatch[0].length).split(/\r?\n/).filter((line) => line.startsWith("      ")).join("\n")
    : "";
  return {
    ...parseScalarBlock(modelBlock.replace(/^ {4}/gm, "")),
    role: roleMatch ? unquoteYaml(roleMatch[1]) : undefined,
  };
}

function unquoteYaml(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return trimmed;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) && trimmed !== "" ? numberValue : trimmed;
}

function modelFromSection(id, label, role, values) {
  return {
    id,
    label,
    role,
    baseUrl: stringValue(values.base_url) || "http://127.0.0.1:1234/v1",
    apiKey: stringValue(values.api_key),
    modelId: stringValue(values.model) || id,
    timeoutMs: integerValue(values.timeout_ms, role === "planner" ? 120000 : 60000),
    maxTokens: integerValue(values.max_tokens, role === "planner" ? 8192 : 4096),
    temperature: numberValue(values.temperature, role === "planner" ? 0.2 : 0),
    maxConcurrency: 1,
  };
}

function normalizeState(value) {
  const fallback = defaultState();
  const source = value && typeof value === "object" ? value : {};
  const models = Array.isArray(source.models) && source.models.length > 0
    ? source.models.map((item, index) => normalizeModel(item, index)).filter(Boolean)
    : fallback.models;
  const routes = Array.isArray(source.routes) && source.routes.length > 0
    ? source.routes.map((item, index) => normalizeRoute(item, index, models)).filter(Boolean)
    : fallback.routes;
  return {
    apiKey: typeof source.apiKey === "string" && source.apiKey.trim() ? source.apiKey.trim() : fallback.apiKey,
    port: Number.isInteger(source.port) && source.port > 0 ? source.port : fallback.port,
    activeRouteId: typeof source.activeRouteId === "string" && source.activeRouteId.trim()
      ? source.activeRouteId.trim()
      : routes[0]?.id ?? fallback.activeRouteId,
    models,
    routes,
  };
}

function normalizeModel(item, index) {
  if (!item || typeof item !== "object") return null;
  const id = stringValue(item.id) || `model-${index + 1}`;
  const role = ["planner", "executor", "worker", "verifier", "synthesizer", "planner_proxy"].includes(item.role)
    ? item.role
    : "worker";
  return {
    id,
    label: stringValue(item.label) || id,
    role,
    baseUrl: stringValue(item.baseUrl) || "http://127.0.0.1:1234/v1",
    apiKey: stringValue(item.apiKey) || "",
    modelId: stringValue(item.modelId) || id,
    timeoutMs: integerValue(item.timeoutMs, role === "planner" ? 120000 : 60000),
    maxTokens: integerValue(item.maxTokens, role === "planner" ? 8192 : 4096),
    temperature: numberValue(item.temperature, role === "planner" ? 0.2 : 0),
    toolsAllow: stringValue(item.toolsAllow),
    toolsDeny: stringValue(item.toolsDeny),
    maxConcurrency: integerValue(item.maxConcurrency, role === "worker" ? 2 : 1),
  };
}

function normalizeRoute(item, index, models) {
  if (!item || typeof item !== "object") return null;
  const planner = models.find((model) => model.id === item.plannerModelId) || models.find((model) => model.role === "planner") || models[0];
  const executor = models.find((model) => model.id === item.executorModelId) || models.find((model) => model.role === "worker" || model.role === "executor") || planner;
  const id = stringValue(item.id) || `route-${index + 1}`;
  return {
    id,
    label: stringValue(item.label) || id,
    plannerModelId: planner?.id || "",
    executorModelId: executor?.id || "",
    description: stringValue(item.description),
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function numberValue(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function q(value) {
  return JSON.stringify(String(value ?? ""));
}

function csv(value) {
  return stringValue(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function writeGeneratedConfig(state) {
  const planner = state.models.find((model) => model.role === "planner") || state.models[0];
  const executor = state.models.find((model) => model.role === "executor" || model.role === "worker") || planner;
  const agents = state.models.filter((model) => ["worker", "verifier", "synthesizer", "planner_proxy"].includes(model.role));
  const plannerCandidates = state.models.filter((model) => model.role === "planner");
  const executorCandidates = state.models.filter((model) => model.role === "executor" || model.role === "worker");
  const lines = [
    "planner:",
    `  base_url: ${q(planner.baseUrl)}`,
    `  api_key: ${q(planner.apiKey)}`,
    `  model: ${q(planner.modelId)}`,
    `  timeout_ms: ${planner.timeoutMs}`,
    `  max_tokens: ${planner.maxTokens}`,
    `  temperature: ${planner.temperature}`,
    "",
    "executor:",
    `  base_url: ${q(executor.baseUrl)}`,
    `  api_key: ${q(executor.apiKey)}`,
    `  model: ${q(executor.modelId)}`,
    `  timeout_ms: ${executor.timeoutMs}`,
    `  max_tokens: ${executor.maxTokens}`,
    `  temperature: ${executor.temperature}`,
    "",
  ];

  const registryModels = [...plannerCandidates, ...executorCandidates]
    .filter((model) => model.id !== planner.id && model.id !== executor.id);
  if (registryModels.length > 0) {
    lines.push("models:");
    for (const model of registryModels) {
      lines.push(`  ${model.id}:`);
      lines.push(`    role: ${q(model.role === "planner" ? "planner" : "executor")}`);
      lines.push(`    base_url: ${q(model.baseUrl)}`);
      lines.push(`    api_key: ${q(model.apiKey)}`);
      lines.push(`    model: ${q(model.modelId)}`);
      lines.push(`    timeout_ms: ${model.timeoutMs}`);
      lines.push(`    max_tokens: ${model.maxTokens}`);
      lines.push(`    temperature: ${model.temperature}`);
      lines.push("    enabled: true");
    }
    lines.push("");
  }

  if (plannerCandidates.length > 1 || executorCandidates.length > 1) {
    lines.push("model_routing:");
    lines.push(`  planner_candidates: [${[q("planner.default"), ...plannerCandidates.filter((model) => model.id !== planner.id).map((model) => q(model.id))].join(", ")}]`);
    lines.push(`  executor_candidates: [${[q("executor.default"), ...executorCandidates.filter((model) => model.id !== executor.id).map((model) => q(model.id))].join(", ")}]`);
    lines.push("");
  }

  if (agents.length > 0) {
    const defaultAgent = agents.find((model) => model.role === "worker" || model.role === "executor") || agents[0];
    lines.push(`default_executor_agent: ${q(defaultAgent.id)}`);
    lines.push("agents:");
    for (const model of agents) {
      lines.push(`  ${model.id}:`);
      lines.push(`    role: ${q(model.role)}`);
      lines.push("    model:");
      lines.push(`      base_url: ${q(model.baseUrl)}`);
      lines.push(`      api_key: ${q(model.apiKey)}`);
      lines.push(`      model: ${q(model.modelId)}`);
      lines.push(`      timeout_ms: ${model.timeoutMs}`);
      lines.push(`      max_tokens: ${model.maxTokens}`);
      lines.push(`      temperature: ${model.temperature}`);
      const allow = csv(model.toolsAllow);
      const deny = csv(model.toolsDeny);
      if (allow.length > 0 || deny.length > 0) {
        lines.push("    tools:");
        if (allow.length > 0) lines.push(`      allow: [${allow.map(q).join(", ")}]`);
        if (deny.length > 0) lines.push(`      deny: [${deny.map(q).join(", ")}]`);
      }
      lines.push("    limits:");
      lines.push(`      max_concurrency: ${model.maxConcurrency}`);
    }
    lines.push("");
  }

  const preserved = existsSync(WORKSPACE_CONFIG) ? extractTopLevelSections(readFileSync(WORKSPACE_CONFIG, "utf8")) : new Map();
  appendPreservedSection(lines, preserved, "policy", [
    "  max_steps: 8",
    "  max_replans: 3",
    "  max_tool_retries: 2",
    "  planner_history_max_entries: 6",
    "  planner_history_preview_chars: 180",
    "  max_repeated_executor_requests: 2",
    "  auto_resume_concurrency: 3",
    `  task_routing_path: ${q(path.join(PROJECT_ROOT, "config", "task-routing.yml"))}`,
  ]);
  for (const sectionName of ["search", "skills", "skill_evolution", "goal_mode"]) {
    appendPreservedSection(lines, preserved, sectionName);
  }
  writeFileSync(activeConfigPath(), `${lines.join("\n")}\n`, "utf8");
}

function appendPreservedSection(lines, sections, sectionName, fallbackLines) {
  const body = sections.get(sectionName);
  if (!body && !fallbackLines) return;
  lines.push(`${sectionName}:`);
  lines.push(...(body ? body.replace(/\s+$/g, "").split(/\r?\n/) : fallbackLines));
  lines.push("");
}

function exposedRoutes(state) {
  return state.routes.map((route) => {
    const planner = state.models.find((model) => model.id === route.plannerModelId);
    const executor = state.models.find((model) => model.id === route.executorModelId);
    return {
      id: route.id,
      owned_by: "electron-desktop",
      planner_model: planner?.modelId,
      planner_base_url: planner?.baseUrl,
      planner_api_key: planner?.apiKey,
      executor_model: executor?.modelId,
      executor_base_url: executor?.baseUrl,
      executor_api_key: executor?.apiKey,
      description: route.description || route.label,
    };
  });
}

function appendLog(line) {
  serverLog.push(line);
  if (serverLog.length > 300) serverLog = serverLog.slice(-300);
  mainWindow?.webContents.send("server-log", line);
}

function startServer() {
  const state = readState();
  if (serverProcess) return { ok: true, running: true, pid: serverProcess.pid };
  if (!existsSync(DIST_ENTRY)) {
    return { ok: false, running: false, error: "dist/index.js is missing. Run npm run build before launching the Electron shell." };
  }
  serverLog = [];
  serverProcess = spawn(process.execPath, [DIST_ENTRY, "serve", String(state.port)], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DUAL_AGENT_CONFIG: activeConfigPath(),
      DUAL_AGENT_MODELS: JSON.stringify(exposedRoutes(state)),
      DUAL_AGENT_API_KEY: state.apiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appendLog(`server starting on http://127.0.0.1:${state.port}`);
  serverProcess.stdout.on("data", (chunk) => appendLog(String(chunk).trim()));
  serverProcess.stderr.on("data", (chunk) => appendLog(String(chunk).trim()));
  serverProcess.on("exit", (code, signal) => {
    appendLog(`server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    serverProcess = null;
    mainWindow?.webContents.send("server-status", getServerStatus());
  });
  return { ok: true, running: true, pid: serverProcess.pid };
}

function stopServer() {
  if (!serverProcess) return { ok: true, running: false };
  serverProcess.kill();
  serverProcess = null;
  return { ok: true, running: false };
}

function restartServer() {
  stopServer();
  return startServer();
}

function getServerStatus() {
  const state = readState();
  return {
    running: Boolean(serverProcess),
    pid: serverProcess?.pid ?? null,
    apiBase: `http://127.0.0.1:${state.port}`,
    configPath: activeConfigPath(),
    log: serverLog,
  };
}

async function apiRequest(pathname, options = {}) {
  const state = readState();
  const apiBase = `http://127.0.0.1:${state.port}`;
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.apiKey}`,
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  return { ok: response.ok, status: response.status, body };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "Dual Agent Orchestrator",
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

app.whenReady().then(() => {
  readState();
  createWindow();
  startServer();
});

app.on("before-quit", () => {
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("state:get", () => ({ state: readState(), server: getServerStatus() }));
ipcMain.handle("state:save", (_event, nextState) => {
  const state = writeState(nextState);
  const server = restartServer();
  return { state, server, status: getServerStatus() };
});
ipcMain.handle("server:start", () => ({ result: startServer(), status: getServerStatus() }));
ipcMain.handle("server:stop", () => ({ result: stopServer(), status: getServerStatus() }));
ipcMain.handle("server:restart", () => ({ result: restartServer(), status: getServerStatus() }));
ipcMain.handle("api:request", (_event, pathname, options) => apiRequest(pathname, options));
ipcMain.handle("open:external", (_event, url) => shell.openExternal(url));
