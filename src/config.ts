import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatSchemaIssues, isPlainObject, parseSimpleYamlDocument, SchemaValidationError, type ValidationIssue } from "./config-format.js";
import type { ModelConfig, OrchestratorConfig } from "./types.js";

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
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
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

function resolveEnvValue(value: string): string {
  const envMatch = value.match(/^env:([A-Z0-9_]+)$/i);
  if (envMatch) {
    return process.env[envMatch[1]]?.trim() || "";
  }
  const braceMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (braceMatch) {
    return process.env[braceMatch[1]]?.trim() || "";
  }
  return value.trim();
}

function pushIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function readSection(root: Record<string, unknown>, key: string, issues: ValidationIssue[]): Record<string, unknown> {
  const value = root[key];
  if (!isPlainObject(value)) {
    pushIssue(issues, key, "section is required and must be an object");
    return {};
  }
  return value;
}

function readRequiredString(section: Record<string, unknown>, path: string, key: string, issues: ValidationIssue[]): string {
  const value = section[key];
  if (typeof value !== "string" || !value.trim()) {
    pushIssue(issues, `${path}.${key}`, "must be a non-empty string");
    return "";
  }
  return value.trim();
}

function readOptionalNumber(
  section: Record<string, unknown>,
  path: string,
  key: string,
  fallback: number,
  issues: ValidationIssue[],
  options: { integer?: boolean; min?: number; max?: number } = {},
): number {
  const value = section[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(issues, `${path}.${key}`, "must be a finite number");
    return fallback;
  }
  if (options.integer && !Number.isInteger(value)) {
    pushIssue(issues, `${path}.${key}`, "must be an integer");
    return fallback;
  }
  if (options.min !== undefined && value < options.min) {
    pushIssue(issues, `${path}.${key}`, `must be >= ${options.min}`);
    return fallback;
  }
  if (options.max !== undefined && value > options.max) {
    pushIssue(issues, `${path}.${key}`, `must be <= ${options.max}`);
    return fallback;
  }
  return value;
}

function assertValidUrl(value: string, path: string, issues: ValidationIssue[]): void {
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !parsed.host) {
      pushIssue(issues, path, "must be an absolute URL");
    }
  } catch {
    pushIssue(issues, path, "must be an absolute URL");
  }
}

function validateModelSection(section: Record<string, unknown>, path: "planner" | "executor", issues: ValidationIssue[]): ModelConfig {
  const baseUrl = readRequiredString(section, path, "base_url", issues);
  const apiKeyRaw = readRequiredString(section, path, "api_key", issues);
  const model = readRequiredString(section, path, "model", issues);

  if (baseUrl) {
    assertValidUrl(baseUrl, `${path}.base_url`, issues);
  }

  const apiKey = resolveEnvValue(apiKeyRaw);
  if (!apiKey) {
    pushIssue(issues, `${path}.api_key`, "resolved to an empty value; set the env var or provide a literal API key");
  }

  return {
    provider: "openai_compatible",
    baseUrl,
    apiKey,
    model,
    timeoutMs: readOptionalNumber(section, path, "timeout_ms", path === "planner" ? 120000 : 60000, issues, { integer: true, min: 1 }),
    maxTokens: readOptionalNumber(section, path, "max_tokens", path === "planner" ? 8192 : 2048, issues, { integer: true, min: 1 }),
    temperature: readOptionalNumber(section, path, "temperature", path === "planner" ? 0.2 : 0, issues, { min: 0, max: 2 }),
  };
}

export function loadConfig(configPath = "config/example.config.yml"): OrchestratorConfig {
  loadDotEnvFile();
  const absPath = resolve(configPath);
  const raw = readFileSync(absPath, "utf8");
  const root = parseSimpleYamlDocument(raw, absPath);
  const issues: ValidationIssue[] = [];

  const planner = validateModelSection(readSection(root, "planner", issues), "planner", issues);
  const executor = validateModelSection(readSection(root, "executor", issues), "executor", issues);
  const policySection = readSection(root, "policy", issues);

  const taskRoutingPathValue = policySection.task_routing_path;
  let taskRoutingPath = "config/task-routing.yml";
  if (taskRoutingPathValue !== undefined) {
    if (typeof taskRoutingPathValue !== "string" || !taskRoutingPathValue.trim()) {
      pushIssue(issues, "policy.task_routing_path", "must be a non-empty string when provided");
    } else {
      taskRoutingPath = taskRoutingPathValue.trim();
    }
  }

  const config: OrchestratorConfig = {
    planner,
    executor,
    policy: {
      maxSteps: readOptionalNumber(policySection, "policy", "max_steps", 12, issues, { integer: true, min: 1 }),
      maxReplans: readOptionalNumber(policySection, "policy", "max_replans", 3, issues, { integer: true, min: 0 }),
      maxToolRetries: readOptionalNumber(policySection, "policy", "max_tool_retries", 2, issues, { integer: true, min: 0 }),
      plannerHistoryMaxEntries: readOptionalNumber(policySection, "policy", "planner_history_max_entries", 6, issues, { integer: true, min: 1 }),
      plannerHistoryPreviewChars: readOptionalNumber(policySection, "policy", "planner_history_preview_chars", 180, issues, { integer: true, min: 1 }),
      maxRepeatedExecutorRequests: readOptionalNumber(policySection, "policy", "max_repeated_executor_requests", 2, issues, { integer: true, min: 1 }),
    },
    taskRoutingPath,
  };

  if (issues.length > 0) {
    throw new SchemaValidationError(
      formatSchemaIssues(issues, `Invalid orchestrator config at ${absPath}`),
      issues,
    );
  }

  return config;
}

