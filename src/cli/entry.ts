import { createServer } from "node:http";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { createRunLogger } from "../logger.js";
import { buildHealthyExecutorRuntimeConfig, type ModelHealthResult } from "../model-health.js";
import { detectIntentRoute } from "../intent-router.js";
import { dispatchTaskIntentRoute, shouldDispatchToTeam } from "../intent-dispatch.js";
import { configureSearchTools } from "../tools.js";
import { ensureRuntimeDirectories } from "../paths.js";
import { runTeam } from "../team.js";
import { buildDashboardData, exportDashboardJson, exportDashboardHtml } from "../dashboard.js";
import { Tracer } from "../trace.js";
import { loadTaskRoutingConfig } from "../task-routing.js";
import { buildDoctorReport } from "./doctor.js";
import type { OrchestratorConfig } from "../types.js";

// Circular imports from index.ts — all used only at runtime inside exported functions.
// eslint-disable-next-line import/no-cycle
import { getExposedModels } from "../model-api.js";
import { getServerApiKey } from "../server/auth.js";
import { handleRequest } from "../server/router.js";
import { assertHealthyExecutorSelection, recoverInterruptedJobs } from "../task-execution.js";
import { resolveTeamAgents } from "../team-agents.js";

export function getPort(args: string[]): number {
  const explicitPort = args[1] ? Number(args[1]) : Number(process.env.PORT ?? "9898");
  return Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : 9898;
}

export function parseDaoRunCliArgs(args: string[]): { goal: string; port: number } {
  const portFlagIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const port = portFlagIndex >= 0 && args[portFlagIndex + 1]
    ? Number(args[portFlagIndex + 1])
    : Number(process.env.PORT ?? "9898");
  const goalArgs = portFlagIndex >= 0
    ? args.filter((arg, index) => index !== portFlagIndex && index !== portFlagIndex + 1)
    : args;
  return {
    goal: goalArgs.join(" ").trim(),
    port: Number.isFinite(port) && port > 0 ? port : 9898,
  };
}

export function parseTeamCliArgs(args: string[]): { goal: string; planOnly: boolean } {
  const planOnly = args[0] === "plan" || args.includes("--plan-only");
  const goalArgs = args
    .filter((arg, index) => !(index === 0 && arg === "plan") && arg !== "--plan-only" && arg !== "--");
  return {
    goal: goalArgs.join(" ").trim(),
    planOnly,
  };
}

export function runConfigValidation(configPath?: string): void {
  const resolvedPath = configPath?.trim() || "config/config.yml";
  const config = loadConfig(resolvedPath);
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);

  console.log(JSON.stringify({
    ok: true,
    config_path: resolvedPath,
    planner_model: config.planner.model,
    executor_model: config.executor.model,
    executor_candidates: config.modelRouting.executorCandidates,
    task_routing_path: config.taskRoutingPath,
    auto_resume_concurrency: config.policy.autoResumeConcurrency,
    route_types: routing.map((route) => route.type),
  }, null, 2));
}

export function runDoctor(configPath?: string): void {
  console.log(JSON.stringify(buildDoctorReport(configPath), null, 2));
}

export async function runDaoRunCli(goal: string, port = 9898): Promise<void> {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new Error("Usage: node dist/index.js dao-run \"your task here\"");
  }
  const jobsUrl = `http://127.0.0.1:${port}/v1/jobs`;
  let response: Response;
  try {
    response = await fetch(jobsUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getServerApiKey()}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        goal: trimmedGoal,
        mode: "task",
        policy: {
          async: true,
        },
      }),
    });
  } catch (error) {
    // Service unreachable (e.g. ECONNREFUSED surfaces as "fetch failed"). Emit actionable
    // guidance on stdout so the caller never mistakes a down service for a completed job,
    // then fail loudly so the exit code is non-zero.
    const detail = error instanceof Error ? error.message : String(error);
    console.log([
      "## DAO Run Blocked",
      "",
      "- **Route**: service_job (NOT started)",
      `- **Reason**: DAO service is not reachable at ${jobsUrl} (${detail}).`,
      "- **Action**: Start the service with `npm run serve:restart:9898`, then re-run this command.",
      "- **Do not** answer the task locally, fabricate a job id, or edit repository files.",
    ].join("\n"));
    throw new Error(`DAO service not reachable at http://127.0.0.1:${port}. Start it with: npm run serve:restart:9898`);
  }
  const payload = await response.json() as {
    job_id?: string;
    status?: string;
    timeline_url?: string;
    error?: { message?: string };
  };
  if (!response.ok || !payload.job_id) {
    throw new Error(payload.error?.message ?? `DAO service returned HTTP ${response.status}`);
  }
  console.log([
    "## DAO Run Summary",
    "",
    "- **Route**: service_job",
    `- **Job**: ${payload.job_id}`,
    `- **Timeline**: http://127.0.0.1:${port}${payload.timeline_url ?? `/v1/jobs/${payload.job_id}/timeline`}`,
    `- **Status**: ${payload.status ?? "running"}`,
    "- **CTA**: Open the timeline URL.",
  ].join("\n"));
}

export async function runCliTask(task: string): Promise<void> {
  const baseConfig = loadConfig();
  const healthSelection = await buildHealthyExecutorRuntimeConfig(baseConfig);
  assertHealthyExecutorSelection(healthSelection);
  configureSearchTools(healthSelection.config.search);
  const intentRoute = await detectIntentRoute({
    config: healthSelection.config,
    userGoal: task,
    allowPlannerFallback: true,
  });

  if (shouldDispatchToTeam(intentRoute)) {
    await runCliTeam(task);
    return;
  }

  const logger = createRunLogger(task);
  const result = await dispatchTaskIntentRoute(healthSelection.config, task, intentRoute, logger);
  console.error(`Run log: ${logger.logPath}`);
  console.log(JSON.stringify({
    status: result.status,
    output: result.output,
    verified: result.verified,
    executorHistory: result.executorHistory,
    job: result.job,
    plan: result.plan,
    taskRuns: result.taskRuns,
    artifacts: result.artifacts,
    model_health: healthSelection.results,
  }, null, 2));
}

export async function runCliTeam(goal: string, options: { planOnly?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const healthSelection = await buildHealthyExecutorRuntimeConfig(config);
  assertHealthyExecutorSelection(healthSelection);
  configureSearchTools(healthSelection.config.search);
  const logger = createRunLogger(goal);
  const tracer = new Tracer(logger);
  const startedAt = new Date().toISOString();

  const teamAgents = resolveTeamAgents(healthSelection.config);

  const result = await runTeam(healthSelection.config, goal, teamAgents, logger, tracer, { planOnly: options.planOnly });

  // Export dashboard
  const dashData = buildDashboardData(
    logger.runId,
    goal,
    result.tasks,
    tracer.getEvents(),
    startedAt,
    result.job.intentRoute ?? {
      kind: "goal",
      reason: "team CLI mode selected",
      source: "heuristic",
    },
  );
  const jsonPath = exportDashboardJson(dashData);
  const htmlPath = exportDashboardHtml(dashData);
  console.error(`Run log: ${logger.logPath}`);
  console.error(`Dashboard JSON: ${jsonPath}`);
  console.error(`Dashboard HTML: ${htmlPath}`);

  console.log(JSON.stringify({
    goal: result.goal,
    finalAnswer: result.finalAnswer,
    taskResults: Object.fromEntries(result.taskResults),
    memorySummary: result.memorySummary,
    job: result.job,
    plan: result.plan,
    taskRuns: result.taskRuns,
    artifacts: result.artifacts,
    model_health: healthSelection.results,
    traceSummary: tracer.getSummary(),
  }, null, 2));
}

export function runServer(port: number): void {
  ensureRuntimeDirectories();
  const config = loadConfig();
  configureSearchTools(config.search);
  const recoveryPromise = recoverInterruptedJobs(config.policy.autoResumeConcurrency);
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dual Agent Orchestrator API listening on http://127.0.0.1:${port}`);
    console.log(`API key: ${getServerApiKey()}`);
    console.log(`Models: ${getExposedModels(config).map((model) => model.id).join(", ")}`);
    void recoveryPromise
      .then((recoveredJobIds: string[]) => {
        if (recoveredJobIds.length > 0) {
          console.log(`Recovered interrupted jobs after restart: ${recoveredJobIds.join(", ")}`);
        }
      })
      .catch((error: unknown) => {
        console.error(`Failed to recover interrupted jobs after restart: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "config" && args[1] === "validate") {
    runConfigValidation(args[2]);
    return;
  }

  if (args[0] === "doctor") {
    runDoctor(args[1]);
    return;
  }

  if (args[0] === "serve") {
    runServer(getPort(args));
    return;
  }

  if (args[0] === "dao-run") {
    const parsed = parseDaoRunCliArgs(args.slice(1));
    await runDaoRunCli(parsed.goal, parsed.port);
    return;
  }

  if (args[0] === "team") {
    const { goal, planOnly } = parseTeamCliArgs(args.slice(1));
    if (!goal) {
      throw new Error("Usage: node dist/index.js team [plan|--plan-only] \"your multi-agent goal here\"");
    }
    await runCliTeam(goal, { planOnly });
    return;
  }

  const userGoal = args.join(" ").trim();
  if (!userGoal) {
    throw new Error("Usage: node dist/index.js \"your task here\" OR node dist/index.js serve [port] OR node dist/index.js team [plan|--plan-only] \"goal\" OR node dist/index.js config validate [path] OR node dist/index.js doctor [path]");
  }

  await runCliTask(userGoal);
}
