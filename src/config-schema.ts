export const CONFIG_SCHEMA_VERSION = "1.0.0";

export interface ConfigFieldSchema {
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  default?: unknown;
  constraints?: {
    min?: number;
    max?: number;
    integer?: boolean;
    absoluteUrl?: boolean;
  };
}

export const CONFIG_SCHEMA: Record<string, ConfigFieldSchema> = {
  "planner.base_url": {
    type: "string",
    required: true,
    description: "Base URL for the planner model API",
    constraints: { absoluteUrl: true },
  },
  "planner.api_key": {
    type: "string",
    required: true,
    description: "API key (or env:VAR_NAME reference)",
  },
  "planner.model": {
    type: "string",
    required: true,
    description: "Model identifier for the planner",
  },
  "planner.timeout_ms": {
    type: "number",
    required: false,
    description: "Request timeout in milliseconds",
    default: 120000,
    constraints: { integer: true, min: 1 },
  },
  "planner.max_tokens": {
    type: "number",
    required: false,
    description: "Maximum tokens for planner responses",
    default: 4096,
    constraints: { integer: true, min: 1 },
  },
  "planner.temperature": {
    type: "number",
    required: false,
    description: "Temperature for planner model",
    default: 0.3,
    constraints: { min: 0, max: 2 },
  },
  "executor.base_url": {
    type: "string",
    required: true,
    description: "Base URL for the executor model API",
    constraints: { absoluteUrl: true },
  },
  "executor.api_key": {
    type: "string",
    required: true,
    description: "API key (or env:VAR_NAME reference)",
  },
  "executor.model": {
    type: "string",
    required: true,
    description: "Model identifier for the executor",
  },
  "executor.timeout_ms": {
    type: "number",
    required: false,
    description: "Request timeout in milliseconds",
    default: 60000,
    constraints: { integer: true, min: 1 },
  },
  "executor.max_tokens": {
    type: "number",
    required: false,
    description: "Maximum tokens for executor responses",
    default: 4096,
    constraints: { integer: true, min: 1 },
  },
  "executor.temperature": {
    type: "number",
    required: false,
    description: "Temperature for executor model",
    default: 0.1,
    constraints: { min: 0, max: 2 },
  },
  "models.<id>.role": {
    type: "string",
    required: false,
    description: "Role for a registered model candidate: planner or executor",
  },
  "models.<id>.base_url": {
    type: "string",
    required: false,
    description: "Base URL for this registered model candidate",
    constraints: { absoluteUrl: true },
  },
  "models.<id>.api_key": {
    type: "string",
    required: false,
    description: "API key (or env:VAR_NAME reference) for this registered model candidate",
  },
  "models.<id>.model": {
    type: "string",
    required: false,
    description: "Model identifier for this registered model candidate",
  },
  "models.<id>.timeout_ms": {
    type: "number",
    required: false,
    description: "Request timeout in milliseconds for this registered model candidate",
    default: 60000,
    constraints: { integer: true, min: 1 },
  },
  "models.<id>.max_tokens": {
    type: "number",
    required: false,
    description: "Maximum tokens for this registered model candidate",
    default: 2048,
    constraints: { integer: true, min: 1 },
  },
  "models.<id>.temperature": {
    type: "number",
    required: false,
    description: "Temperature for this registered model candidate",
    default: 0,
    constraints: { min: 0, max: 2 },
  },
  "models.<id>.enabled": {
    type: "boolean",
    required: false,
    description: "Whether this registered model candidate is enabled for routing",
    default: true,
  },
  "model_routing.planner_candidates": {
    type: "string",
    required: false,
    description: "Ordered planner model candidate ids to consider for planner routing",
  },
  "model_routing.executor_candidates": {
    type: "string",
    required: false,
    description: "Ordered executor model candidate ids to consider for executor routing",
  },
  "default_executor_agent": {
    type: "string",
    required: false,
    description: "Default registered agent id to use when a team task assignee is missing or invalid",
  },
  "agents.<id>.role": {
    type: "string",
    required: false,
    description: "Semantic role label for a registered execution agent",
  },
  "agents.<id>.model.base_url": {
    type: "string",
    required: false,
    description: "Base URL for this execution agent model API",
    constraints: { absoluteUrl: true },
  },
  "agents.<id>.model.api_key": {
    type: "string",
    required: false,
    description: "API key (or env:VAR_NAME reference) for this execution agent model",
  },
  "agents.<id>.model.model": {
    type: "string",
    required: false,
    description: "Model identifier for this execution agent",
  },
  "agents.<id>.model.timeout_ms": {
    type: "number",
    required: false,
    description: "Request timeout in milliseconds for this execution agent",
    default: 60000,
    constraints: { integer: true, min: 1 },
  },
  "agents.<id>.model.max_tokens": {
    type: "number",
    required: false,
    description: "Maximum tokens for this execution agent",
    default: 2048,
    constraints: { integer: true, min: 1 },
  },
  "agents.<id>.model.temperature": {
    type: "number",
    required: false,
    description: "Temperature for this execution agent model",
    default: 0,
    constraints: { min: 0, max: 2 },
  },
  "agents.<id>.tools.allow": {
    type: "string",
    required: false,
    description: "Whitelisted tool names for this execution agent",
  },
  "agents.<id>.tools.deny": {
    type: "string",
    required: false,
    description: "Blacklisted tool names for this execution agent",
  },
  "agents.<id>.limits.max_concurrency": {
    type: "number",
    required: false,
    description: "Maximum concurrent tasks for this execution agent",
    default: 1,
    constraints: { integer: true, min: 1 },
  },
  "policy.max_steps": {
    type: "number",
    required: false,
    description: "Maximum orchestrator steps",
    default: 16,
    constraints: { integer: true, min: 1 },
  },
  "policy.max_replans": {
    type: "number",
    required: false,
    description: "Maximum replan attempts",
    default: 4,
    constraints: { integer: true, min: 0 },
  },
  "policy.max_tool_retries": {
    type: "number",
    required: false,
    description: "Maximum tool retry attempts",
    default: 3,
    constraints: { integer: true, min: 0 },
  },
  "policy.planner_history_max_entries": {
    type: "number",
    required: false,
    description: "Max executor history entries sent to planner",
    default: 6,
    constraints: { integer: true, min: 1 },
  },
  "policy.planner_history_preview_chars": {
    type: "number",
    required: false,
    description: "Max chars per history entry preview",
    default: 2000,
    constraints: { integer: true, min: 100 },
  },
  "policy.max_repeated_executor_requests": {
    type: "number",
    required: false,
    description: "Max identical consecutive executor requests before forced stop",
    default: 2,
    constraints: { integer: true, min: 1 },
  },
  "policy.auto_resume_concurrency": {
    type: "number",
    required: false,
    description: "Maximum number of interrupted jobs the service auto-resumes concurrently after restart",
    default: 3,
    constraints: { integer: true, min: 1, max: 32 },
  },
  "policy.task_routing_path": {
    type: "string",
    required: false,
    description: "Path to task routing YAML config",
  },
  "search.provider": {
    type: "string",
    required: false,
    description: "Active search provider: bing_html, searxng, serpapi, bing_api, google_cse, url_template, mcp",
    default: "bing_html",
  },
  "search.api_key": {
    type: "string",
    required: false,
    description: "Shared API key for search providers (or env:VAR_NAME reference)",
  },
  "search.timeout_ms": {
    type: "number",
    required: false,
    description: "Search request timeout in milliseconds",
    default: 15000,
    constraints: { integer: true, min: 1000, max: 60000 },
  },
  "search.fallback_enabled": {
    type: "boolean",
    required: false,
    description: "Fall back to Bing HTML scraping if the active provider fails",
    default: true,
  },
  "search.bing_html.url_template": {
    type: "string",
    required: false,
    description: "Bing search URL template with {query} placeholder",
    default: "https://www.bing.com/search?q={query}",
  },
  "search.searxng.base_url": {
    type: "string",
    required: false,
    description: "SearXNG instance base URL",
  },
  "search.serpapi.engine": {
    type: "string",
    required: false,
    description: "SerpAPI search engine (google, bing, etc.)",
    default: "google",
  },
  "search.bing_api.endpoint": {
    type: "string",
    required: false,
    description: "Bing Web Search API endpoint",
    default: "https://api.bing.microsoft.com/v7.0/search",
  },
  "search.google_cse.cx": {
    type: "string",
    required: false,
    description: "Google Custom Search Engine ID (or env:VAR_NAME reference)",
  },
  "search.google_cse.endpoint": {
    type: "string",
    required: false,
    description: "Google Custom Search API endpoint",
    default: "https://www.googleapis.com/customsearch/v1",
  },
  "skills.enabled": {
    type: "boolean",
    required: false,
    description: "Whether the skill layer is enabled",
    default: true,
  },
  "skills.auto_install": {
    type: "boolean",
    required: false,
    description: "Whether missing eligible skills may be auto-installed",
    default: false,
  },
  "skills.builtin_dir": {
    type: "string",
    required: false,
    description: "Directory containing builtin skill manifests",
    default: "skills",
  },
  "skills.install_dir": {
    type: "string",
    required: false,
    description: "Directory for installed/local skill manifests and registry",
    default: "runtime/skills",
  },
  "skills.allow_sources": {
    type: "string",
    required: false,
    description: "Allowed skill sources such as builtin and local_dir",
  },
  "skill_evolution.enabled": {
    type: "boolean",
    required: false,
    description: "Whether the skill evolution control plane is enabled",
    default: false,
  },
  "skill_evolution.auto_reflect": {
    type: "boolean",
    required: false,
    description: "Whether completed or failed skill runs may automatically produce reflection records",
    default: true,
  },
  "skill_evolution.auto_propose": {
    type: "boolean",
    required: false,
    description: "Whether reflection records may automatically generate evolution proposals",
    default: false,
  },
  "skill_evolution.auto_audit": {
    type: "boolean",
    required: false,
    description: "Whether proposals may automatically run the auditor gate",
    default: true,
  },
  "skill_evolution.auto_validate": {
    type: "boolean",
    required: false,
    description: "Whether proposals may automatically run deployment validation",
    default: false,
  },
  "skill_evolution.auto_accept": {
    type: "boolean",
    required: false,
    description: "Whether validated low-risk proposals may be automatically accepted",
    default: false,
  },
  "skill_evolution.runtime_replay_in_auto_pipeline": {
    type: "boolean",
    required: false,
    description: "Whether automatic validation should execute deterministic candidate runtime workflow replay before producing the validation report",
    default: false,
  },
  "skill_evolution.candidate_dir": {
    type: "string",
    required: false,
    description: "Directory where candidate skill evolution proposals and reports are stored",
    default: "runtime/skill-evolution",
  },
  "skill_evolution.risk_tiering.enabled": {
    type: "boolean",
    required: false,
    description: "Whether tier-aware automation policy is enabled for skill evolution",
    default: false,
  },
  "skill_evolution.risk_tiering.default_tier": {
    type: "string",
    required: false,
    description: "Default risk tier for skills without a more specific mapping: low, medium, or high",
    default: "medium",
  },
  "skill_evolution.risk_tiering.low_ceiling": {
    type: "string",
    required: false,
    description: "Highest allowed automation stage for low-risk skills",
    default: "auto_accept",
  },
  "skill_evolution.risk_tiering.medium_ceiling": {
    type: "string",
    required: false,
    description: "Highest allowed automation stage for medium-risk skills",
    default: "auto_validate",
  },
  "skill_evolution.risk_tiering.high_ceiling": {
    type: "string",
    required: false,
    description: "Highest allowed automation stage for high-risk skills",
    default: "auto_propose",
  },
  "skill_evolution.risk_tiering.dynamic_window_hours": {
    type: "number",
    required: false,
    description: "Recent-history window, in hours, used for dynamic risk failure clusters and cooldown recovery",
    default: 24,
    constraints: { integer: true, min: 1, max: 168 },
  },
  "skill_evolution.risk_tiering.low_risk_pilot_skills": {
    type: "string",
    required: false,
    description: "Explicit low-risk skill ids allowed to auto-validate as a conservative semi-automation pilot",
    default: [],
  },
  "goal_mode.auto_insert_large_checks": {
    type: "boolean",
    required: false,
    description: "Whether auto-planned goals should insert periodic large_check tasks",
    default: true,
  },
  "goal_mode.large_check_interval": {
    type: "number",
    required: false,
    description: "Number of normal goal tasks between inserted large_check tasks",
    default: 3,
    constraints: { integer: true, min: 1, max: 20 },
  },
  "goal_mode.large_check_mode": {
    type: "string",
    required: false,
    description: "Execution mode for inserted large_check tasks: task or team",
    default: "team",
  },
  "search.mcp.server_url": {
    type: "string",
    required: false,
    description: "MCP server URL for search tool (e.g. Cherry Studio)",
  },
  "search.mcp.tool_name": {
    type: "string",
    required: false,
    description: "MCP tool name to call for search",
    default: "web_search",
  },
  "search.mcp.timeout_ms": {
    type: "number",
    required: false,
    description: "MCP call timeout in milliseconds",
    default: 30000,
    constraints: { integer: true, min: 1000 },
  },
};

export function lookupFieldSchema(fieldPath: string): ConfigFieldSchema | undefined {
  return CONFIG_SCHEMA[fieldPath];
}

export function formatFieldError(fieldPath: string, message: string, value?: unknown): string {
  const schema = CONFIG_SCHEMA[fieldPath];
  if (!schema) {
    return `${fieldPath}: ${message}`;
  }
  let detail = `${fieldPath}: ${message}`;
  if (schema.description) {
    detail += ` (${schema.description})`;
  }
  if (schema.default !== undefined) {
    detail += ` [default: ${JSON.stringify(schema.default)}]`;
  }
  if (value !== undefined) {
    detail += ` (got: ${JSON.stringify(value)})`;
  }
  return detail;
}

export function suggestFieldName(typo: string, validFields: string[]): string | undefined {
  const normalized = typo.toLowerCase().replace(/[-_\s]/g, "");
  for (const field of validFields) {
    const normalizedField = field.toLowerCase().replace(/[-_\s]/g, "");
    if (normalizedField === normalized) return field;
  }
  for (const field of validFields) {
    const normalizedField = field.toLowerCase().replace(/[-_\s]/g, "");
    if (normalizedField.includes(normalized) || normalized.includes(normalizedField)) return field;
  }
  return undefined;
}
