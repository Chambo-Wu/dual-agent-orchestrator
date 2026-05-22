import type { ToolDefinition, ToolExecutionResult } from "../types.js";
import { executeTool } from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => ToolExecutionResult | Promise<ToolExecutionResult>;

export class ToolRegistry {
  private readonly tools = new Map<string, {
    definition: ToolDefinition;
    handler: ToolHandler;
  }>();

  register(tool: ToolDefinition, handler?: ToolHandler): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, {
      definition: tool,
      handler: handler ?? ((args) => executeTool(tool.name, args)),
    });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return { ok: false, summary: `Unknown tool: ${name}`, rawResult: "", error: `Tool "${name}" is not registered` };
    }
    try {
      return await entry.handler(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `Tool "${name}" threw: ${msg}`, rawResult: "", error: msg };
    }
  }
}
