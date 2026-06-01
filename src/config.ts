import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatSchemaIssues, isPlainObject, parseSimpleYamlDocument, SchemaValidationError, type ValidationIssue } from "./config-format.js";
import type { AgentLimits, AgentToolPolicy, GoalModeConfig, ModelConfig, ModelRole, ModelRoutingConfig, OrchestratorConfig, RegisteredAgent, RegisteredModel, SearchConfig, SearchProviderType, SkillEvolutionConfig, SkillsConfig } from "./types.js";

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
  return validateModelLikeSection(section, path, issues, path === "planner" ? 120000 : 60000, path === "planner" ? 8192 : 2048, path === "planner" ? 0.2 : 0);
}

function validateModelLikeSection(
  section: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  defaultTimeoutMs: number,
  defaultMaxTokens: number,
  defaultTemperature: number,
): ModelConfig {
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
    timeoutMs: readOptionalNumber(section, path, "timeout_ms", defaultTimeoutMs, issues, { integer: true, min: 1 }),
    maxTokens: readOptionalNumber(section, path, "max_tokens", defaultMaxTokens, issues, { integer: true, min: 1 }),
    temperature: readOptionalNumber(section, path, "temperature", defaultTemperature, issues, { min: 0, max: 2 }),
  };
}

function validateAgentToolPolicy(section: Record<string, unknown>, path: string, issues: ValidationIssue[]): AgentToolPolicy | undefined {
  const allow = section.allow;
  const deny = section.deny;
  const policy: AgentToolPolicy = {};

  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((item) => typeof item !== "string" || !item.trim())) {
      pushIssue(issues, `${path}.allow`, "must be an array of non-empty strings");
    } else {
      policy.allow = allow.map((item) => item.trim());
    }
  }

  if (deny !== undefined) {
    if (!Array.isArray(deny) || deny.some((item) => typeof item !== "string" || !item.trim())) {
      pushIssue(issues, `${path}.deny`, "must be an array of non-empty strings");
    } else {
      policy.deny = deny.map((item) => item.trim());
    }
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function validateAgentLimits(section: Record<string, unknown>, path: string, issues: ValidationIssue[]): AgentLimits | undefined {
  const limits: AgentLimits = {};
  if (section.max_concurrency !== undefined) {
    limits.max_concurrency = readOptionalNumber(section, path, "max_concurrency", 1, issues, { integer: true, min: 1 });
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function validateAgentsSection(root: Record<string, unknown>, issues: ValidationIssue[]): {
  agents?: Record<string, RegisteredAgent>;
  defaultExecutorAgent?: string;
} {
  const agentsRaw = root.agents;
  const defaultExecutorAgentRaw = root.default_executor_agent;
  const result: {
    agents?: Record<string, RegisteredAgent>;
    defaultExecutorAgent?: string;
  } = {};

  if (defaultExecutorAgentRaw !== undefined) {
    if (typeof defaultExecutorAgentRaw !== "string" || !defaultExecutorAgentRaw.trim()) {
      pushIssue(issues, "default_executor_agent", "must be a non-empty string");
    } else {
      result.defaultExecutorAgent = defaultExecutorAgentRaw.trim();
    }
  }

  if (agentsRaw === undefined) {
    return result;
  }
  if (!isPlainObject(agentsRaw)) {
    pushIssue(issues, "agents", "must be an object when provided");
    return result;
  }

  const agents: Record<string, RegisteredAgent> = {};
  for (const [agentId, rawValue] of Object.entries(agentsRaw)) {
    const basePath = `agents.${agentId}`;
    if (!isPlainObject(rawValue)) {
      pushIssue(issues, basePath, "must be an object");
      continue;
    }
    const role = readRequiredString(rawValue, basePath, "role", issues);
    const modelSection = rawValue.model;
    if (!isPlainObject(modelSection)) {
      pushIssue(issues, `${basePath}.model`, "section is required and must be an object");
      continue;
    }
    const model = validateModelLikeSection(modelSection, `${basePath}.model`, issues, 60000, 2048, 0);
    const toolsSection = rawValue.tools;
    const limitsSection = rawValue.limits;
    const tools = isPlainObject(toolsSection)
      ? validateAgentToolPolicy(toolsSection, `${basePath}.tools`, issues)
      : toolsSection === undefined
        ? undefined
        : (pushIssue(issues, `${basePath}.tools`, "must be an object"), undefined);
    const limits = isPlainObject(limitsSection)
      ? validateAgentLimits(limitsSection, `${basePath}.limits`, issues)
      : limitsSection === undefined
        ? undefined
        : (pushIssue(issues, `${basePath}.limits`, "must be an object"), undefined);

    agents[agentId] = {
      id: agentId,
      role,
      model,
      tools,
      limits,
    };
  }

  if (Object.keys(agents).length > 0) {
    result.agents = agents;
  }
  if (result.defaultExecutorAgent && result.agents && !result.agents[result.defaultExecutorAgent]) {
    pushIssue(issues, "default_executor_agent", `references unknown agent "${result.defaultExecutorAgent}"`);
  }
  return result;
}

function validateModelRegistrySection(root: Record<string, unknown>, issues: ValidationIssue[]): Record<string, RegisteredModel> {
  const modelsRaw = root.models;
  const registry: Record<string, RegisteredModel> = {};
  if (modelsRaw === undefined) {
    return registry;
  }
  if (!isPlainObject(modelsRaw)) {
    pushIssue(issues, "models", "must be an object when provided");
    return registry;
  }

  for (const [modelId, rawValue] of Object.entries(modelsRaw)) {
    const basePath = `models.${modelId}`;
    if (!isPlainObject(rawValue)) {
      pushIssue(issues, basePath, "must be an object");
      continue;
    }
    const roleRaw = readRequiredString(rawValue, basePath, "role", issues);
    const role = roleRaw === "planner" || roleRaw === "executor" ? roleRaw : undefined;
    if (!role) {
      pushIssue(issues, `${basePath}.role`, 'must be either "planner" or "executor"');
    }
    const enabledRaw = rawValue.enabled;
    const enabled = enabledRaw === undefined
      ? true
      : typeof enabledRaw === "boolean"
        ? enabledRaw
        : (pushIssue(issues, `${basePath}.enabled`, "must be a boolean"), true);
    registry[modelId] = {
      id: modelId,
      role: (role ?? "executor") as ModelRole,
      enabled,
      model: validateModelLikeSection(rawValue, basePath, issues, role === "planner" ? 120000 : 60000, role === "planner" ? 8192 : 2048, role === "planner" ? 0.2 : 0),
    };
  }

  return registry;
}

function validateModelRoutingSection(
  root: Record<string, unknown>,
  registry: Record<string, RegisteredModel>,
  issues: ValidationIssue[],
): ModelRoutingConfig {
  const routingRaw = root.model_routing;
  const routing: ModelRoutingConfig = {
    plannerCandidates: ["planner.default"],
    executorCandidates: ["executor.default"],
  };
  if (routingRaw === undefined) {
    return routing;
  }
  if (!isPlainObject(routingRaw)) {
    pushIssue(issues, "model_routing", "must be an object when provided");
    return routing;
  }

  const parseCandidateList = (key: "planner_candidates" | "executor_candidates", role: ModelRole): string[] => {
    const value = routingRaw[key];
    if (value === undefined) {
      return role === "planner" ? routing.plannerCandidates : routing.executorCandidates;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      pushIssue(issues, `model_routing.${key}`, "must be an array of non-empty strings");
      return role === "planner" ? routing.plannerCandidates : routing.executorCandidates;
    }

    const normalized = value.map((item) => item.trim());
    for (const candidateId of normalized) {
      const candidate = registry[candidateId];
      if (!candidate) {
        pushIssue(issues, `model_routing.${key}`, `references unknown model "${candidateId}"`);
        continue;
      }
      if (candidate.role !== role) {
        pushIssue(issues, `model_routing.${key}`, `model "${candidateId}" has role "${candidate.role}" and cannot be used as ${role}`);
      }
    }
    return normalized;
  };

  routing.plannerCandidates = parseCandidateList("planner_candidates", "planner");
  routing.executorCandidates = parseCandidateList("executor_candidates", "executor");
  return routing;
}

function dedupeModelIds(modelIds: readonly string[]): string[] {
  return Array.from(new Set(modelIds));
}

export function getRoutedModels(
  config: OrchestratorConfig,
  role: ModelRole,
  options: {
    includeDisabled?: boolean;
  } = {},
): RegisteredModel[] {
  const includeDisabled = options.includeDisabled ?? true;
  const candidateIds = role === "planner"
    ? config.modelRouting.plannerCandidates
    : config.modelRouting.executorCandidates;

  return dedupeModelIds(candidateIds)
    .map((candidateId) => config.modelRegistry[candidateId])
    .filter((candidate): candidate is RegisteredModel => {
      if (!candidate) {
        return false;
      }
      if (candidate.role !== role) {
        return false;
      }
      if (!includeDisabled && !candidate.enabled) {
        return false;
      }
      return true;
    });
}

export function materializeRuntimeModelSelection(config: OrchestratorConfig): OrchestratorConfig {
  const plannerCandidates = getRoutedModels(config, "planner");
  const executorCandidates = getRoutedModels(config, "executor");
  const activePlanner = plannerCandidates[0]?.model ?? config.planner;
  const activeExecutor = executorCandidates[0]?.model ?? config.executor;

  return {
    ...config,
    planner: activePlanner,
    executor: activeExecutor,
    modelRouting: {
      plannerCandidates: plannerCandidates.map((candidate) => candidate.id),
      executorCandidates: executorCandidates.map((candidate) => candidate.id),
    },
  };
}

const VALID_PROVIDER_TYPES: SearchProviderType[] = ["bing_html", "searxng", "serpapi", "bing_api", "google_cse", "url_template", "mcp"];
const VALID_SKILL_SOURCES = ["builtin", "local_dir", "git", "package"] as const;
const VALID_RISK_TIERS = ["low", "medium", "high"] as const;
const VALID_AUTOMATION_CEILINGS = ["auto_reflect", "auto_propose", "auto_audit", "auto_validate", "auto_accept"] as const;

function readOptionalString(section: Record<string, unknown>, path: string, key: string, fallback: string, issues: ValidationIssue[]): string {
  const value = section[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    pushIssue(issues, `${path}.${key}`, "must be a string");
    return fallback;
  }
  return value.trim();
}

function readOptionalBoolean(section: Record<string, unknown>, path: string, key: string, fallback: boolean, issues: ValidationIssue[]): boolean {
  const value = section[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    pushIssue(issues, `${path}.${key}`, "must be a boolean");
    return fallback;
  }
  return value;
}

function readOptionalEnum<T extends string>(
  section: Record<string, unknown>,
  path: string,
  key: string,
  fallback: T,
  allowed: readonly T[],
  issues: ValidationIssue[],
): T {
  const value = section[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    pushIssue(issues, `${path}.${key}`, `must be one of: ${allowed.join(", ")}`);
    return fallback;
  }
  return value as T;
}

function validateSearchSection(root: Record<string, unknown>, issues: ValidationIssue[]): SearchConfig | undefined {
  const searchRaw = root.search;
  if (searchRaw === undefined) return undefined;
  if (!isPlainObject(searchRaw)) {
    pushIssue(issues, "search", "must be an object when provided");
    return undefined;
  }
  const section = searchRaw as Record<string, unknown>;

  const providerRaw = readOptionalString(section, "search", "provider", "bing_html", issues);
  const provider = providerRaw as SearchProviderType;
  if (!VALID_PROVIDER_TYPES.includes(provider)) {
    pushIssue(issues, "search.provider", `must be one of: ${VALID_PROVIDER_TYPES.join(", ")}`);
  }

  const apiKeyRaw = readOptionalString(section, "search", "api_key", "", issues);
  const apiKey = apiKeyRaw ? resolveEnvValue(apiKeyRaw) : "";

  const timeoutMs = readOptionalNumber(section, "search", "timeout_ms", 15000, issues, { integer: true, min: 1000, max: 60000 });
  const fallbackEnabled = readOptionalBoolean(section, "search", "fallback_enabled", true, issues);

  // Collect provider sub-objects
  const providers: Record<string, Record<string, unknown>> = {};
  for (const pType of VALID_PROVIDER_TYPES) {
    if (isPlainObject(section[pType])) {
      providers[pType] = section[pType] as Record<string, unknown>;
    }
  }

  const legacyProviderSection = section[provider];
  if (isPlainObject(legacyProviderSection) && !providers[provider]) {
    providers[provider] = legacyProviderSection as Record<string, unknown>;
  }

  if (provider === "bing_html" && !providers.bing_html) {
    providers.bing_html = {};
  }

  // Validate the active provider's sub-object exists
  if (provider !== "url_template" && !providers[provider]) {
    pushIssue(issues, `search.${provider}`, `provider is set to "${provider}" but the corresponding section is missing`);
  }

  return { provider, fallbackEnabled, apiKey, timeoutMs, providers };
}

function validateSkillsSection(root: Record<string, unknown>, issues: ValidationIssue[]): SkillsConfig {
  const skillsRaw = root.skills;
  if (skillsRaw === undefined) {
    return {
      enabled: true,
      autoInstall: false,
      builtinDir: "skills",
      installDir: "runtime/skills",
      allowSources: ["builtin", "local_dir"],
    };
  }
  if (!isPlainObject(skillsRaw)) {
    pushIssue(issues, "skills", "must be an object when provided");
    return {
      enabled: true,
      autoInstall: false,
      builtinDir: "skills",
      installDir: "runtime/skills",
      allowSources: ["builtin", "local_dir"],
    };
  }

  const section = skillsRaw as Record<string, unknown>;
  const enabled = readOptionalBoolean(section, "skills", "enabled", true, issues);
  const autoInstall = readOptionalBoolean(section, "skills", "auto_install", false, issues);
  const builtinDir = readOptionalString(section, "skills", "builtin_dir", "skills", issues);
  const installDir = readOptionalString(section, "skills", "install_dir", "runtime/skills", issues);
  const allowSourcesRaw = section.allow_sources;
  let allowSources: SkillsConfig["allowSources"] = ["builtin", "local_dir"];
  if (allowSourcesRaw !== undefined) {
    if (!Array.isArray(allowSourcesRaw) || allowSourcesRaw.some((item) => typeof item !== "string" || !item.trim())) {
      pushIssue(issues, "skills.allow_sources", "must be an array of non-empty strings");
    } else {
      const normalized = allowSourcesRaw.map((item) => item.trim()) as string[];
      for (const source of normalized) {
        if (!VALID_SKILL_SOURCES.includes(source as typeof VALID_SKILL_SOURCES[number])) {
          pushIssue(issues, "skills.allow_sources", `unsupported skill source "${source}"`);
        }
      }
      allowSources = normalized.filter((source): source is SkillsConfig["allowSources"][number] =>
        VALID_SKILL_SOURCES.includes(source as typeof VALID_SKILL_SOURCES[number]));
    }
  }

  if (autoInstall && !allowSources.includes("builtin") && !allowSources.includes("local_dir")) {
    pushIssue(issues, "skills.auto_install", "requires at least one installable source in skills.allow_sources");
  }

  return {
    enabled,
    autoInstall,
    builtinDir,
    installDir,
    allowSources,
  };
}

function validateSkillEvolutionSection(root: Record<string, unknown>, issues: ValidationIssue[]): SkillEvolutionConfig {
  const raw = root.skill_evolution;
  if (raw === undefined) {
    return {
      enabled: false,
      autoReflect: true,
      autoPropose: false,
      autoAudit: true,
      autoValidate: false,
      autoAccept: false,
      runtimeReplayInAutoPipeline: false,
      candidateDir: "runtime/skill-evolution",
      riskTiering: {
        enabled: false,
        defaultTier: "medium",
        automationCeilings: {
          low: "auto_accept",
          medium: "auto_validate",
          high: "auto_propose",
        },
      },
    };
  }
  if (!isPlainObject(raw)) {
    pushIssue(issues, "skill_evolution", "must be an object when provided");
    return {
      enabled: false,
      autoReflect: true,
      autoPropose: false,
      autoAudit: true,
      autoValidate: false,
      autoAccept: false,
      runtimeReplayInAutoPipeline: false,
      candidateDir: "runtime/skill-evolution",
      riskTiering: {
        enabled: false,
        defaultTier: "medium",
        automationCeilings: {
          low: "auto_accept",
          medium: "auto_validate",
          high: "auto_propose",
        },
      },
    };
  }

  const section = raw as Record<string, unknown>;
  const riskTieringRaw = section.risk_tiering;
  const riskTieringSection = isPlainObject(riskTieringRaw)
    ? riskTieringRaw as Record<string, unknown>
    : riskTieringRaw === undefined
      ? {}
      : (pushIssue(issues, "skill_evolution.risk_tiering", "must be an object when provided"), {});

  return {
    enabled: readOptionalBoolean(section, "skill_evolution", "enabled", false, issues),
    autoReflect: readOptionalBoolean(section, "skill_evolution", "auto_reflect", true, issues),
    autoPropose: readOptionalBoolean(section, "skill_evolution", "auto_propose", false, issues),
    autoAudit: readOptionalBoolean(section, "skill_evolution", "auto_audit", true, issues),
    autoValidate: readOptionalBoolean(section, "skill_evolution", "auto_validate", false, issues),
    autoAccept: readOptionalBoolean(section, "skill_evolution", "auto_accept", false, issues),
    runtimeReplayInAutoPipeline: readOptionalBoolean(section, "skill_evolution", "runtime_replay_in_auto_pipeline", false, issues),
    candidateDir: readOptionalString(section, "skill_evolution", "candidate_dir", "runtime/skill-evolution", issues),
    riskTiering: {
      enabled: readOptionalBoolean(riskTieringSection, "skill_evolution.risk_tiering", "enabled", false, issues),
      defaultTier: readOptionalEnum(
        riskTieringSection,
        "skill_evolution.risk_tiering",
        "default_tier",
        "medium",
        VALID_RISK_TIERS,
        issues,
      ),
      automationCeilings: {
        low: readOptionalEnum(
          riskTieringSection,
          "skill_evolution.risk_tiering",
          "low_ceiling",
          "auto_accept",
          VALID_AUTOMATION_CEILINGS,
          issues,
        ),
        medium: readOptionalEnum(
          riskTieringSection,
          "skill_evolution.risk_tiering",
          "medium_ceiling",
          "auto_validate",
          VALID_AUTOMATION_CEILINGS,
          issues,
        ),
        high: readOptionalEnum(
          riskTieringSection,
          "skill_evolution.risk_tiering",
          "high_ceiling",
          "auto_propose",
          VALID_AUTOMATION_CEILINGS,
          issues,
        ),
      },
    },
  };
}

function validateGoalModeSection(root: Record<string, unknown>, issues: ValidationIssue[]): GoalModeConfig {
  const defaults: GoalModeConfig = {
    autoInsertLargeChecks: true,
    largeCheckInterval: 3,
    largeCheckMode: "team",
  };
  const raw = root.goal_mode;
  if (raw === undefined) {
    return defaults;
  }
  if (!isPlainObject(raw)) {
    pushIssue(issues, "goal_mode", "must be an object when provided");
    return defaults;
  }
  const section = raw as Record<string, unknown>;
  return {
    autoInsertLargeChecks: readOptionalBoolean(section, "goal_mode", "auto_insert_large_checks", defaults.autoInsertLargeChecks, issues),
    largeCheckInterval: readOptionalNumber(section, "goal_mode", "large_check_interval", defaults.largeCheckInterval, issues, { integer: true, min: 1, max: 20 }),
    largeCheckMode: readOptionalEnum(section, "goal_mode", "large_check_mode", defaults.largeCheckMode, ["task", "team"], issues),
  };
}

export function loadConfig(configPath = process.env.DUAL_AGENT_CONFIG?.trim() || "config/config.yml"): OrchestratorConfig {
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

  const search = validateSearchSection(root, issues);
  const skills = validateSkillsSection(root, issues);
  const skillEvolution = validateSkillEvolutionSection(root, issues);
  const goalMode = validateGoalModeSection(root, issues);
  const agentConfig = validateAgentsSection(root, issues);
  const explicitModelRegistry = validateModelRegistrySection(root, issues);
  const modelRegistry: Record<string, RegisteredModel> = {
    "planner.default": {
      id: "planner.default",
      role: "planner",
      enabled: true,
      model: planner,
    },
    "executor.default": {
      id: "executor.default",
      role: "executor",
      enabled: true,
      model: executor,
    },
    ...explicitModelRegistry,
  };
  const modelRouting = validateModelRoutingSection(root, modelRegistry, issues);

  const config: OrchestratorConfig = {
    planner,
    executor,
    modelRegistry,
    modelRouting,
    agents: agentConfig.agents,
    defaultExecutorAgent: agentConfig.defaultExecutorAgent,
    search,
    skills,
    skillEvolution,
    goalMode,
    policy: {
      maxSteps: readOptionalNumber(policySection, "policy", "max_steps", 12, issues, { integer: true, min: 1 }),
      maxReplans: readOptionalNumber(policySection, "policy", "max_replans", 3, issues, { integer: true, min: 0 }),
      maxToolRetries: readOptionalNumber(policySection, "policy", "max_tool_retries", 2, issues, { integer: true, min: 0 }),
      plannerHistoryMaxEntries: readOptionalNumber(policySection, "policy", "planner_history_max_entries", 6, issues, { integer: true, min: 1 }),
      plannerHistoryPreviewChars: readOptionalNumber(policySection, "policy", "planner_history_preview_chars", 180, issues, { integer: true, min: 1 }),
      maxRepeatedExecutorRequests: readOptionalNumber(policySection, "policy", "max_repeated_executor_requests", 2, issues, { integer: true, min: 1 }),
      autoResumeConcurrency: readOptionalNumber(policySection, "policy", "auto_resume_concurrency", 3, issues, { integer: true, min: 1, max: 32 }),
    },
    taskRoutingPath,
  };

  if (issues.length > 0) {
    throw new SchemaValidationError(
      formatSchemaIssues(issues, `Invalid orchestrator config at ${absPath}`),
      issues,
    );
  }

  return materializeRuntimeModelSelection(config);
}
