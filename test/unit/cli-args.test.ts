import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../../src/index.js";

test("team CLI args support plan subcommand", () => {
  const parsed = __testables.parseTeamCliArgs(["plan", "--", "First inspect", "then summarize"]);

  assert.equal(parsed.planOnly, true);
  assert.equal(parsed.goal, "First inspect then summarize");
});

test("team CLI args support --plan-only flag", () => {
  const parsed = __testables.parseTeamCliArgs(["--plan-only", "First inspect", "then summarize"]);

  assert.equal(parsed.planOnly, true);
  assert.equal(parsed.goal, "First inspect then summarize");
});
