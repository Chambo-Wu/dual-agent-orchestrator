import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RoutePolicy, TaskType } from "./types.js";

const DEFAULT_TASK_ROUTING: RoutePolicy[] = [
  {
    type: "research",
    matchers: ["github", "repository", "repositories", "research", "literature", "survey"],
    plannerInstruction: "Task type: research. Gather evidence, rank candidates, read artifacts before finalizing, and explain inclusion or exclusion.",
    enableRanking: true,
    requireEvidenceBeforeFinal: true,
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
    matchers: ["web", "website", "internet", "news", "search", "find", "lookup"],
    plannerInstruction: "Task type: web_search. Use external lookup, summarize evidence, and cite sources or artifacts when available.",
    enableRanking: true,
    requireEvidenceBeforeFinal: true,
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseRoutingYaml(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!rawLine.startsWith("  ") && line.endsWith(":")) {
      section = line.slice(0, -1);
      continue;
    }
    const match = rawLine.match(/^\s{2}([a-zA-Z0-9_]+):\s*(.+)\s*$/);
    if (!match || !section) {
      continue;
    }
    result[`${section}.${match[1]}`] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

function routeTypesInOrder(): TaskType[] {
  return DEFAULT_TASK_ROUTING.map((route) => route.type);
}

export function loadTaskRoutingConfig(configPath = "config/task-routing.yml"): RoutePolicy[] {
  const defaultsByType = new Map(DEFAULT_TASK_ROUTING.map((route) => [route.type, route]));
  let flat: Record<string, string> = {};

  try {
    flat = parseRoutingYaml(readFileSync(resolve(configPath), "utf8"));
  } catch {
    return DEFAULT_TASK_ROUTING;
  }

  return routeTypesInOrder().map((type) => {
    const fallback = defaultsByType.get(type);
    if (!fallback) {
      throw new Error(`Missing default route policy for task type ${type}`);
    }

    return {
      type,
      matchers: parseCsv(flat[`${type}.matchers`]).length > 0 ? parseCsv(flat[`${type}.matchers`]) : fallback.matchers,
      plannerInstruction: flat[`${type}.planner_instruction`] || fallback.plannerInstruction,
      enableRanking: parseBoolean(flat[`${type}.enable_ranking`], fallback.enableRanking),
      requireEvidenceBeforeFinal: parseBoolean(flat[`${type}.require_evidence_before_final`], fallback.requireEvidenceBeforeFinal),
      preferredTools: parseCsv(flat[`${type}.preferred_tools`]).length > 0 ? parseCsv(flat[`${type}.preferred_tools`]) : fallback.preferredTools,
      artifactPriority: parseCsv(flat[`${type}.artifact_priority`]).length > 0 ? parseCsv(flat[`${type}.artifact_priority`]) : fallback.artifactPriority,
      completionChecklist: parseCsv(flat[`${type}.completion_checklist`]).length > 0 ? parseCsv(flat[`${type}.completion_checklist`]) : fallback.completionChecklist,
      fallbackRule: flat[`${type}.fallback_rule`] || fallback.fallbackRule,
    };
  });
}
