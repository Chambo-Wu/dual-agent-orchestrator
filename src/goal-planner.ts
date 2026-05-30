import type { GoalTaskInput } from "./goal-types.js";

export interface LargeCheckPlanningOptions {
  interval?: number;
  mode?: "task" | "team";
}

const DEFAULT_LARGE_CHECK_INTERVAL = 3;
const DEFAULT_LARGE_CHECK_MODE: "task" | "team" = "team";

const SPLIT_PATTERN = /\n+|(?:^|\s)(?:1\.|2\.|3\.|4\.|5\.|6\.|7\.|8\.|9\.)\s+/u;

function compact(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function inferTaskMode(text: string): "task" | "team" {
  return /\b(team|multi-agent|coordination|review)\b|多代理|多人协作|协调/u.test(text) ? "team" : "task";
}

function buildFallbackTasks(goal: string): GoalTaskInput[] {
  return [
    {
      title: "Understand and execute the goal",
      description: compact(goal),
      mode: inferTaskMode(goal),
      kind: "goal_task",
    },
  ];
}

function buildLargeCheckTask(index: number, priorTasks: GoalTaskInput[], mode: "task" | "team"): GoalTaskInput {
  const scope = priorTasks
    .slice(Math.max(0, index - 3), index)
    .map((task) => task.title)
    .join("; ");
  return {
    title: `Large Check ${Math.floor(index / 3)}`,
    description: `Review progress across the recent goal tasks, validate coherence, and identify blockers or gaps before continuing. Scope: ${scope || "recent tasks"}.`,
    mode,
    kind: "large_check",
  };
}

export function insertLargeCheckTasks(tasks: GoalTaskInput[], options?: LargeCheckPlanningOptions): GoalTaskInput[] {
  const normalizedTasks = tasks.filter((task) => task.kind !== "large_check");
  const planned: GoalTaskInput[] = [];
  const interval = Number.isInteger(options?.interval) && (options?.interval ?? 0) > 0
    ? options!.interval!
    : DEFAULT_LARGE_CHECK_INTERVAL;
  const mode = options?.mode ?? DEFAULT_LARGE_CHECK_MODE;

  for (let index = 0; index < normalizedTasks.length; index += 1) {
    if (index > 0 && index % interval === 0) {
      planned.push(buildLargeCheckTask(index, normalizedTasks, mode));
    }
    planned.push(normalizedTasks[index]!);
  }

  return planned;
}

export function planGoalTasks(goal: string, options?: {
  autoInsertLargeChecks?: boolean;
  largeCheckInterval?: number;
  largeCheckMode?: "task" | "team";
}): GoalTaskInput[] {
  const normalized = compact(goal);
  if (!normalized) {
    return [];
  }

  const explicitParts = normalized
    .split(SPLIT_PATTERN)
    .map((part) => compact(part))
    .filter(Boolean);

  const seedTasks: GoalTaskInput[] = explicitParts.length >= 2
    ? explicitParts.map((part, index) => ({
        title: part.length > 48 ? `${part.slice(0, 45)}...` : part,
        description: part,
        mode: inferTaskMode(part),
        kind: "goal_task",
      }))
    : normalized
        .split(/(?:，|,|然后|并且|再|and then|then)\s*/u)
        .map((part) => compact(part))
        .filter((part) => part.length >= 2)
        .map((part) => ({
          title: part.length > 48 ? `${part.slice(0, 45)}...` : part,
          description: part,
          mode: inferTaskMode(part),
          kind: "goal_task",
        }));

  const tasks = seedTasks.length > 0 ? seedTasks : buildFallbackTasks(goal);
  return options?.autoInsertLargeChecks === false
    ? tasks
    : insertLargeCheckTasks(tasks, {
        interval: options?.largeCheckInterval,
        mode: options?.largeCheckMode,
      });
}
