import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OrchestratorConfig } from "./types.js";

let dotenvLoaded = false;

function loadDotEnvFile(path = ".env"): void {
  if (dotenvLoaded || !existsSync(path)) {
    dotenvLoaded = true;
    return;
  }

  try {
    const raw = readFileSync(path, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!match) {
        continue;
      }
      const key = match[1].trim();
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } finally {
    dotenvLoaded = true;
  }
}

function parseSimpleYaml(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;
    if (!rawLine.startsWith("  ") && line.endsWith(":")) {
      section = line.slice(0, -1);
      continue;
    }
    const match = rawLine.match(/^\s{2}([a-zA-Z0-9_]+):\s*(.+)\s*$/);
    if (!match || !section) continue;
    result[`${section}.${match[1]}`] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveEnvValue(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const envMatch = value.match(/^env:([A-Z0-9_]+)$/i);
  if (envMatch) {
    return process.env[envMatch[1]]?.trim() || "";
  }
  const braceMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (braceMatch) {
    return process.env[braceMatch[1]]?.trim() || "";
  }
  return value;
}

export function loadConfig(configPath = "config/example.config.yml"): OrchestratorConfig {
  loadDotEnvFile();
  const absPath = resolve(configPath);
  const raw = readFileSync(absPath, "utf8");
  const flat = parseSimpleYaml(raw);

  return {
    planner: {
      provider: "openai_compatible",
      baseUrl: flat["planner.base_url"],
      apiKey: resolveEnvValue(flat["planner.api_key"]),
      model: flat["planner.model"],
      timeoutMs: parseNumber(flat["planner.timeout_ms"], 120000),
      maxTokens: parseNumber(flat["planner.max_tokens"], 8192),
      temperature: parseNumber(flat["planner.temperature"], 0.2),
    },
    executor: {
      provider: "openai_compatible",
      baseUrl: flat["executor.base_url"],
      apiKey: resolveEnvValue(flat["executor.api_key"]),
      model: flat["executor.model"],
      timeoutMs: parseNumber(flat["executor.timeout_ms"], 60000),
      maxTokens: parseNumber(flat["executor.max_tokens"], 2048),
      temperature: parseNumber(flat["executor.temperature"], 0),
    },
    policy: {
      maxSteps: parseNumber(flat["policy.max_steps"], 12),
      maxReplans: parseNumber(flat["policy.max_replans"], 3),
      maxToolRetries: parseNumber(flat["policy.max_tool_retries"], 2),
      plannerHistoryMaxEntries: parseNumber(flat["policy.planner_history_max_entries"], 6),
      plannerHistoryPreviewChars: parseNumber(flat["policy.planner_history_preview_chars"], 180),
      maxRepeatedExecutorRequests: parseNumber(flat["policy.max_repeated_executor_requests"], 2),
    },
    taskRoutingPath: flat["policy.task_routing_path"] || "config/task-routing.yml",
  };
}
