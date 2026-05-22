/**
 * 回归测试矩阵 — 验证所有模块可导入且基础功能正常
 * 运行方式: npx tsx test/regression.ts
 */

import { createTask, isTaskReady, getTaskDependencyOrder, validateTaskDependencies } from "../src/task/task.js";
import { TaskQueue } from "../src/task/queue.js";
import { SharedMemory } from "../src/memory/shared.js";
import { InMemoryStore } from "../src/memory/store.js";
import { ToolRegistry } from "../src/tool/registry.js";
import { Scheduler } from "../src/orchestrator/scheduler.js";
import { AgentPool } from "../src/agent/pool.js";
import { Semaphore } from "../src/utils/semaphore.js";
import { LoopDetector } from "../src/loop-detector.js";
import { compressToolOutput, compressJsonOutput } from "../src/compress.js";
import { buildSingleTaskContract, createJobRecord, createPlanRecord, createTaskRunRecord } from "../src/workflow-contract.js";
import { Tracer } from "../src/trace.js";
import { summarizeToolResultContent, shouldForceTextResponseForToolMessage } from "../src/index.js";
import type { Task, TaskSpec, ExecutorOutput } from "../src/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

// P1-1: Task creation and status
console.log("P1-1: Task system");
const spec: TaskSpec = { title: "Test", description: "desc" };
const task = createTask(spec);
assert(task.status === "pending", "createTask -> pending");
assert(typeof task.id === "string", "createTask has id");

// P1-2: DAG dependency unlock
console.log("P1-2: DAG dependency unlock");
const t1 = createTask({ title: "T1", description: "first" });
const t2 = createTask({ title: "T2", description: "second", dependsOn: [t1.id] });
assert(!isTaskReady(t2, [t1, t2]), "T2 blocked when T1 pending");
const t1Done = { ...t1, status: "completed" as const, verified: true };
assert(isTaskReady(t2, [t1Done, t2]), "T2 ready when T1 verified+completed");
const t1Unverified = { ...t1, status: "completed" as const, verified: false };
assert(isTaskReady(t2, [t1Unverified, t2]), "T2 ready even if T1 unverified (isTaskReady checks status only)");

// TaskQueue verified completion
console.log("P1-2: TaskQueue verified");
const queue = new TaskQueue();
queue.add(createTask({ title: "A", description: "a" }));
const taskA = queue.list()[0]!;
queue.complete(taskA.id, "done", true);
const completed = queue.get(taskA.id);
assert(completed?.verified === true, "queue.complete sets verified=true");

// Topological sort
console.log("P1-2: Topological sort");
const sorted = getTaskDependencyOrder([t2, t1]);
assert(sorted[0]!.id === t1.id, "topo sort: T1 before T2");

// Validation
console.log("P1-2: Validation");
const validation = validateTaskDependencies([t1, t2]);
assert(validation.valid, "valid DAG passes validation");

// P1-3: SharedMemory scopes
console.log("P1-5: SharedMemory scopes");
const mem = new SharedMemory();
await mem.writeScoped("global", "agent1", "key1", "value1");
await mem.writeScoped("task", "agent1", "key2", "value2", "task-123");
const globalEntry = await mem.readScoped("global", "agent1", "key1");
assert(globalEntry?.value === "value1", "global scope read");
const taskEntry = await mem.readScoped("task", "agent1", "key2", "task-123");
assert(taskEntry?.value === "value2", "task scope read");
const wrongTask = await mem.readScoped("task", "agent1", "key2", "wrong-id");
assert(wrongTask === null, "task scope isolation");

// P2-2: LoopDetector
console.log("P2-2: LoopDetector");
const detector = new LoopDetector();
const mockHistory: ExecutorOutput[] = [
  { status: "blocked", summary: "missing file", tool_calls_made: [], artifacts: [], raw_result: "", error: "file not available" },
  { status: "blocked", summary: "missing file", tool_calls_made: [], artifacts: [], raw_result: "", error: "cannot proceed without" },
  { status: "success", summary: "ok", tool_calls_made: [{ tool: "read_file", arguments: {} }], artifacts: [], raw_result: "data", source: "native_tool" },
];
const loopResult = detector.check(mockHistory);
assert(loopResult.detected === true, "detects missing file loop");
assert(loopResult.type === "missing_file", "correct loop type");

// P2-3: Compression
console.log("P2-3: Compression");
const short = "hello";
assert(compressToolOutput(short) === short, "short text unchanged");
const long = "x".repeat(2000);
const compressed = compressToolOutput(long, 500);
assert(compressed.length <= 500, "compressed text within limit");
assert(compressed.includes("chars omitted"), "contains omission marker");

const jsonArray = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item${i}` })));
const compressedJson = compressJsonOutput(jsonArray, 500);
assert(compressedJson.length <= 500, "compressed JSON within limit");
assert(compressedJson.includes("20 items"), "JSON array summary");

// P2-4: Tool-mode summarization
console.log("P2-4: Tool-mode summarization");
const hugeText = "x".repeat(5000);
const summarized = summarizeToolResultContent(hugeText);
assert(summarized.length <= 1200, "tool result content is summarized");
assert(shouldForceTextResponseForToolMessage({ role: "tool", content: summarized }), "summarized tool result triggers text-only follow-up");

// P2-1: Tracer
console.log("P2-1: Tracer");
const tracer = new Tracer();
tracer.emit("task.created", { taskId: "t1" });
tracer.emit("tool.started", { tool: "read_file" });
const events = tracer.getEvents();
assert(events.length === 2, "tracer captures events");
assert(tracer.getSummary().total === 2, "tracer summary count");

// Scheduler
console.log("Scheduler");
const scheduler = new Scheduler("round-robin");
const agents = [{ name: "a1" }, { name: "a2" }];
const assignments = scheduler.schedule([task], agents);
assert(assignments.size === 1, "scheduler assigns 1 task");

// AgentPool
console.log("AgentPool");
const pool = new AgentPool(2);
pool.add("test", async (p) => ({ success: true, output: p }));
assert(pool.list().length === 1, "pool has 1 agent");
const poolResult = await pool.run("test", "hello");
assert(poolResult.success === true, "pool run works");

// Semaphore
console.log("Semaphore");
const sem = new Semaphore(2);
await sem.acquire();
await sem.acquire();
assert(sem.active === 2, "semaphore tracks active");
sem.release();
assert(sem.active === 1, "semaphore release");

// ToolRegistry
console.log("ToolRegistry");
const registry = new ToolRegistry();
registry.register({ name: "echo", description: "echo", parameters: {} }, (args) => ({
  ok: true, summary: "echo", rawResult: JSON.stringify(args),
}));
assert(registry.has("echo"), "registry has echo");
const echoResult = registry.execute("echo", { msg: "hi" });
assert(echoResult.ok === true, "registry execute works");

// Workflow contract
console.log("Workflow contract");
const singleContract = buildSingleTaskContract({
  goal: "Write a report",
  status: "completed",
  verified: true,
  output: "done",
  executorHistory: [
    {
      status: "success",
      summary: "file written",
      tool_calls_made: [{ tool: "write_file", arguments: { path: "runtime/out.md" } }],
      artifacts: [{ type: "file", path: "runtime/out.md", content_preview: "# hi" }],
      raw_result: "ok",
      source: "native_tool",
    },
  ],
});
assert(singleContract.job.mode === "task", "single-task contract uses task mode");
assert(singleContract.taskRuns.length === 1, "single-task contract creates one task run");
assert(singleContract.artifacts.length === 1, "single-task contract collects artifacts");

const teamTaskRun = createTaskRunRecord({
  title: "Subtask",
  description: "desc",
  status: "completed",
  verified: true,
  output: "ok",
  attempts: 1,
});
const teamPlan = createPlanRecord({
  goal: "Goal",
  mode: "team",
  taskRunIds: [teamTaskRun.id],
});
const teamJob = createJobRecord({
  goal: "Goal",
  mode: "team",
  status: "completed",
  verified: true,
  output: "final",
  plan: teamPlan,
  taskRuns: [teamTaskRun],
});
assert(teamJob.plan.taskRunIds.length === 1, "team plan tracks task run ids");
assert(teamJob.taskRuns[0]?.title === "Subtask", "team job carries task runs");

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
