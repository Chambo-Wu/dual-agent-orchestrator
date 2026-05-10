import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_ROOT } from "./paths.js";

export interface RunLogger {
  runId: string;
  logPath: string;
  log: (stage: string, payload: unknown) => void;
}

function safeSerialize(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({
      serialization_error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createRunLogger(userGoal: string): RunLogger {
  const logsDir = resolve(RUNTIME_ROOT, "logs");
  mkdirSync(logsDir, { recursive: true });

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath = resolve(logsDir, `${runId}.jsonl`);

  const log = (stage: string, payload: unknown): void => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      run_id: runId,
      stage,
      payload: safeSerialize(payload),
    });
    writeFileSync(logPath, `${line}\n`, { encoding: "utf8", flag: "a" });
  };

  log("run.started", { user_goal: userGoal });

  return { runId, logPath, log };
}
