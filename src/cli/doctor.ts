import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import type { OrchestratorConfig, RoutePolicy } from "../types.js";
import { loadTaskRoutingConfig } from "../task-routing.js";
import { buildRuntimeProfile } from "../runtime/profile.js";
import { listFailureCategories } from "../failure-classification.js";
import { ensureRuntimeDirectories, ARTIFACTS_ROOT, RUNTIME_ROOT, WORKSPACE_ROOT } from "../paths.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  summary: string;
  detail?: unknown;
};

export type DoctorRecommendation = {
  category:
    | "configuration"
    | "routing"
    | "network"
    | "filesystem"
    | "search"
    | "runtime";
  severity: "info" | "warning";
  message: string;
  suggested_action: string;
  related_checks: string[];
};

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return `${value.slice(0, 1)}***`;
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function buildModelConfigCheck(
  name: "planner_model_config" | "executor_model_config",
  label: "planner" | "executor",
  config: OrchestratorConfig["planner"] | OrchestratorConfig["executor"],
): DoctorCheck {
  const urlLooksLocal = /^(https?:\/\/)(127\.0\.0\.1|localhost)/i.test(config.baseUrl);
  return {
    name,
    ok: Boolean(config.baseUrl && config.apiKey && config.model),
    summary: `${label} model config is ready${urlLooksLocal ? " (local endpoint)." : "."}`,
    detail: {
      base_url: config.baseUrl,
      api_key_present: Boolean(config.apiKey),
      api_key_preview: config.apiKey ? maskSecret(config.apiKey) : "",
      model: config.model,
      timeout_ms: config.timeoutMs,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      endpoint_scope: urlLooksLocal ? "local" : "remote",
    },
  };
}

export function buildTaskRoutingCheck(taskRoutingPath: string | undefined, routing: RoutePolicy[]): DoctorCheck {
  const routesWithPreferredTools = routing.filter((route) => route.preferredTools.length > 0).length;
  const routesRequiringEvidence = routing.filter((route) => route.requireEvidenceBeforeFinal).length;
  return {
    name: "task_routing_summary",
    ok: routing.length > 0,
    summary: `Task routing loaded ${routing.length} route types.`,
    detail: {
      task_routing_path: taskRoutingPath ?? "config/task-routing.yml",
      route_count: routing.length,
      route_types: routing.map((route) => route.type),
      routes_with_preferred_tools: routesWithPreferredTools,
      routes_requiring_evidence: routesRequiringEvidence,
    },
  };
}

export function buildSearchProviderCheck(config: OrchestratorConfig): DoctorCheck {
  if (!config.search) {
    return {
      name: "search_provider_readiness",
      ok: false,
      summary: "Search provider is not configured.",
      detail: {
        provider: null,
        fallback_enabled: false,
      },
    };
  }

  const providerConfig = config.search.providers[config.search.provider];
  const providerKindsRequiringApiKey = new Set(["serpapi", "bing_api", "google_cse"]);
  const providerKindsRequiringSection = new Set(["bing_html", "searxng", "serpapi", "bing_api", "google_cse", "mcp"]);
  const sectionPresent = config.search.provider === "url_template" || providerKindsRequiringSection.has(config.search.provider)
    ? Boolean(providerConfig)
    : true;
  const apiKeyRequired = providerKindsRequiringApiKey.has(config.search.provider);
  const apiKeyPresent = !apiKeyRequired || Boolean(config.search.apiKey);
  const ok = sectionPresent && apiKeyPresent;

  return {
    name: "search_provider_readiness",
    ok,
    summary: ok
      ? `Search provider "${config.search.provider}" is ready.`
      : `Search provider "${config.search.provider}" is only partially configured.`,
    detail: {
      provider: config.search.provider,
      provider_section_present: sectionPresent,
      api_key_required: apiKeyRequired,
      api_key_present: Boolean(config.search.apiKey),
      api_key_preview: config.search.apiKey ? maskSecret(config.search.apiKey) : "",
      fallback_enabled: config.search.fallbackEnabled,
      timeout_ms: config.search.timeoutMs,
      provider_config_keys: providerConfig ? Object.keys(providerConfig) : [],
    },
  };
}

export function buildDoctorRecommendations(checks: DoctorCheck[]): DoctorRecommendation[] {
  const recommendations: DoctorRecommendation[] = [];
  const find = (name: string) => checks.find((check) => check.name === name);

  const configLoad = find("config_load");
  if (configLoad && !configLoad.ok) {
    recommendations.push({
      category: "configuration",
      severity: "warning",
      message: "Configuration failed to load.",
      suggested_action: "Fix the reported config schema errors, then rerun `npm run doctor` or `npm run config:validate`.",
      related_checks: ["config_load"],
    });
    return recommendations;
  }

  if ((find("planner_model_config") && !find("planner_model_config")!.ok) || (find("executor_model_config") && !find("executor_model_config")!.ok)) {
    recommendations.push({
      category: "configuration",
      severity: "warning",
      message: "Planner or executor model configuration is incomplete.",
      suggested_action: "Verify base URLs, model names, and API key env vars for both planner and executor.",
      related_checks: ["planner_model_config", "executor_model_config"],
    });
  }

  if (find("task_routing_load") && !find("task_routing_load")!.ok) {
    recommendations.push({
      category: "routing",
      severity: "warning",
      message: "Task routing config could not be loaded.",
      suggested_action: "Fix the task-routing YAML or fall back to the default `config/task-routing.yml` layout.",
      related_checks: ["task_routing_load", "task_routing_summary"],
    });
  }

  if (find("proxy_health") && !find("proxy_health")!.ok) {
    recommendations.push({
      category: "network",
      severity: "warning",
      message: "Proxy configuration looks degraded.",
      suggested_action: "Check `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, especially local placeholders or dead ports.",
      related_checks: ["proxy_health", "runtime_profile"],
    });
  }

  if ((find("workspace_writable") && !find("workspace_writable")!.ok) || (find("runtime_writable") && !find("runtime_writable")!.ok)) {
    recommendations.push({
      category: "filesystem",
      severity: "warning",
      message: "One or more writable roots are not writable.",
      suggested_action: "Check directory permissions and confirm the workspace/runtime roots are writable by this process.",
      related_checks: ["workspace_writable", "runtime_writable"],
    });
  }

  if (find("search_provider_readiness") && !find("search_provider_readiness")!.ok) {
    recommendations.push({
      category: "search",
      severity: "warning",
      message: "Search provider is only partially configured.",
      suggested_action: "Add the active provider section and required API key, or switch to a provider that is already configured.",
      related_checks: ["search_provider_readiness"],
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      category: "runtime",
      severity: "info",
      message: "No critical doctor issues were detected.",
      suggested_action: "Use `/v1/jobs/:id/runtime-profile`, `/events`, and `/timeline` when you need job-specific diagnostics.",
      related_checks: checks.filter((check) => check.ok).map((check) => check.name),
    });
  }

  return recommendations;
}

export function runWritableCheck(targetDir: string, label: string): DoctorCheck {
  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const probePath = join(targetDir, `.doctor-write-check-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(probePath, "ok", "utf8");
    unlinkSync(probePath);
    return {
      name: `${label}_writable`,
      ok: true,
      summary: `${label} is writable.`,
      detail: { path: targetDir },
    };
  } catch (error) {
    return {
      name: `${label}_writable`,
      ok: false,
      summary: `${label} is not writable.`,
      detail: {
        path: targetDir,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function buildDoctorReport(configPath?: string): Record<string, unknown> {
  ensureRuntimeDirectories();
  const resolvedPath = configPath?.trim() || "config/config.yml";
  const checks: DoctorCheck[] = [];

  try {
    const config = loadConfig(resolvedPath);
    checks.push({
      name: "config_load",
      ok: true,
      summary: "Configuration loaded successfully.",
        detail: {
          planner_model: config.planner.model,
          executor_model: config.executor.model,
          auto_resume_concurrency: config.policy.autoResumeConcurrency,
        },
      });
    checks.push(buildModelConfigCheck("planner_model_config", "planner", config.planner));
    checks.push(buildModelConfigCheck("executor_model_config", "executor", config.executor));
    checks.push({
      name: "executor_candidate_queue",
      ok: config.modelRouting.executorCandidates.length > 0,
      summary: config.modelRouting.executorCandidates.length > 0
        ? `Executor candidate queue contains ${config.modelRouting.executorCandidates.length} model(s).`
        : "Executor candidate queue is empty.",
      detail: {
        executor_candidates: config.modelRouting.executorCandidates,
        candidate_count: config.modelRouting.executorCandidates.length,
      },
    });

    const routing = loadTaskRoutingConfig(config.taskRoutingPath);
    checks.push({
      name: "task_routing_load",
      ok: true,
      summary: "Task routing config loaded successfully.",
      detail: {
        task_routing_path: config.taskRoutingPath,
        route_types: routing.map((route) => route.type),
      },
    });
    checks.push(buildTaskRoutingCheck(config.taskRoutingPath, routing));

    const runtimeProfile = buildRuntimeProfile(config);
    checks.push({
      name: "runtime_profile",
      ok: true,
      summary: "Runtime profile generated successfully.",
      detail: runtimeProfile,
    });

    checks.push({
      name: "proxy_health",
      ok: runtimeProfile.network.proxyHealth === "ok",
      summary: runtimeProfile.network.proxyHealth === "ok"
        ? "Proxy health looks normal."
        : "Proxy configuration looks degraded.",
      detail: runtimeProfile.network,
    });

    checks.push(runWritableCheck(WORKSPACE_ROOT, "workspace"));
    checks.push(runWritableCheck(RUNTIME_ROOT, "runtime"));
    checks.push(runWritableCheck(ARTIFACTS_ROOT, "artifacts"));

    checks.push(buildSearchProviderCheck(config));

    return {
      ok: checks.every((check) => check.ok),
      generated_at: new Date().toISOString(),
      config_path: resolvedPath,
      diagnostic_taxonomy: {
        failure_categories: listFailureCategories(),
      },
      summary: {
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).length,
        total: checks.length,
      },
      recommendations: buildDoctorRecommendations(checks),
      checks,
    };
  } catch (error) {
    checks.push({
      name: "config_load",
      ok: false,
      summary: "Configuration failed to load.",
      detail: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      ok: false,
      generated_at: new Date().toISOString(),
      config_path: resolvedPath,
      diagnostic_taxonomy: {
        failure_categories: listFailureCategories(),
      },
      summary: {
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).length,
        total: checks.length,
      },
      recommendations: buildDoctorRecommendations(checks),
      checks,
    };
  }
}
