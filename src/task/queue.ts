import type { Task, TaskStatus } from "../types.js";
import { isTaskReady } from "./task.js";

export type TaskQueueEvent = "task:ready" | "task:complete" | "task:failed" | "task:skipped" | "all:complete";

type TaskHandler = (task: Task) => void;
type AllCompleteHandler = () => void;
type HandlerFor<E extends TaskQueueEvent> = E extends "all:complete" ? AllCompleteHandler : TaskHandler;

export class TaskQueue {
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Map<TaskQueueEvent, Map<symbol, TaskHandler | AllCompleteHandler>>();

  add(task: Task): void {
    const resolved = this.resolveInitialStatus(task);
    this.tasks.set(resolved.id, resolved);
    if (resolved.status === "pending") this.emit("task:ready", resolved);
  }

  addBatch(tasks: Task[]): void {
    for (const task of tasks) this.add(task);
  }

  update(taskId: string, update: Partial<Pick<Task, "status" | "result" | "assignee">>): Task {
    const task = this.requireTask(taskId);
    const updated: Task = { ...task, ...update, updatedAt: new Date() };
    this.tasks.set(taskId, updated);
    return updated;
  }

  complete(taskId: string, result?: string, verified = false): Task {
    const completed: Task = {
      ...this.requireTask(taskId),
      status: "completed",
      result,
      verified,
      updatedAt: new Date(),
    };
    this.tasks.set(taskId, completed);
    this.emit("task:complete", completed);
    this.unblockDependents(taskId);
    if (this.isComplete()) this.emitAllComplete();
    return completed;
  }

  fail(taskId: string, error: string): Task {
    const failed = this.update(taskId, { status: "failed", result: error });
    this.emit("task:failed", failed);
    this.cascadeFailure(taskId);
    if (this.isComplete()) this.emitAllComplete();
    return failed;
  }

  skip(taskId: string, reason: string): Task {
    const skipped = this.update(taskId, { status: "skipped", result: reason });
    this.emit("task:skipped", skipped);
    this.cascadeSkip(taskId);
    if (this.isComplete()) this.emitAllComplete();
    return skipped;
  }

  skipRemaining(reason = "Skipped: approval rejected."): void {
    const snapshot = Array.from(this.tasks.values());
    for (const task of snapshot) {
      if (task.status === "completed" || task.status === "failed" || task.status === "skipped") continue;
      const skipped = this.update(task.id, { status: "skipped", result: reason });
      this.emit("task:skipped", skipped);
    }
    if (this.isComplete()) this.emitAllComplete();
  }

  private cascadeFailure(failedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "blocked" && task.status !== "pending") continue;
      if (!task.dependsOn?.includes(failedTaskId)) continue;
      const cascaded = this.update(task.id, { status: "failed", result: `Cancelled: dependency "${failedTaskId}" failed.` });
      this.emit("task:failed", cascaded);
      this.cascadeFailure(task.id);
    }
  }

  private cascadeSkip(skippedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "blocked" && task.status !== "pending") continue;
      if (!task.dependsOn?.includes(skippedTaskId)) continue;
      const cascaded = this.update(task.id, { status: "skipped", result: `Skipped: dependency "${skippedTaskId}" was skipped.` });
      this.emit("task:skipped", cascaded);
      this.cascadeSkip(task.id);
    }
  }

  next(assignee?: string): Task | undefined {
    if (assignee === undefined) return this.nextAvailable();
    for (const task of this.tasks.values()) {
      if (task.status === "pending" && task.assignee === assignee) return task;
    }
    return undefined;
  }

  nextAvailable(): Task | undefined {
    let fallback: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.status !== "pending") continue;
      if (!task.assignee) return task;
      if (!fallback) fallback = task;
    }
    return fallback;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  getByStatus(status: TaskStatus): Task[] {
    return this.list().filter((t) => t.status === status);
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status !== "completed" && task.status !== "failed" && task.status !== "skipped") return false;
    }
    return true;
  }

  getProgress(): { total: number; completed: number; failed: number; skipped: number; inProgress: number; pending: number; blocked: number; awaitingApproval: number } {
    let completed = 0, failed = 0, skipped = 0, inProgress = 0, pending = 0, blocked = 0, awaitingApproval = 0;
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case "completed": completed++; break;
        case "failed": failed++; break;
        case "skipped": skipped++; break;
        case "in_progress": inProgress++; break;
        case "awaiting_approval": awaitingApproval++; break;
        case "pending": pending++; break;
        case "blocked": blocked++; break;
      }
    }
    return { total: this.tasks.size, completed, failed, skipped, inProgress, pending, blocked, awaitingApproval };
  }

  on<E extends TaskQueueEvent>(event: E, handler: HandlerFor<E>): () => void {
    let map = this.listeners.get(event);
    if (!map) {
      map = new Map();
      this.listeners.set(event, map);
    }
    const id = Symbol();
    map.set(id, handler as TaskHandler | AllCompleteHandler);
    return () => { map!.delete(id); };
  }

  private resolveInitialStatus(task: Task): Task {
    if (!task.dependsOn || task.dependsOn.length === 0) return task;
    const allCurrent = Array.from(this.tasks.values());
    if (isTaskReady(task, allCurrent)) return task;
    return { ...task, status: "blocked", updatedAt: new Date() };
  }

  private unblockDependents(completedId: string): void {
    const allTasks = Array.from(this.tasks.values());
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    for (const task of allTasks) {
      if (task.status !== "blocked") continue;
      if (!task.dependsOn?.includes(completedId)) continue;
      if (isTaskReady({ ...task, status: "pending" }, allTasks, taskById)) {
        const unblocked: Task = { ...task, status: "pending", updatedAt: new Date() };
        this.tasks.set(task.id, unblocked);
        taskById.set(task.id, unblocked);
        this.emit("task:ready", unblocked);
      }
    }
  }

  private emit(event: "task:ready" | "task:complete" | "task:failed" | "task:skipped", task: Task): void {
    const map = this.listeners.get(event);
    if (!map) return;
    for (const handler of map.values()) (handler as TaskHandler)(task);
  }

  private emitAllComplete(): void {
    const map = this.listeners.get("all:complete");
    if (!map) return;
    for (const handler of map.values()) (handler as AllCompleteHandler)();
  }

  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`TaskQueue: task "${taskId}" not found.`);
    return task;
  }
}
