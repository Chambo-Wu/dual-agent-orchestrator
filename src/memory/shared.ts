import type { MemoryEntry, MemoryStore } from "../types.js";
import { InMemoryStore } from "./store.js";

const STORE_METHODS = ["get", "set", "list", "delete", "clear"] as const;

function isMemoryStore(v: unknown): v is MemoryStore {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return STORE_METHODS.every((m) => typeof obj[m] === "function");
}

export class SharedMemory {
  private readonly store: MemoryStore;
  private turnCount = 0;

  constructor(store?: MemoryStore) {
    if (store !== undefined && !isMemoryStore(store)) {
      throw new TypeError(
        `SharedMemory: store must implement MemoryStore (methods: ${STORE_METHODS.join(", ")})`,
      );
    }
    this.store = store ?? new InMemoryStore();
  }

  advanceTurn(): void {
    this.turnCount++;
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  async write(agentName: string, key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    const namespacedKey = SharedMemory.namespaceKey(agentName, key);
    await this.store.set(namespacedKey, value, { ...metadata, agent: agentName });
  }

  async writeScoped(scope: "global" | "task" | "step", agentName: string, key: string, value: string, taskId?: string, metadata?: Record<string, unknown>): Promise<void> {
    const scopedKey = SharedMemory.scopedKey(scope, agentName, key, taskId);
    await this.store.set(scopedKey, value, { ...metadata, agent: agentName, scope, taskId });
  }

  async readScoped(scope: "global" | "task" | "step", agentName: string, key: string, taskId?: string): Promise<MemoryEntry | null> {
    const scopedKey = SharedMemory.scopedKey(scope, agentName, key, taskId);
    const entry = await this.store.get(scopedKey);
    if (entry === null) return null;
    if (this.isExpired(entry)) return null;
    return entry;
  }

  async listByScope(scope: "global" | "task" | "step", taskId?: string): Promise<MemoryEntry[]> {
    const prefix = scope === "global" ? "global/" : scope === "task" ? `task:${taskId}/` : `step:${taskId}/`;
    const all = await this.store.list();
    return this.filterExpired(all).filter((entry) => entry.key.startsWith(prefix));
  }

  async writeExpiring(agentName: string, key: string, value: string, ttlTurns: number, metadata?: Record<string, unknown>): Promise<void> {
    if (!Number.isInteger(ttlTurns) || ttlTurns < 1) {
      throw new RangeError(`SharedMemory.writeExpiring: ttlTurns must be >= 1 (got ${ttlTurns})`);
    }
    const namespacedKey = SharedMemory.namespaceKey(agentName, key);
    const fullMetadata = { ...metadata, agent: agentName };
    if (typeof this.store.setWithExpiry === "function") {
      const expiresAtTurn = this.turnCount + ttlTurns;
      await this.store.setWithExpiry(namespacedKey, value, expiresAtTurn, fullMetadata);
    } else {
      await this.store.set(namespacedKey, value, fullMetadata);
    }
  }

  async read(key: string): Promise<MemoryEntry | null> {
    const entry = await this.store.get(key);
    if (entry === null) return null;
    if (this.isExpired(entry)) return null;
    return entry;
  }

  async listAll(): Promise<MemoryEntry[]> {
    return this.filterExpired(await this.store.list());
  }

  async listByAgent(agentName: string): Promise<MemoryEntry[]> {
    const prefix = SharedMemory.namespaceKey(agentName, "");
    const all = await this.store.list();
    return this.filterExpired(all).filter((entry) => entry.key.startsWith(prefix));
  }

  async getSummary(filter?: { taskIds?: string[] }): Promise<string> {
    let all = await this.store.list();
    all = this.filterExpired(all);
    if (filter?.taskIds && filter.taskIds.length > 0) {
      const taskIds = new Set(filter.taskIds);
      all = all.filter((entry) => {
        const slashIdx = entry.key.indexOf("/");
        const localKey = slashIdx === -1 ? entry.key : entry.key.slice(slashIdx + 1);
        if (!localKey.startsWith("task:") || !localKey.endsWith(":result")) return false;
        const taskId = localKey.slice("task:".length, localKey.length - ":result".length);
        return taskIds.has(taskId);
      });
    }
    if (all.length === 0) return "";

    const byAgent = new Map<string, Array<{ localKey: string; value: string }>>();
    for (const entry of all) {
      const slashIdx = entry.key.indexOf("/");
      const agent = slashIdx === -1 ? "_unknown" : entry.key.slice(0, slashIdx);
      const localKey = slashIdx === -1 ? entry.key : entry.key.slice(slashIdx + 1);
      let group = byAgent.get(agent);
      if (!group) {
        group = [];
        byAgent.set(agent, group);
      }
      group.push({ localKey, value: entry.value });
    }

    const lines: string[] = ["## Shared Team Memory", ""];
    for (const [agent, entries] of byAgent) {
      lines.push(`### ${agent}`);
      for (const { localKey, value } of entries) {
        const displayValue = value.length > 200 ? `${value.slice(0, 197)}...` : value;
        lines.push(`- ${localKey}: ${displayValue}`);
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  getStore(): MemoryStore {
    return this.store;
  }

  private static namespaceKey(agentName: string, key: string): string {
    return `${agentName}/${key}`;
  }

  private static scopedKey(scope: "global" | "task" | "step", agentName: string, key: string, taskId?: string): string {
    switch (scope) {
      case "global": return `global/${agentName}/${key}`;
      case "task": return `task:${taskId ?? "unknown"}/${agentName}/${key}`;
      case "step": return `step:${taskId ?? "unknown"}/${agentName}/${key}`;
    }
  }

  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAtTurn !== undefined && this.turnCount >= entry.expiresAtTurn;
  }

  private filterExpired(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter((entry) => !this.isExpired(entry));
  }
}
