import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runVerifiers } from "../../src/verification.js";
import { WORKSPACE_ROOT } from "../../src/paths.js";

test("schema_check ignores directory-backed json artifacts from list_files output", async () => {
  const fixtureDir = resolve(WORKSPACE_ROOT, "tmp-verification-dir-artifacts");
  const jsonFile = resolve(fixtureDir, "valid.json");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(jsonFile, "{\"ok\":true}", "utf8");

  const result = await runVerifiers({
    jobId: "job_test",
    goal: "verify artifacts",
    executorHistory: [],
    taskRuns: [],
    workspaceRoot: WORKSPACE_ROOT,
    runtimeRoot: resolve(WORKSPACE_ROOT, "runtime"),
    artifacts: [
      {
        id: "artifact_dir",
        type: "json",
        path: fixtureDir,
        contentPreview: "[\"valid.json\"]",
        source: "executor",
      },
      {
        id: "artifact_file",
        type: "json",
        path: jsonFile,
        contentPreview: "{\"ok\":true}",
        source: "executor",
      },
    ],
  });

  const schemaCheck = result.checks.find((check) => check.name === "schema_check");
  assert.ok(schemaCheck);
  assert.equal(schemaCheck?.passed, true);
  assert.equal(schemaCheck?.detail, "All 1 JSON artifacts are valid.");

  rmSync(fixtureDir, { recursive: true, force: true });
});
