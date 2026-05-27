import test from "node:test";
import assert from "node:assert/strict";
import { runTeam } from "../../src/team.js";
import { buildMinimalConfig, createFakeRuntimeDeps, fakeRunTaskResult } from "../helpers/fake-runtime.js";

test("runTeam short-circuit path delegates subtask execution through injected runTask", async () => {
  const config = buildMinimalConfig();
  const calls: string[] = [];

  const result = await runTeam(
    config,
    "Create a todo file",
    [{ name: "executor", role: "task execution" }],
    undefined,
    undefined,
    undefined,
    createFakeRuntimeDeps({
      runTask: async (_config, taskPrompt) => {
        calls.push(taskPrompt);
        return fakeRunTaskResult({
          output: "task completed",
        });
      },
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(result.finalAnswer, "task completed");
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.workflowGraph?.workflow_count, 1);
  assert.equal(result.job.workflowGraph?.edge_count, 0);
});

test("runTeam uses injected decomposition and synthesis for complex goals", async () => {
  const config = buildMinimalConfig();
  const taskPrompts: string[] = [];

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [
      { name: "researcher", role: "inspect code" },
      { name: "writer", role: "write summary" },
    ],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
        { title: "Summarize", description: "Write summary", assignee: "writer", dependsOn: ["Inspect"] },
      ]),
      runTask: async (_config, taskPrompt) => {
        taskPrompts.push(taskPrompt);
        return fakeRunTaskResult({
          output: taskPrompt.includes("Inspect") ? "inspection result" : "summary result",
        });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  assert.equal(taskPrompts.length, 2);
  assert.equal(result.finalAnswer, "final synthesis");
  assert.equal(result.taskRuns.length, 2);
  assert.equal(result.job.workflowGraph?.workflow_id, result.plan.id);
  assert.equal(result.job.workflowGraph?.edge_count, 1);
  assert.deepEqual(result.job.workflowGraph?.workflows[0]?.tasks.map((task) => task.assignee), ["researcher", "writer"]);
});

test("runTeam routes final synthesis through registered synthesizer agent model", async () => {
  const config = buildMinimalConfig();
  config.agents = {
    synthesizer: {
      id: "synthesizer",
      role: "synthesizer",
      model: {
        ...config.planner,
        model: "synth-model",
      },
    },
  };
  const synthesisModels: string[] = [];

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [{ name: "researcher", role: "inspect code" }],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
      ]),
      runTask: async () => fakeRunTaskResult({ output: "inspection result" }),
      runTeamSynthesis: async (synthesisConfig) => {
        synthesisModels.push(synthesisConfig.planner.model);
        return "synthesized by role agent";
      },
    }),
  );

  assert.deepEqual(synthesisModels, ["synth-model"]);
  assert.equal(result.finalAnswer, "synthesized by role agent");
});

test("runTeam routes final synthesis through agent whose role contains synthesizer", async () => {
  const config = buildMinimalConfig();
  config.agents = {
    final_writer: {
      id: "final_writer",
      role: "team synthesizer",
      model: {
        ...config.planner,
        model: "role-synth-model",
      },
    },
  };
  const synthesisModels: string[] = [];

  await runTeam(
    config,
    "First inspect the code and then write a summary",
    [{ name: "researcher", role: "inspect code" }],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
      ]),
      runTask: async () => fakeRunTaskResult({ output: "inspection result" }),
      runTeamSynthesis: async (synthesisConfig) => {
        synthesisModels.push(synthesisConfig.planner.model);
        return "synthesis";
      },
    }),
  );

  assert.deepEqual(synthesisModels, ["role-synth-model"]);
});

test("runTeam planOnly returns a validated plan without executing tasks", async () => {
  const config = buildMinimalConfig();
  let runTaskCalled = false;

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [
      { name: "researcher", role: "inspect code" },
      { name: "writer", role: "write summary" },
    ],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1, planOnly: true },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
        { title: "Summarize", description: "Write summary", assignee: "writer", dependsOn: ["Inspect"] },
      ]),
      runTask: async () => {
        runTaskCalled = true;
        return fakeRunTaskResult();
      },
    }),
  );

  assert.equal(runTaskCalled, false);
  assert.equal(result.taskRuns.length, 2);
  assert.equal(result.job.output, "Plan generated without execution.");
  assert.equal(result.taskRuns.every((taskRun) => taskRun.attempts === 0), true);
});

test("runTeam uses controlled fallback task when decomposition is invalid", async () => {
  const config = buildMinimalConfig();
  const taskPrompts: string[] = [];

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [{ name: "executor", role: "task execution" }],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => "not json",
      runTask: async (_config, taskPrompt) => {
        taskPrompts.push(taskPrompt);
        return fakeRunTaskResult({ output: "fallback completed" });
      },
      runTeamSynthesis: async () => "fallback synthesis",
    }),
  );

  assert.equal(taskPrompts.length, 1);
  assert.equal(result.taskRuns.length, 1);
  assert.equal(result.taskRuns[0]?.title, "Execute goal directly");
  assert.equal(result.finalAnswer, "fallback synthesis");
});

test("runTeam passes upstream task results to dependents through shared memory context", async () => {
  const config = buildMinimalConfig();
  const taskPrompts: string[] = [];

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [
      { name: "researcher", role: "inspect code" },
      { name: "writer", role: "write summary" },
    ],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
        { title: "Summarize", description: "Write summary", assignee: "writer", dependsOn: ["Inspect"] },
      ]),
      runTask: async (_config, taskPrompt) => {
        taskPrompts.push(taskPrompt);
        return fakeRunTaskResult({
          output: taskPrompt.includes("# Task: Inspect") ? "inspection result from memory" : "summary result",
        });
      },
      runTeamSynthesis: async (_config, _goal, _resultsText, memorySummary) => memorySummary,
    }),
  );

  assert.equal(taskPrompts.length, 2);
  assert.equal(taskPrompts[1]?.includes("inspection result from memory"), true);
  assert.equal(result.memorySummary.includes("inspection result from memory"), true);
});

test("runTeam returns a cancelled result when abort signal fires during execution", async () => {
  const config = buildMinimalConfig();
  const controller = new AbortController();

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [
      { name: "researcher", role: "inspect code" },
      { name: "writer", role: "write summary" },
    ],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
        { title: "Summarize", description: "Write summary", assignee: "writer", dependsOn: ["Inspect"] },
      ]),
      runTask: async () => {
        controller.abort("cancelled during task");
        return fakeRunTaskResult({ output: "partial output" });
      },
      runTeamSynthesis: async () => {
        throw new Error("synthesis should not run after cancellation");
      },
    }),
    { abortSignal: controller.signal },
  );

  assert.equal(result.job.status, "blocked");
  assert.equal(result.finalAnswer, "Run cancelled.");
});

test("runTeam routes subtasks to the executor model registered for the assignee", async () => {
  const config = buildMinimalConfig();
  config.defaultExecutorAgent = "researcher";
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
    },
    writer: {
      id: "writer",
      role: "write",
      model: {
        ...config.executor,
        model: "writer-model",
      },
    },
  };
  const modelsUsed: string[] = [];

  await runTeam(
    config,
    "First inspect the code and then write a summary",
    [
      { name: "researcher", role: "inspect code" },
      { name: "writer", role: "write summary" },
    ],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
        { title: "Summarize", description: "Write summary", assignee: "writer", dependsOn: ["Inspect"] },
      ]),
      runTask: async (agentScopedConfig, taskPrompt) => {
        modelsUsed.push(agentScopedConfig.executor.model);
        return fakeRunTaskResult({
          output: taskPrompt.includes("Inspect") ? "inspection result" : "summary result",
        });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  assert.deepEqual(modelsUsed, ["research-model", "writer-model"]);
});

test("runTeam falls back to default executor agent when assignee is not registered", async () => {
  const config = buildMinimalConfig();
  config.defaultExecutorAgent = "researcher";
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
    },
  };
  const modelsUsed: string[] = [];

  await runTeam(
    config,
    "Inspect the codebase",
    [{ name: "ghost", role: "unknown" }],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "ghost" },
      ]),
      runTask: async (agentScopedConfig) => {
        modelsUsed.push(agentScopedConfig.executor.model);
        return fakeRunTaskResult({ output: "inspection result" });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  assert.deepEqual(modelsUsed, ["research-model"]);
});

test("runTeam filters preferred tools through the assigned agent tool policy", async () => {
  const config = buildMinimalConfig();
  config.defaultExecutorAgent = "researcher";
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
      tools: {
        allow: ["list_files", "read_file"],
        deny: ["read_file"],
      },
    },
  };
  const preferredToolsSeen: string[][] = [];

  await runTeam(
    config,
    "Inspect the codebase",
    [{ name: "researcher", role: "research" }],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
      ]),
      runTask: async (_agentScopedConfig, _taskPrompt, routePolicy) => {
        preferredToolsSeen.push([...routePolicy.preferredTools]);
        return fakeRunTaskResult({ output: "inspection result" });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  assert.deepEqual(preferredToolsSeen, [["list_files"]]);
});

test("runTeam passes agent tool policy to executor-scoped config", async () => {
  const config = buildMinimalConfig();
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
      tools: {
        allow: ["list_files"],
        deny: ["write_file"],
      },
    },
  };
  const policiesSeen: Array<typeof config.executorToolPolicy> = [];

  await runTeam(
    config,
    "Inspect the codebase",
    [{ name: "researcher", role: "research" }],
    undefined,
    undefined,
    { maxConcurrency: 1, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
      ]),
      runTask: async (agentScopedConfig) => {
        policiesSeen.push(agentScopedConfig.executorToolPolicy);
        return fakeRunTaskResult({ output: "inspection result" });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  assert.deepEqual(policiesSeen, [{ allow: ["list_files"], deny: ["write_file"] }]);
});

test("runTeam enforces registered agent max concurrency while allowing other agents to run", async () => {
  const config = buildMinimalConfig();
  config.agents = {
    researcher: {
      id: "researcher",
      role: "research",
      model: {
        ...config.executor,
        model: "research-model",
      },
      limits: {
        max_concurrency: 1,
      },
    },
    writer: {
      id: "writer",
      role: "write",
      model: {
        ...config.executor,
        model: "writer-model",
      },
      limits: {
        max_concurrency: 1,
      },
    },
  };
  const activeByModel = new Map<string, number>();
  const maxActiveByModel = new Map<string, number>();

  await runTeam(
    config,
    "First inspect two areas in parallel and then write independently",
    [
      { name: "researcher", role: "research" },
      { name: "writer", role: "write" },
    ],
    undefined,
    undefined,
    { maxConcurrency: 3, maxRounds: 1 },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect A", description: "Inspect area A", assignee: "researcher" },
        { title: "Inspect B", description: "Inspect area B", assignee: "researcher" },
        { title: "Write", description: "Write summary", assignee: "writer" },
      ]),
      runTask: async (agentScopedConfig, taskPrompt) => {
        const model = agentScopedConfig.executor.model;
        const active = (activeByModel.get(model) ?? 0) + 1;
        activeByModel.set(model, active);
        maxActiveByModel.set(model, Math.max(maxActiveByModel.get(model) ?? 0, active));
        await new Promise((resolve) => setTimeout(resolve, taskPrompt.includes("Inspect A") ? 30 : 5));
        activeByModel.set(model, (activeByModel.get(model) ?? 1) - 1);
        return fakeRunTaskResult({ output: `${model} done` });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  assert.equal(maxActiveByModel.get("research-model"), 1);
  assert.equal(maxActiveByModel.get("writer-model"), 1);
  assert.equal([...maxActiveByModel.keys()].includes("writer-model"), true);
});

test("runTeam pauses pending subtasks as awaiting approval before dispatch", async () => {
  const config = buildMinimalConfig();
  let approvalTasks: readonly { id: string; status: string; title: string }[] = [];
  let runTaskCalled = false;
  let approve!: (value: boolean) => void;
  const approvalDecision = new Promise<boolean>((resolve) => {
    approve = resolve;
  });

  const runPromise = runTeam(
    config,
    "First inspect the code and then write a summary",
    [{ name: "researcher", role: "research" }],
    undefined,
    undefined,
    {
      maxConcurrency: 1,
      maxRounds: 1,
      onApproval: async (tasks) => {
        approvalTasks = tasks.map((task) => ({ id: task.id, status: task.status, title: task.title }));
        return approvalDecision;
      },
    },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
      ]),
      runTask: async () => {
        runTaskCalled = true;
        return fakeRunTaskResult({ output: "approved execution" });
      },
      runTeamSynthesis: async () => "final synthesis",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runTaskCalled, false);
  assert.deepEqual(approvalTasks.map((task) => task.status), ["awaiting_approval"]);

  approve(true);
  const result = await runPromise;

  assert.equal(runTaskCalled, true);
  assert.equal(result.job.status, "completed");
  assert.equal(result.taskRuns[0]?.status, "completed");
});

test("runTeam skips pending subtasks when approval is denied", async () => {
  const config = buildMinimalConfig();
  let runTaskCalled = false;

  const result = await runTeam(
    config,
    "First inspect the code and then write a summary",
    [{ name: "researcher", role: "research" }],
    undefined,
    undefined,
    {
      maxConcurrency: 1,
      maxRounds: 1,
      onApproval: async () => false,
    },
    createFakeRuntimeDeps({
      runTeamDecomposition: async () => JSON.stringify([
        { title: "Inspect", description: "Inspect files", assignee: "researcher" },
      ]),
      runTask: async () => {
        runTaskCalled = true;
        return fakeRunTaskResult({ output: "should not run" });
      },
      runTeamSynthesis: async () => "approval denied synthesis",
    }),
  );

  assert.equal(runTaskCalled, false);
  assert.equal(result.job.status, "blocked");
  assert.equal(result.taskRuns[0]?.status, "skipped");
  assert.equal(result.taskRuns[0]?.output, "Skipped: approval rejected.");
});
