import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { SchemaValidationError } from "../../src/config-format.js";
import { __testables } from "../../src/index.js";

function writeConfigFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dao-config-"));
  const path = join(dir, "config.yml");
  writeFileSync(path, body, "utf8");
  return path;
}

test("loadConfig reads policy.auto_resume_concurrency", () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
policy:
  auto_resume_concurrency: 5
`);

  try {
    const config = loadConfig(path);
    assert.equal(config.policy.autoResumeConcurrency, 5);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid policy.auto_resume_concurrency", () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
policy:
  auto_resume_concurrency: 0
`);

  try {
    assert.throws(() => loadConfig(path), (error: unknown) => {
      assert.equal(error instanceof SchemaValidationError, true);
      return true;
    });
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("health response exposes auto resume concurrency", () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
policy:
  auto_resume_concurrency: 7
`);

  try {
    const config = loadConfig(path);
    const health = __testables.buildHealthResponse(config) as {
      runtime?: { auto_resume_concurrency?: number };
    };
    assert.equal(health.runtime?.auto_resume_concurrency, 7);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
