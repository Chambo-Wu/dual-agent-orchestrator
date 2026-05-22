import type { MemoryEntry, MemoryStore } from "../types.js";

export class InMemoryStore implements MemoryStore {
  private readonly data = new Map<string, MemoryEntry>();

  async get(key: string): Promise<MemoryEntry | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    const existing = this.data.get(key);
    const entry: MemoryEntry = {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
    };
    this.data.set(key, entry);
  }

  async setWithExpiry(key: string, value: string, expiresAtTurn: number, metadata?: Record<string, unknown>): Promise<void> {
    const existing = this.data.get(key);
    const entry: MemoryEntry = {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAtTurn,
    };
    this.data.set(key, entry);
  }

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.data.values());
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async search(query: string): Promise<MemoryEntry[]> {
    if (query.length === 0) return this.list();
    const lower = query.toLowerCase();
    return Array.from(this.data.values()).filter(
      (entry) => entry.key.toLowerCase().includes(lower) || entry.value.toLowerCase().includes(lower),
    );
  }

  get size(): number {
    return this.data.size;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }
}
