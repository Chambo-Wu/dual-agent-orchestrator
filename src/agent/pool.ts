import { Semaphore } from "../utils/semaphore.js";

export interface AgentRunResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface AgentRunner {
  (prompt: string): Promise<AgentRunResult>;
}

export class AgentPool {
  private readonly agents = new Map<string, AgentRunner>();
  private readonly semaphore: Semaphore;
  private readonly agentLocks = new Map<string, Semaphore>();
  private roundRobinIndex = 0;

  constructor(private readonly maxConcurrency: number = 5) {
    this.semaphore = new Semaphore(maxConcurrency);
  }

  get availableRunSlots(): number {
    return this.maxConcurrency - this.semaphore.active;
  }

  add(name: string, runner: AgentRunner): void {
    if (this.agents.has(name)) {
      throw new Error(`AgentPool: agent "${name}" is already registered.`);
    }
    this.agents.set(name, runner);
    this.agentLocks.set(name, new Semaphore(1));
  }

  remove(name: string): void {
    if (!this.agents.has(name)) {
      throw new Error(`AgentPool: agent "${name}" is not registered.`);
    }
    this.agents.delete(name);
    this.agentLocks.delete(name);
  }

  get(name: string): AgentRunner | undefined {
    return this.agents.get(name);
  }

  list(): string[] {
    return Array.from(this.agents.keys());
  }

  async run(agentName: string, prompt: string): Promise<AgentRunResult> {
    const runner = this.agents.get(agentName);
    if (!runner) {
      throw new Error(`AgentPool: agent "${agentName}" not registered. Available: [${this.list().join(", ")}]`);
    }
    const agentLock = this.agentLocks.get(agentName)!;
    await agentLock.acquire();
    try {
      await this.semaphore.acquire();
      try {
        return await runner(prompt);
      } finally {
        this.semaphore.release();
      }
    } finally {
      agentLock.release();
    }
  }

  async runEphemeral(runner: AgentRunner, prompt: string): Promise<AgentRunResult> {
    await this.semaphore.acquire();
    try {
      return await runner(prompt);
    } finally {
      this.semaphore.release();
    }
  }

  async runParallel(tasks: ReadonlyArray<{ readonly agent: string; readonly prompt: string }>): Promise<Map<string, AgentRunResult>> {
    const resultMap = new Map<string, AgentRunResult>();
    const settledResults = await Promise.allSettled(
      tasks.map(async (t) => ({ name: t.agent, result: await this.run(t.agent, t.prompt) })),
    );
    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i]!;
      if (settled.status === "fulfilled") {
        resultMap.set(settled.value.name, settled.value.result);
      } else {
        const agentName = tasks[i]?.agent ?? "unknown";
        const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        resultMap.set(agentName, { success: false, output: msg, error: msg });
      }
    }
    return resultMap;
  }

  async shutdown(): Promise<void> {
    // No-op for now — runners are stateless functions
  }
}
