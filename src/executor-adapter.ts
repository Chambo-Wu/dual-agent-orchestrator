import { parseModelJson, tryParseJsonObject } from "./json.js";
import type { ExecutorArtifact, ExecutorOutput, ExecutorToolCall } from "./types.js";

function normalizeToolCalls(input: unknown): ExecutorToolCall[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const tool = typeof record.tool === "string"
      ? record.tool
      : typeof record.name === "string"
        ? record.name
        : "";
    const args = typeof record.arguments === "object" && record.arguments
      ? record.arguments as Record<string, unknown>
      : typeof record.args === "object" && record.args
        ? record.args as Record<string, unknown>
        : {};
    if (!tool) return [];
    return [{ tool, arguments: args }];
  });
}

function normalizeArtifacts(input: unknown): ExecutorArtifact[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const type = record.type;
    const preview = typeof record.content_preview === "string"
      ? record.content_preview
      : typeof record.preview === "string"
        ? record.preview
        : "";
    if (type !== "file" && type !== "text" && type !== "json") return [];
    return [{
      type,
      path: typeof record.path === "string" ? record.path : undefined,
      content_preview: preview,
    }];
  });
}

function normalizeExecutorOutput(candidate: Record<string, unknown>, rawText: string): ExecutorOutput {
  const status = candidate.status === "success" || candidate.status === "failed" || candidate.status === "blocked"
    ? candidate.status
    : "failed";

  return {
    status,
    summary: typeof candidate.summary === "string" ? candidate.summary : "Executor response normalized from model output.",
    tool_calls_made: normalizeToolCalls(candidate.tool_calls_made ?? candidate.tool_calls ?? candidate.actions),
    artifacts: normalizeArtifacts(candidate.artifacts),
    raw_result: typeof candidate.raw_result === "string" ? candidate.raw_result : rawText,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
  };
}

export function parseExecutorOutput(rawText: string): ExecutorOutput {
  const direct = tryParseJsonObject<Record<string, unknown>>(rawText);
  if (direct) {
    return normalizeExecutorOutput(direct, rawText);
  }
  try {
    const parsed = parseModelJson<Record<string, unknown>>(rawText);
    return normalizeExecutorOutput(parsed, rawText);
  } catch {
    // fall through
  }

  return {
    status: "failed",
    summary: "Executor did not return valid JSON.",
    tool_calls_made: [],
    artifacts: [],
    raw_result: rawText,
    error: "Unable to parse executor output as JSON",
  };
}
