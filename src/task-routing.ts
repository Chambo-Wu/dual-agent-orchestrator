import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatSchemaIssues, isPlainObject, parseSimpleYamlDocument, SchemaValidationError, type ValidationIssue } from "./config-format.js";
import type { RoutePolicy, TaskType } from "./types.js";

const DEFAULT_TASK_ROUTING: RoutePolicy[] = [
  {
    type: "fact_research",
    matchers: ["latest", "official", "release", "releases", "announcement", "announcing", "highlights", "changelog", "release notes", "source", "sources", "summary", "最新", "官方", "发布", "公告", "更新", "更新日志", "发布说明", "来源", "出处", "总结"],
    plannerInstruction: "Task type: fact_research. Gather official evidence, read artifacts back, and produce a concise sourced summary. Do not force candidate ranking unless the user explicitly asked for comparison.",
    enableRanking: false,
    requireEvidenceBeforeFinal: true,
    minGroundedCandidates: 0,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    preferredTools: ["shell_command", "list_files", "read_file"],
    artifactPriority: ["search result artifact", "captured page content", "structured JSON output"],
    completionChecklist: [
      "collect official or primary-source evidence",
      "read back at least one non-empty artifact",
      "identify the strongest source for the answer",
      "final answer cites the strongest artifacts and states any evidence gap",
    ],
    fallbackRule: "If official evidence is weak or ambiguous, return a constrained answer that states the evidence gap instead of inventing comparisons.",
  },
  {
    type: "research",
    matchers: ["github", "repository", "repositories", "comparison", "compare", "ranking", "rank", "evaluate", "survey", "benchmark", "调研", "研究", "案例", "成功案例", "对比", "比较", "评测", "排行", "排名", "趋势", "现状", "优劣", "优势", "劣势", "竞品", "分析", "报告"],
    plannerInstruction: "Task type: research. Gather comparison evidence, rank candidates, read artifacts before finalizing, and explain inclusion or exclusion.",
    enableRanking: true,
    requireEvidenceBeforeFinal: true,
    minGroundedCandidates: 3,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    preferredTools: ["shell_command", "list_files", "read_file"],
    artifactPriority: ["ranking artifact", "search result artifact", "structured JSON output"],
    completionChecklist: [
      "collect external evidence",
      "read back at least one artifact",
      "compare candidates with reasons and concerns",
      "final answer cites the strongest artifacts",
    ],
    fallbackRule: "If evidence is missing, do not guess. Read artifacts or return a constrained answer that states the evidence gap.",
  },
  {
    type: "web_search",
    matchers: ["web", "website", "internet", "news", "search", "find", "lookup", "网页", "网站", "联网", "新闻", "搜索", "查找", "查询", "检索", "查一下"],
    plannerInstruction: "Task type: web_search. Use external lookup, summarize evidence, and cite sources or artifacts when available.",
    enableRanking: true,
    requireEvidenceBeforeFinal: true,
    minGroundedCandidates: 2,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    preferredTools: ["shell_command", "list_files", "read_file"],
    artifactPriority: ["search result artifact", "ranking artifact", "captured page content"],
    completionChecklist: [
      "perform external lookup",
      "preserve non-empty artifacts",
      "read back the strongest artifact before finalizing",
      "state conclusions with evidence",
    ],
    fallbackRule: "If lookup fails, avoid fabricated conclusions and explicitly report the missing external evidence.",
  },
  {
    type: "code",
    matchers: ["code", "debug", "fix", "refactor", "typescript", "javascript", "python", "java", "csharp", "go", "test"],
    plannerInstruction: "Task type: code. Prefer concrete diagnostics, code changes, validation, and concise technical conclusions.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 0,
    requireArtifactReadback: false,
    requireNonEmptyArtifact: false,
    preferredTools: ["list_files", "read_file", "shell_command", "write_file"],
    artifactPriority: ["relevant source files", "test output", "diff-worthy edits"],
    completionChecklist: [
      "identify the relevant file or failing area",
      "apply the minimal effective change",
      "run validation when feasible",
      "summarize the behavioral effect, not just the file touched",
    ],
    fallbackRule: "If validation cannot run, say what was changed and what remains unverified.",
  },
  {
    type: "data_analysis",
    matchers: ["data", "csv", "excel", "spreadsheet", "table", "chart", "analyse", "analyze", "stats"],
    plannerInstruction: "Task type: data_analysis. Prefer structured extraction, aggregation, and concise findings backed by artifacts.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 1,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    preferredTools: ["read_file", "shell_command", "write_file"],
    artifactPriority: ["source dataset", "derived summary artifact", "analysis notes"],
    completionChecklist: [
      "inspect the source data shape",
      "produce a structured summary or aggregation",
      "separate findings from assumptions",
      "report any missing or dirty data limitations",
    ],
    fallbackRule: "If the data is incomplete or malformed, summarize the limitation before drawing conclusions.",
  },
  {
    type: "file_ops",
    matchers: ["read", "write", "file", "json", "markdown", "document"],
    plannerInstruction: "Task type: file_ops. Favor direct file reads and writes, verify the result, and avoid unnecessary exploration.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 0,
    requireArtifactReadback: false,
    requireNonEmptyArtifact: false,
    preferredTools: ["list_files", "read_file", "write_file"],
    artifactPriority: ["target file", "neighboring config or schema files"],
    completionChecklist: [
      "find the intended file quickly",
      "make the requested edit directly",
      "read back or validate the resulting content",
      "avoid unrelated detours",
    ],
    fallbackRule: "If the target path is ambiguous, inspect nearby files instead of broad exploration.",
  },
  {
    type: "shell_ops",
    matchers: ["shell", "command", "terminal", "cli", "script", "cmd", "powershell"],
    plannerInstruction: "Task type: shell_ops. Favor direct command execution, inspect output artifacts, and verify success concisely.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 0,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    preferredTools: ["shell_command", "read_file"],
    artifactPriority: ["command output artifact", "generated report file", "stderr or failure details"],
    completionChecklist: [
      "run the narrowest useful command",
      "inspect the actual output artifact",
      "treat empty output as a signal to retry or adjust",
      "finish with the command result, not speculation",
    ],
    fallbackRule: "If a command is unavailable or empty, prefer an environment-compatible alternative before giving up.",
  },
  {
    type: "general",
    matchers: [],
    plannerInstruction: "Task type: general. Use the simplest viable route and avoid unnecessary branching.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 0,
    requireArtifactReadback: false,
    requireNonEmptyArtifact: false,
    preferredTools: ["list_files", "read_file", "shell_command"],
    artifactPriority: ["most directly relevant artifact"],
    completionChecklist: [
      "pick the simplest path",
      "gather only the evidence needed",
      "avoid over-planning",
      "end once the user goal is satisfied",
    ],
    fallbackRule: "When uncertain, prefer a concrete small step over broad exploration.",
  },
];

function routeTypesInOrder(): TaskType[] {
  return DEFAULT_TASK_ROUTING.map((route) => route.type);
}

function pushIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readSection(root: Record<string, unknown>, type: TaskType): Record<string, unknown> | undefined {
  const value = root[type];
  return isPlainObject(value) ? value : undefined;
}

function readOptionalBoolean(section: Record<string, unknown> | undefined, path: string, key: string, fallback: boolean, issues: ValidationIssue[]): boolean {
  const value = section?.[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    pushIssue(issues, `${path}.${key}`, "must be a boolean");
    return fallback;
  }
  return value;
}

function readOptionalNumber(section: Record<string, unknown> | undefined, path: string, key: string, fallback: number, issues: ValidationIssue[], min = 0): number {
  const value = section?.[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(issues, `${path}.${key}`, "must be a finite number");
    return fallback;
  }
  if (!Number.isInteger(value)) {
    pushIssue(issues, `${path}.${key}`, "must be an integer");
    return fallback;
  }
  if (value < min) {
    pushIssue(issues, `${path}.${key}`, `must be >= ${min}`);
    return fallback;
  }
  return value;
}

function readOptionalString(section: Record<string, unknown> | undefined, path: string, key: string, fallback: string, issues: ValidationIssue[]): string {
  const value = section?.[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !value.trim()) {
    pushIssue(issues, `${path}.${key}`, "must be a non-empty string");
    return fallback;
  }
  return value.trim();
}

function readOptionalStringArray(
  section: Record<string, unknown> | undefined,
  path: string,
  key: string,
  fallback: string[],
  issues: ValidationIssue[],
): string[] {
  const value = section?.[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return splitCsv(value);
  }
  if (Array.isArray(value)) {
    const normalized = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (normalized.length !== value.length) {
      pushIssue(issues, `${path}.${key}`, "must contain only non-empty strings");
      return fallback;
    }
    return normalized;
  }
  pushIssue(issues, `${path}.${key}`, "must be a comma-separated string or string array");
  return fallback;
}

export function loadTaskRoutingConfig(configPath = "config/task-routing.yml"): RoutePolicy[] {
  const defaultsByType = new Map(DEFAULT_TASK_ROUTING.map((route) => [route.type, route]));
  const absPath = resolve(configPath);
  let root: Record<string, unknown>;

  try {
    root = parseSimpleYamlDocument(readFileSync(absPath, "utf8"), absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_TASK_ROUTING;
    }
    throw error;
  }

  const issues: ValidationIssue[] = [];

  const policies = routeTypesInOrder().map((type) => {
    const fallback = defaultsByType.get(type);
    if (!fallback) {
      throw new Error(`Missing default route policy for task type ${type}`);
    }

    const section = readSection(root, type);
    return {
      type,
      matchers: readOptionalStringArray(section, type, "matchers", fallback.matchers, issues),
      plannerInstruction: readOptionalString(section, type, "planner_instruction", fallback.plannerInstruction, issues),
      enableRanking: readOptionalBoolean(section, type, "enable_ranking", fallback.enableRanking, issues),
      requireEvidenceBeforeFinal: readOptionalBoolean(section, type, "require_evidence_before_final", fallback.requireEvidenceBeforeFinal, issues),
      minGroundedCandidates: readOptionalNumber(section, type, "min_grounded_candidates", fallback.minGroundedCandidates, issues, 0),
      requireArtifactReadback: readOptionalBoolean(section, type, "require_artifact_readback", fallback.requireArtifactReadback, issues),
      requireNonEmptyArtifact: readOptionalBoolean(section, type, "require_non_empty_artifact", fallback.requireNonEmptyArtifact, issues),
      preferredTools: readOptionalStringArray(section, type, "preferred_tools", fallback.preferredTools, issues),
      artifactPriority: readOptionalStringArray(section, type, "artifact_priority", fallback.artifactPriority, issues),
      completionChecklist: readOptionalStringArray(section, type, "completion_checklist", fallback.completionChecklist, issues),
      fallbackRule: readOptionalString(section, type, "fallback_rule", fallback.fallbackRule, issues),
    };
  });

  const knownTypes = new Set(routeTypesInOrder());
  for (const key of Object.keys(root)) {
    if (!knownTypes.has(key as TaskType)) {
      pushIssue(issues, key, "is not a recognized task-routing section");
    }
  }

  if (issues.length > 0) {
    throw new SchemaValidationError(
      formatSchemaIssues(issues, `Invalid task routing config at ${absPath}`),
      issues,
    );
  }

  return policies;
}
