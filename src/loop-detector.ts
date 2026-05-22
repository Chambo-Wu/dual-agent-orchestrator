import type { ExecutorOutput } from "./types.js";

export type LoopType = "missing_file" | "empty_output" | "pseudo_success" | "repeated_blocked" | "repeated_request" | "repeated_tool_failure" | "executor_garbage";

export interface LoopDetectionResult {
  detected: boolean;
  type?: LoopType;
  message?: string;
}

function hasRepeatedMissingFileFailures(history: ExecutorOutput[]): boolean {
  const recent = history.slice(-3);
  if (recent.length < 2) return false;
  return recent.filter((item) =>
    item.status === "blocked"
    && /missing .*file|cannot proceed without|not available/i.test(`${item.summary} ${item.error ?? ""}`)
  ).length >= 2;
}

function detectEmptyOrPseudoSuccess(history: ExecutorOutput[]): boolean {
  const recent = history.slice(-3);
  if (recent.length < 2) return false;
  let count = 0;
  for (const item of recent) {
    const isEmpty = item.source === "model_text" && item.tool_calls_made.length === 0 && item.raw_result.trim().length < 20;
    const isPseudo = item.status === "success" && item.source !== "native_tool" && item.tool_calls_made.length === 0;
    if (isEmpty || isPseudo) count++;
  }
  return count >= 2;
}

function detectRepeatedBlocked(history: ExecutorOutput[]): boolean {
  const recent = history.slice(-4);
  if (recent.length < 3) return false;
  return recent.filter((item) => item.status === "blocked").length >= 3;
}


function detectRepeatedToolFailure(history: ExecutorOutput[]): LoopDetectionResult | null {
  const recent = history.slice(-4);
  if (recent.length < 3) return null;

  // Attribute a failed step to the last tool call it attempted. This avoids
  // blaming earlier successful tools from the same step when a later tool failed.
  const toolFailures = new Map<string, number>();
  for (const item of recent) {
    if (item.status === "failed" || item.error) {
      const failedCall = item.tool_calls_made.at(-1);
      if (failedCall) {
        const key = failedCall.tool;
        toolFailures.set(key, (toolFailures.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [tool, count] of toolFailures) {
    if (count >= 3) {
      return { detected: true, type: "repeated_tool_failure", message: `Tool ${tool} failed ${count} times in recent steps.` };
    }
  }
  return null;
}


function detectExecutorGarbage(history: ExecutorOutput[]): LoopDetectionResult | null {
  const recent = history.slice(-3);
  if (recent.length < 2) return null;
  let garbageCount = 0;
  for (const item of recent) {
    // Failed with no tool calls and source is model text = executor returned unparseable output
    if (item.status === "failed" && item.tool_calls_made.length === 0 && item.source === "model_text") {
      garbageCount++;
    }
  }
  if (garbageCount >= 2) {
    return { detected: true, type: "executor_garbage", message: "Executor returned unparseable output multiple times." };
  }
  return null;
}
export class LoopDetector {
  private requestKeys: string[] = [];
  private repeatedCount = 0;
  private lastKey = "";

  check(history: ExecutorOutput[], currentRequestKey?: string): LoopDetectionResult {
    if (hasRepeatedMissingFileFailures(history)) {
      return { detected: true, type: "missing_file", message: "Repeated missing-file failures." };
    }
    if (detectEmptyOrPseudoSuccess(history)) {
      return { detected: true, type: "empty_output", message: "Repeated empty or pseudo-success outputs." };
    }
    if (detectRepeatedBlocked(history)) {
      return { detected: true, type: "repeated_blocked", message: "Three or more blocked results in recent steps." };
    }
    const toolFailureResult = detectRepeatedToolFailure(history);
    if (toolFailureResult) {
      return toolFailureResult;
    }
    const garbageResult = detectExecutorGarbage(history);
    if (garbageResult) {
      return garbageResult;
    }
    if (currentRequestKey !== undefined) {
      const repeated = this.checkRepeatedRequest(currentRequestKey);
      if (repeated) {
        return { detected: true, type: "repeated_request", message: `Repeated executor request detected (${this.repeatedCount} times).` };
      }
    }
    return { detected: false };
  }

  private checkRepeatedRequest(requestKey: string): boolean {
    if (!requestKey) return false;
    if (requestKey === this.lastKey) {
      this.repeatedCount++;
    } else {
      this.repeatedCount = 0;
      this.lastKey = requestKey;
    }
    return this.repeatedCount > 2;
  }

  reset(): void {
    this.requestKeys = [];
    this.repeatedCount = 0;
    this.lastKey = "";
  }
}
