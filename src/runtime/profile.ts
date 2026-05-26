import { RUNTIME_ROOT, WORKSPACE_ROOT } from "../paths.js";
import { TOOL_DEFINITIONS } from "../tools.js";
import type { OrchestratorConfig, RuntimeProfile } from "../types.js";

function detectPlatform(): RuntimeProfile["platform"] {
  const shell = process.platform === "win32"
    ? "powershell"
    : (process.env.SHELL?.includes("zsh")
      ? "zsh"
      : process.env.SHELL?.includes("bash")
        ? "bash"
        : "sh");

  return {
    os: process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : "unknown",
    shell,
    pathSeparator: process.platform === "win32" ? "\\" : "/",
    defaultEncoding: "utf-8",
  };
}

function detectNetwork(): RuntimeProfile["network"] {
  const proxyValues = [
    process.env.HTTP_PROXY,
    process.env.HTTPS_PROXY,
    process.env.ALL_PROXY,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const hasProxy = proxyValues.length > 0;
  const brokenLocalProxy = proxyValues.some((value) => value.includes("127.0.0.1:9"));

  return {
    enabled: true,
    proxyMode: hasProxy ? "env" : "direct",
    proxyHealth: brokenLocalProxy ? "degraded" : "ok",
    configuredProxyUrls: proxyValues,
  };
}

export function buildRuntimeProfile(config: OrchestratorConfig): RuntimeProfile {
  const network = detectNetwork();
  const dependencyChecks: RuntimeProfile["diagnostics"]["dependencyChecks"] = [
    {
      name: "task_routing",
      status: "ok",
      summary: "Task routing path is configured.",
      detail: {
        path: config.taskRoutingPath ?? "config/task-routing.yml",
      },
    },
    {
      name: "search_provider",
      status: config.search ? "ok" : "warning",
      summary: config.search
        ? `Search provider "${config.search.provider}" is configured.`
        : "Search provider is not configured.",
      detail: config.search
        ? {
            provider: config.search.provider,
            fallbackEnabled: config.search.fallbackEnabled,
            timeoutMs: config.search.timeoutMs,
          }
        : undefined,
    },
    {
      name: "proxy",
      status: network.proxyHealth === "ok" ? "ok" : "warning",
      summary: network.proxyHealth === "ok"
        ? "Proxy configuration looks normal."
        : "Proxy configuration looks degraded.",
      detail: {
        proxyMode: network.proxyMode,
        configuredProxyUrls: network.configuredProxyUrls ?? [],
      },
    },
  ];

  return {
    platform: detectPlatform(),
    filesystem: {
      workspaceRoot: WORKSPACE_ROOT,
      runtimeRoot: RUNTIME_ROOT,
      writableRoots: [WORKSPACE_ROOT, RUNTIME_ROOT],
    },
    network,
    diagnostics: {
      configPath: "config/config.yml",
      taskRoutingPath: config.taskRoutingPath ?? "config/task-routing.yml",
      searchProvider: config.search?.provider ?? null,
      dependencyChecks,
    },
    executor: {
      supportsNativeToolCalling: true,
      supportsStructuredJson: true,
      maxToolRounds: config.policy.maxToolRetries + 1,
    },
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      kind: tool.name === "read_file" || tool.name === "write_file" || tool.name === "list_files" || tool.name === "summarize_artifact"
        ? "file"
        : tool.name === "web_search" || tool.name === "url_fetch" || tool.name === "http_request"
          ? "network"
          : tool.name === "git_command" || tool.name === "extract_text" || tool.name === "parse_json" || tool.name === "parse_csv"
            ? "code"
            : "system",
      safe: tool.name !== "write_file" && tool.name !== "shell_command",
      fallbackOnly: tool.name === "shell_command",
    })),
  };
}
