import type { Task } from "../types.js";
import type { TaskQueue } from "../task/queue.js";

export type SchedulingStrategy = "round-robin" | "least-busy" | "dependency-first" | "capability-match";

export interface AgentInfo {
  name: string;
  role?: string;
}

function countBlockedDependents(taskId: string, allTasks: Task[]): number {
  const dependents = new Map<string, string[]>();
  for (const t of allTasks) {
    for (const depId of t.dependsOn ?? []) {
      const list = dependents.get(depId) ?? [];
      list.push(t.id);
      dependents.set(depId, list);
    }
  }
  const visited = new Set<string>();
  const queue: string[] = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const depId of dependents.get(current) ?? []) {
      if (!visited.has(depId)) {
        visited.add(depId);
        queue.push(depId);
      }
    }
  }
  return visited.size;
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((w) => w.length >= 2);
}

function keywordScore(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score++;
  }
  return score;
}

export class Scheduler {
  private roundRobinCursor = 0;

  constructor(private readonly strategy: SchedulingStrategy = "dependency-first") {}

  schedule(tasks: Task[], agents: AgentInfo[]): Map<string, string> {
    if (agents.length === 0) return new Map();
    const unassigned = tasks.filter((t) => t.status === "pending" && !t.assignee);
    switch (this.strategy) {
      case "round-robin": return this.scheduleRoundRobin(unassigned, agents);
      case "least-busy": return this.scheduleLeastBusy(unassigned, agents, tasks);
      case "capability-match": return this.scheduleCapabilityMatch(unassigned, agents);
      case "dependency-first": return this.scheduleDependencyFirst(unassigned, agents, tasks);
    }
  }

  autoAssign(queue: TaskQueue, agents: AgentInfo[]): void {
    const allTasks = queue.list();
    const assignments = this.schedule(allTasks, agents);
    for (const [taskId, agentName] of assignments) {
      try { queue.update(taskId, { assignee: agentName }); } catch { /* skip */ }
    }
  }

  private scheduleRoundRobin(unassigned: Task[], agents: AgentInfo[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const task of unassigned) {
      result.set(task.id, agents[this.roundRobinCursor % agents.length]!.name);
      this.roundRobinCursor = (this.roundRobinCursor + 1) % agents.length;
    }
    return result;
  }

  private scheduleLeastBusy(unassigned: Task[], agents: AgentInfo[], allTasks: Task[]): Map<string, string> {
    const load = new Map<string, number>(agents.map((a) => [a.name, 0]));
    for (const task of allTasks) {
      if (task.status === "in_progress" && task.assignee) {
        load.set(task.assignee, (load.get(task.assignee) ?? 0) + 1);
      }
    }
    const result = new Map<string, string>();
    for (const task of unassigned) {
      let bestAgent = agents[0]!;
      let bestLoad = load.get(bestAgent.name) ?? 0;
      for (let i = 1; i < agents.length; i++) {
        const agent = agents[i]!;
        const agentLoad = load.get(agent.name) ?? 0;
        if (agentLoad < bestLoad) { bestLoad = agentLoad; bestAgent = agent; }
      }
      result.set(task.id, bestAgent.name);
      load.set(bestAgent.name, (load.get(bestAgent.name) ?? 0) + 1);
    }
    return result;
  }

  private scheduleCapabilityMatch(unassigned: Task[], agents: AgentInfo[]): Map<string, string> {
    const agentKeywords = new Map<string, string[]>(
      agents.map((a) => [a.name, extractKeywords(`${a.name} ${a.role ?? ""}`)]),
    );
    const result = new Map<string, string>();
    for (const task of unassigned) {
      const taskText = `${task.title} ${task.description}`;
      const taskKeywords = extractKeywords(taskText);
      let bestAgent = agents[0]!;
      let bestScore = -1;
      for (const agent of agents) {
        const agentText = `${agent.name} ${agent.role ?? ""}`;
        const score = keywordScore(agentText, taskKeywords) + keywordScore(taskText, agentKeywords.get(agent.name) ?? []);
        if (score > bestScore) { bestScore = score; bestAgent = agent; }
      }
      result.set(task.id, bestAgent.name);
    }
    return result;
  }

  private scheduleDependencyFirst(unassigned: Task[], agents: AgentInfo[], allTasks: Task[]): Map<string, string> {
    const ranked = [...unassigned].sort((a, b) =>
      countBlockedDependents(b.id, allTasks) - countBlockedDependents(a.id, allTasks),
    );
    const result = new Map<string, string>();
    let cursor = this.roundRobinCursor;
    for (const task of ranked) {
      result.set(task.id, agents[cursor % agents.length]!.name);
      cursor = (cursor + 1) % agents.length;
    }
    this.roundRobinCursor = cursor;
    return result;
  }
}
