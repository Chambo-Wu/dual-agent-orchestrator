import type { ToolExecutionResult } from "../types.js";
import { ToolRegistry } from "./registry.js";
import { Semaphore } from "../utils/semaphore.js";

export interface ToolExecutorOptions {
  maxConcurrency?: number;
  maxToolOutputChars?: number;
}

export interface BatchToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly semaphore: Semaphore;
  private readonly maxToolOutputChars?: number;

  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.registry = registry;
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4);
    this.maxToolOutputChars = options.maxToolOutputChars;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (!this.registry.has(toolName)) {
      return errorResult(`Tool "${toolName}" is not registered.`);
    }
    if (abortSignal?.aborted) {
      return errorResult(`Tool "${toolName}" was aborted before execution.`);
    }
    return this.runTool(toolName, input, abortSignal);
  }

  async executeBatch(
    calls: BatchToolCall[],
    abortSignal?: AbortSignal,
  ): Promise<Map<string, ToolExecutionResult>> {
    const results = new Map<string, ToolExecutionResult>();
    await Promise.all(
      calls.map(async (call) => {
        const result = await this.semaphore.run(() =>
          this.execute(call.name, call.input, abortSignal),
        );
        results.set(call.id, result);
      }),
    );
    return results;
  }

  private async runTool(
    toolName: string,
    input: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (abortSignal?.aborted) {
      return errorResult(`Tool "${toolName}" was aborted.`);
    }
    try {
      const result = await this.registry.execute(toolName, input);
      return this.maybeTruncate(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.maybeTruncate(errorResult(`Tool "${toolName}" threw: ${message}`));
    }
  }

  private maybeTruncate(result: ToolExecutionResult): ToolExecutionResult {
    const maxChars = this.maxToolOutputChars;
    if (maxChars === undefined || maxChars <= 0 || result.rawResult.length <= maxChars) {
      return result;
    }
    return { ...result, rawResult: truncateToolOutput(result.rawResult, maxChars) };
  }
}

function errorResult(message: string): ToolExecutionResult {
  return { ok: false, summary: message, rawResult: "", error: message };
}

export function truncateToolOutput(data: string, maxChars: number): string {
  if (data.length <= maxChars) return data;
  const markerTemplate = "\n\n[...truncated  characters...]\n\n";
  const markerOverhead = markerTemplate.length + String(data.length).length;
  if (maxChars <= markerOverhead) return data.slice(0, maxChars);
  const available = maxChars - markerOverhead;
  const headChars = Math.floor(available * 0.7);
  const tailChars = available - headChars;
  const truncatedCount = data.length - headChars - tailChars;
  return `${data.slice(0, headChars)}\n\n[...truncated ${truncatedCount} characters...]\n\n${data.slice(-tailChars)}`;
}
