import test from "node:test";
import assert from "node:assert/strict";
import { insertLargeCheckTasks, planGoalTasks } from "../../src/goal-planner.js";

test("goal planner splits multi-step goals into planned tasks", () => {
  const tasks = planGoalTasks("整理需求，然后实现 API，再补测试");

  assert.equal(tasks.length >= 3, true);
  const descriptions = tasks.map((task) => task.description);
  assert.equal(descriptions.some((description) => description.includes("整理需求")), true);
  assert.equal(descriptions.some((description) => description.includes("实现 API")), true);
  assert.equal(descriptions.some((description) => description.includes("补测试")), true);
  assert.equal(tasks.every((task) => task.kind === "goal_task" || task.kind === "large_check"), true);
});

test("goal planner inserts large_check after every three tasks", () => {
  const tasks = planGoalTasks("1. 分析现状 2. 设计方案 3. 实现核心 4. 补测试 5. 收口文档");

  assert.equal(tasks.some((task) => task.title.startsWith("Large Check")), true);
  const largeCheckIndex = tasks.findIndex((task) => task.title.startsWith("Large Check"));
  assert.equal(largeCheckIndex >= 3, true);
  assert.equal(tasks[largeCheckIndex]?.mode, "team");
  assert.equal(tasks[largeCheckIndex]?.kind, "large_check");
  assert.equal(tasks.filter((task) => !task.title.startsWith("Large Check")).every((task) => task.kind === "goal_task"), true);
});

test("large_check insertion can be reused for explicit goal tasks", () => {
  const tasks = insertLargeCheckTasks([
    { title: "Task 1", description: "Task 1", mode: "task", kind: "goal_task" },
    { title: "Task 2", description: "Task 2", mode: "task", kind: "goal_task" },
    { title: "Task 3", description: "Task 3", mode: "task", kind: "goal_task" },
    { title: "Task 4", description: "Task 4", mode: "task", kind: "goal_task" },
  ]);

  assert.equal(tasks.length, 5);
  assert.equal(tasks[3]?.kind, "large_check");
  assert.equal(tasks[3]?.mode, "team");
  assert.equal(tasks[4]?.title, "Task 4");
});

test("large_check insertion supports configurable cadence and mode", () => {
  const tasks = insertLargeCheckTasks([
    { title: "Task A", description: "Task A", mode: "task", kind: "goal_task" },
    { title: "Task B", description: "Task B", mode: "task", kind: "goal_task" },
    { title: "Task C", description: "Task C", mode: "task", kind: "goal_task" },
  ], {
    interval: 2,
    mode: "task",
  });

  assert.equal(tasks.length, 4);
  assert.equal(tasks[2]?.kind, "large_check");
  assert.equal(tasks[2]?.mode, "task");
  assert.equal(tasks[3]?.title, "Task C");
});

test("goal planner falls back to a single task for compact goals", () => {
  const tasks = planGoalTasks("完善 goal mode");

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.description, "完善 goal mode");
  assert.equal(tasks[0]?.kind, "goal_task");
});
