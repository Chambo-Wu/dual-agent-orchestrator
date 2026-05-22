import { randomUUID } from "node:crypto";
import type { Task, TaskStatus, TaskSpec } from "../types.js";

export function createTask(input: TaskSpec): Task {
  const now = new Date();
  return {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    status: "pending" as TaskStatus,
    assignee: input.assignee,
    dependsOn: input.dependsOn ? [...input.dependsOn] : undefined,
    memoryScope: input.memoryScope,
    result: undefined,
    createdAt: now,
    updatedAt: now,
    maxRetries: input.maxRetries,
    retryDelayMs: input.retryDelayMs,
    retryBackoff: input.retryBackoff,
  };
}

export function isTaskReady(task: Task, allTasks: Task[], taskById?: Map<string, Task>): boolean {
  if (task.status !== "pending") return false;
  if (!task.dependsOn || task.dependsOn.length === 0) return true;
  const map = taskById ?? new Map(allTasks.map((t) => [t.id, t]));
  for (const depId of task.dependsOn) {
    const dep = map.get(depId);
    if (!dep || dep.status !== "completed") return false;
  }
  return true;
}

export function getTaskDependencyOrder(tasks: Task[]): Task[] {
  if (tasks.length === 0) return [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const task of tasks) {
    if (!inDegree.has(task.id)) inDegree.set(task.id, 0);
    if (!successors.has(task.id)) successors.set(task.id, []);
    for (const depId of task.dependsOn ?? []) {
      if (taskById.has(depId)) {
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
        const deps = successors.get(depId) ?? [];
        deps.push(task.id);
        successors.set(depId, deps);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const ordered: Task[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const task = taskById.get(id);
    if (task) ordered.push(task);
    for (const successorId of successors.get(id) ?? []) {
      const newDegree = (inDegree.get(successorId) ?? 0) - 1;
      inDegree.set(successorId, newDegree);
      if (newDegree === 0) queue.push(successorId);
    }
  }
  return ordered;
}

export function validateTaskDependencies(tasks: Task[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      if (depId === task.id) {
        errors.push(`Task "${task.title}" (${task.id}) depends on itself.`);
        continue;
      }
      if (!taskById.has(depId)) {
        errors.push(`Task "${task.title}" (${task.id}) references unknown dependency "${depId}".`);
      }
    }
  }

  const colour = new Map<string, 0 | 1 | 2>();
  for (const task of tasks) colour.set(task.id, 0);

  const visit = (id: string, path: string[]): void => {
    if (colour.get(id) === 2) return;
    if (colour.get(id) === 1) {
      const cycleStart = path.indexOf(id);
      const cycle = path.slice(cycleStart).concat(id);
      errors.push(`Cyclic dependency detected: ${cycle.join(" -> ")}`);
      return;
    }
    colour.set(id, 1);
    const task = taskById.get(id);
    for (const depId of task?.dependsOn ?? []) {
      if (taskById.has(depId)) visit(depId, [...path, id]);
    }
    colour.set(id, 2);
  };

  for (const task of tasks) {
    if (colour.get(task.id) === 0) visit(task.id, []);
  }

  return { valid: errors.length === 0, errors };
}
