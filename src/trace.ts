import type { RunLogger } from "./logger.js";

export type TraceEventType =
  | "task.created"
  | "task.started"
  | "task.awaiting_approval"
  | "task.completed"
  | "task.failed"
  | "task.blocked"
  | "task.retry"
  | "dependency.resolved"
  | "dependency.blocked"
  | "artifact.created"
  | "artifact.read"
  | "artifact.verified"
  | "artifact.rejected"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "state.transition"
  | "loop.detected"
  | "goal.achieved"
  | "round.started"
  | "round.completed"
  | "synthesis.started"
  | "synthesis.completed";

export interface TraceEvent {
  type: TraceEventType;
  timestamp: string;
  runId: string;
  taskId?: string;
  agent?: string;
  tool?: string;
  artifact?: { type: string; path?: string; verified: boolean };
  duration?: number;
  data?: Record<string, unknown>;
}

export class Tracer {
  private readonly logger?: RunLogger;
  private readonly events: TraceEvent[] = [];
  private readonly pendingTimers = new Map<string, number>();

  constructor(logger?: RunLogger) {
    this.logger = logger;
  }

  emit(type: TraceEventType, data?: Record<string, unknown>): TraceEvent {
    const event: TraceEvent = {
      type,
      timestamp: new Date().toISOString(),
      runId: this.logger?.runId ?? "unknown",
      ...data,
    };
    this.events.push(event);
    this.logger?.log(`trace.${type}`, event);
    return event;
  }

  startTimer(key: string): void {
    this.pendingTimers.set(key, Date.now());
  }

  stopTimer(key: string): number {
    const start = this.pendingTimers.get(key);
    if (start === undefined) return 0;
    const duration = Date.now() - start;
    this.pendingTimers.delete(key);
    return duration;
  }

  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  getEventsByTask(taskId: string): TraceEvent[] {
    return this.events.filter((e) => e.taskId === taskId);
  }

  getEventsByType(type: TraceEventType): TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  getSummary(): { total: number; byType: Record<string, number>; tasks: number; artifacts: number; tools: number; loops: number } {
    const byType: Record<string, number> = {};
    let tasks = 0, artifacts = 0, tools = 0, loops = 0;
    for (const e of this.events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      if (e.type.startsWith("task.")) tasks++;
      if (e.type.startsWith("artifact.")) artifacts++;
      if (e.type.startsWith("tool.")) tools++;
      if (e.type === "loop.detected") loops++;
    }
    return { total: this.events.length, byType, tasks, artifacts, tools, loops };
  }
}
