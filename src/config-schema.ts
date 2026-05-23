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
  "policy.task_routing_path": {
    type: "string",
    required: false,
    description: "Path to task routing YAML config",
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
