import test from "node:test";
import assert from "node:assert/strict";
import { createTask, getTaskDependencyOrder, isTaskReady, validateTaskDependencies } from "../../src/task/task.js";

test("task dependencies unlock only after upstream completion", () => {
  const first = createTask({ title: "First", description: "first" });
  const second = createTask({ title: "Second", description: "second", dependsOn: [first.id] });

  assert.equal(isTaskReady(second, [first, second]), false);
  assert.equal(isTaskReady(second, [{ ...first, status: "completed" }, second]), true);
});

test("topological task ordering keeps dependencies before dependents", () => {
  const first = createTask({ title: "First", description: "first" });
  const second = createTask({ title: "Second", description: "second", dependsOn: [first.id] });

  const ordered = getTaskDependencyOrder([second, first]);

  assert.equal(ordered[0]?.id, first.id);
  assert.equal(ordered[1]?.id, second.id);
});

test("dependency validation reports missing dependencies and cycles", () => {
  const first = createTask({ title: "First", description: "first" });
  const second = createTask({ title: "Second", description: "second", dependsOn: [first.id] });
  const missing = createTask({ title: "Missing", description: "missing", dependsOn: ["nope"] });
  const cyclicA = createTask({ title: "A", description: "a" });
  const cyclicB = createTask({ title: "B", description: "b", dependsOn: [cyclicA.id] });
  const cyclicAWithDep = { ...cyclicA, dependsOn: [cyclicB.id] };

  assert.equal(validateTaskDependencies([first, second]).valid, true);

  const invalid = validateTaskDependencies([missing, cyclicAWithDep, cyclicB]);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.some((item) => item.includes("unknown dependency")), true);
  assert.equal(invalid.errors.some((item) => item.includes("Cyclic dependency")), true);
});
