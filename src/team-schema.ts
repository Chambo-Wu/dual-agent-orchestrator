import type { TaskSpec } from "./types.js";

export interface ParsedTaskSpecs {
  valid: boolean;
  tasks: TaskSpec[];
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractJsonArray(raw: string): string | undefined {
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]?.trim()) {
    return fencedMatch[1].trim();
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }

  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return raw.slice(start, end + 1);
}

function readOptionalNonNegativeInteger(value: unknown, path: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${path} must be a non-negative integer`);
    return undefined;
  }
  return value;
}

function validateDependencyGraph(tasks: TaskSpec[], errors: string[]): void {
  const titleSet = new Set(tasks.map((task) => task.title.toLowerCase()));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byTitle = new Map(tasks.map((task) => [task.title.toLowerCase(), task]));

  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      const normalizedDep = dep.toLowerCase();
      if (normalizedDep === task.title.toLowerCase()) {
        errors.push(`Task "${task.title}" cannot depend on itself`);
      }
      if (!titleSet.has(normalizedDep)) {
        errors.push(`Task "${task.title}" references unknown dependency "${dep}"`);
      }
    }
  }

  const visit = (title: string, path: string[]): void => {
    if (visited.has(title)) return;
    if (visiting.has(title)) {
      const cycleStart = path.indexOf(title);
      const cycle = path.slice(Math.max(0, cycleStart)).concat(title);
      errors.push(`Cyclic task dependency detected: ${cycle.join(" -> ")}`);
      return;
    }
    visiting.add(title);
    const task = byTitle.get(title);
    for (const dep of task?.dependsOn ?? []) {
      const normalizedDep = dep.toLowerCase();
      if (byTitle.has(normalizedDep)) visit(normalizedDep, [...path, title]);
    }
    visiting.delete(title);
    visited.add(title);
  };

  for (const task of tasks) {
    visit(task.title.toLowerCase(), []);
  }
}

export function parseTeamTaskSpecs(raw: string, agentNames: readonly string[]): ParsedTaskSpecs {
  const errors: string[] = [];
  const jsonText = extractJsonArray(raw);
  if (!jsonText) {
    return { valid: false, tasks: [], errors: ["decomposition did not contain a JSON array"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, tasks: [], errors: [`decomposition JSON parse failed: ${message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, tasks: [], errors: ["decomposition root must be a JSON array"] };
  }

  const knownAgents = new Set(agentNames);
  const tasks = parsed.flatMap((item, index): TaskSpec[] => {
    const path = `tasks[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${path} must be an object`);
      return [];
    }

    const title = typeof item.title === "string" ? item.title.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!title) errors.push(`${path}.title must be a non-empty string`);
    if (!description) errors.push(`${path}.description must be a non-empty string`);
    if (!title || !description) return [];

    let assignee: string | undefined;
    if (item.assignee !== undefined) {
      if (typeof item.assignee !== "string" || !item.assignee.trim()) {
        errors.push(`${path}.assignee must be a non-empty string when provided`);
      } else if (knownAgents.size > 0 && !knownAgents.has(item.assignee.trim())) {
        errors.push(`${path}.assignee references unknown agent "${item.assignee.trim()}"`);
      } else {
        assignee = item.assignee.trim();
      }
    }

    let dependsOn: string[] | undefined;
    if (item.dependsOn !== undefined) {
      if (!Array.isArray(item.dependsOn)) {
        errors.push(`${path}.dependsOn must be an array of task titles when provided`);
      } else {
        dependsOn = item.dependsOn.flatMap((dep, depIndex): string[] => {
          if (typeof dep !== "string" || !dep.trim()) {
            errors.push(`${path}.dependsOn[${depIndex}] must be a non-empty string`);
            return [];
          }
          return [dep.trim()];
        });
      }
    }

    let memoryScope: TaskSpec["memoryScope"];
    if (item.memoryScope !== undefined) {
      if (item.memoryScope === "all" || item.memoryScope === "dependencies") {
        memoryScope = item.memoryScope;
      } else {
        errors.push(`${path}.memoryScope must be "dependencies" or "all" when provided`);
      }
    }

    return [{
      title,
      description,
      assignee,
      dependsOn,
      memoryScope,
      maxRetries: readOptionalNonNegativeInteger(item.maxRetries, `${path}.maxRetries`, errors),
      retryDelayMs: readOptionalNonNegativeInteger(item.retryDelayMs, `${path}.retryDelayMs`, errors),
      retryBackoff: readOptionalNonNegativeInteger(item.retryBackoff, `${path}.retryBackoff`, errors),
    }];
  });

  const titleCounts = new Map<string, number>();
  for (const task of tasks) {
    const normalized = task.title.toLowerCase();
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }
  for (const task of tasks) {
    if ((titleCounts.get(task.title.toLowerCase()) ?? 0) > 1) {
      errors.push(`Task title "${task.title}" must be unique`);
    }
  }

  validateDependencyGraph(tasks, errors);
  return { valid: errors.length === 0 && tasks.length > 0, tasks, errors };
}

export function buildControlledFallbackTask(goal: string, assignee?: string, reason?: string): TaskSpec {
  return {
    title: "Execute goal directly",
    description: reason ? `${goal}\n\nDecomposition fallback reason: ${reason}` : goal,
    assignee,
    memoryScope: "dependencies",
  };
}
