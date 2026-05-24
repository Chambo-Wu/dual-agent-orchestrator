import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { RUNTIME_ROOT } from "./paths.js";
import type { WorkflowUiEvent } from "./workflow-ui-events.js";

// ---------------------------------------------------------------------------
// Job Event Bus
// ---------------------------------------------------------------------------

type EventListener = (event: WorkflowUiEvent) => void;

interface JobEventState {
  seq: number;
  events: WorkflowUiEvent[];
  listeners: Set<EventListener>;
}

const jobStates = new Map<string, JobEventState>();

function getJobState(jobId: string): JobEventState {
  let state = jobStates.get(jobId);
  if (!state) {
    state = { seq: 0, events: [], listeners: new Set() };
    jobStates.set(jobId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getNextSeq(jobId: string): number {
  const state = getJobState(jobId);
  return ++state.seq;
}

export function appendEvent(event: WorkflowUiEvent): void {
  const state = getJobState(event.jobId);
  state.events.push(event);

  // Persist to JSONL
  persistEvent(event);

  // Notify listeners
  for (const listener of state.listeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener errors
    }
  }
}

export function getEvents(jobId: string, sinceSeq?: number): WorkflowUiEvent[] {
  const state = getJobState(jobId);
  if (sinceSeq === undefined) {
    return [...state.events];
  }
  return state.events.filter((e) => e.seq > sinceSeq);
}

export function getLatestSnapshot(jobId: string): Record<string, unknown> | null {
  const state = getJobState(jobId);
  if (state.events.length === 0) return null;

  const latestPlanner = [...state.events].reverse().find((e) => e.agent === "planner");
  const latestExecutor = [...state.events].reverse().find((e) => e.agent === "executor");
  const latestTool = [...state.events].reverse().find((e) => e.agent === "tool");

  return {
    job_id: jobId,
    seq: state.seq,
    event_count: state.events.length,
    latest_planner: latestPlanner ? {
      type: latestPlanner.type,
      title: latestPlanner.title,
      summary: latestPlanner.summary,
      status: latestPlanner.status,
      step: latestPlanner.step,
    } : null,
    latest_executor: latestExecutor ? {
      type: latestExecutor.type,
      title: latestExecutor.title,
      summary: latestExecutor.summary,
      status: latestExecutor.status,
      step: latestExecutor.step,
    } : null,
    latest_tool: latestTool ? {
      type: latestTool.type,
      title: latestTool.title,
      summary: latestTool.summary,
      status: latestTool.status,
      step: latestTool.step,
    } : null,
  };
}

export function subscribe(jobId: string, listener: EventListener): () => void {
  const state = getJobState(jobId);
  state.listeners.add(listener);

  // Return unsubscribe function
  return () => {
    state.listeners.delete(listener);
  };
}

export function cleanupJob(jobId: string): void {
  jobStates.delete(jobId);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getEventsFilePath(jobId: string): string {
  return resolve(RUNTIME_ROOT, "jobs", jobId, "events.jsonl");
}

function persistEvent(event: WorkflowUiEvent): void {
  const filePath = getEventsFilePath(event.jobId);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
}

export function loadEventsFromDisk(jobId: string): WorkflowUiEvent[] {
  const filePath = getEventsFilePath(jobId);
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());
    const events: WorkflowUiEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as WorkflowUiEvent);
      } catch {
        // Skip malformed lines
      }
    }

    // Update seq to match loaded events
    if (events.length > 0) {
      const state = getJobState(jobId);
      state.events = events;
      state.seq = Math.max(...events.map((e) => e.seq));
    }

    return events;
  } catch {
    return [];
  }
}
