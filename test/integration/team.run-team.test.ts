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
