import test from "node:test";
import assert from "node:assert/strict";
import { buildControlledFallbackTask, parseTeamTaskSpecs } from "../../src/team-schema.js";

test("team schema parses valid fenced decomposition", () => {
  const parsed = parseTeamTaskSpecs(`\`\`\`json
[
  {"title":"Inspect","description":"Inspect files","assignee":"researcher"},
  {"title":"Summarize","description":"Summarize findings","assignee":"writer","dependsOn":["Inspect"],"memoryScope":"dependencies"}
]
\`\`\``, ["researcher", "writer"]);

  assert.equal(parsed.valid, true);
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[1]?.dependsOn, ["Inspect"]);
});

test("team schema rejects invalid dependencies, duplicate titles, and unknown agents", () => {
  const parsed = parseTeamTaskSpecs(JSON.stringify([
    { title: "Inspect", description: "Inspect files", assignee: "unknown" },
    { title: "Inspect", description: "Duplicate title" },
    { title: "Summarize", description: "Summarize findings", dependsOn: ["Missing"] },
  ]), ["researcher", "writer"]);

  assert.equal(parsed.valid, false);
  assert.equal(parsed.errors.some((error) => error.includes("unknown agent")), true);
  assert.equal(parsed.errors.some((error) => error.includes("must be unique")), true);
  assert.equal(parsed.errors.some((error) => error.includes("unknown dependency")), true);
});

test("team schema fallback task keeps the goal and reason in one executable task", () => {
  const fallback = buildControlledFallbackTask("Do the goal", "executor", "invalid plan");

  assert.equal(fallback.title, "Execute goal directly");
  assert.equal(fallback.assignee, "executor");
  assert.equal(fallback.description.includes("Do the goal"), true);
  assert.equal(fallback.description.includes("invalid plan"), true);
});
