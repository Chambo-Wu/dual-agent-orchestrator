import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { SchemaValidationError } from "../../src/config-format.js";
import { __testables } from "../../src/index.js";
import { buildHealthyExecutorRuntimeConfig, NoHealthyExecutorError } from "../../src/model-health.js";
import { modelResponseFromJson } from "../helpers/fake-runtime.js";

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

test("loadConfig normalizes legacy planner and executor into default model routing", () => {
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
  auto_resume_concurrency: 3
`);

  try {
    const config = loadConfig(path);
    assert.deepEqual(config.modelRouting.plannerCandidates, ["planner.default"]);
    assert.deepEqual(config.modelRouting.executorCandidates, ["executor.default"]);
    assert.equal(config.modelRegistry["planner.default"]?.model.model, "planner-model");
    assert.equal(config.modelRegistry["executor.default"]?.model.model, "executor-model");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("loadConfig accepts explicit multi-model registry and routing", () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
models:
  planner_backup:
    role: "planner"
    base_url: "http://127.0.0.1:8081/v1"
    api_key: "literal-planner-backup"
    model: "planner-backup-model"
  executor_local:
    role: "executor"
    base_url: "http://127.0.0.1:1235/v1"
    api_key: "literal-executor-local"
    model: "executor-local-model"
    enabled: false
model_routing:
  planner_candidates: ["planner.default", "planner_backup"]
  executor_candidates: ["executor.default", "executor_local"]
policy:
  auto_resume_concurrency: 3
`);

  try {
    const config = loadConfig(path);
    assert.deepEqual(config.modelRouting.plannerCandidates, ["planner.default", "planner_backup"]);
    assert.deepEqual(config.modelRouting.executorCandidates, ["executor.default", "executor_local"]);
    assert.equal(config.modelRegistry["planner_backup"]?.role, "planner");
    assert.equal(config.modelRegistry["planner_backup"]?.model.model, "planner-backup-model");
    assert.equal(config.modelRegistry["executor_local"]?.role, "executor");
    assert.equal(config.modelRegistry["executor_local"]?.enabled, false);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("loadConfig materializes first routed executor as active runtime executor", () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
models:
  executor_backup:
    role: "executor"
    base_url: "http://127.0.0.1:2234/v1"
    api_key: "literal-executor-backup"
    model: "executor-backup-model"
model_routing:
  executor_candidates: ["executor_backup", "executor.default"]
policy:
  auto_resume_concurrency: 3
`);

  try {
    const config = loadConfig(path);
    assert.equal(config.executor.model, "executor-backup-model");
    assert.equal(config.executor.baseUrl, "http://127.0.0.1:2234/v1");
    assert.deepEqual(config.modelRouting.executorCandidates, ["executor_backup", "executor.default"]);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("health response exposes routed executor candidates", () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
models:
  executor_backup:
    role: "executor"
    base_url: "http://127.0.0.1:2234/v1"
    api_key: "literal-executor-backup"
    model: "executor-backup-model"
model_routing:
  executor_candidates: ["executor_backup", "executor.default"]
policy:
  auto_resume_concurrency: 3
`);

  try {
    const config = loadConfig(path);
    const health = __testables.buildHealthResponse(config) as {
      executor?: { configured_candidates?: string[]; model?: string };
    };
    assert.deepEqual(health.executor?.configured_candidates, ["executor_backup", "executor.default"]);
    assert.equal(health.executor?.model, "executor-backup-model");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("healthy executor selection keeps only successful executor probes", async () => {
  const path = writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
models:
  executor_backup:
    role: "executor"
    base_url: "http://127.0.0.1:2234/v1"
    api_key: "literal-executor-backup"
    model: "executor-backup-model"
model_routing:
  executor_candidates: ["executor_backup", "executor.default"]
policy:
  auto_resume_concurrency: 3
`);

  try {
    const config = loadConfig(path);
    const calls: string[] = [];
    const selection = await buildHealthyExecutorRuntimeConfig(config, async (model) => {
      calls.push(model.model);
      if (model.model === "executor-backup-model") {
        return modelResponseFromJson({ ok: "OK" });
      }
      throw new Error("offline");
    });

    assert.deepEqual(calls, ["executor-backup-model", "executor-model"]);
    assert.deepEqual(selection.healthyExecutorIds, ["executor_backup"]);
    assert.deepEqual(selection.config.modelRouting.executorCandidates, ["executor_backup"]);
    assert.equal(selection.config.executor.model, "executor-backup-model");
    assert.equal(selection.results.find((item) => item.modelId === "executor.default")?.status, "unhealthy");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("health response exposes unhealthy executor probes when none are available", () => {
  const config = {
    ...loadConfig(writeConfigFile(`
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "literal-planner"
  model: "planner-model"
executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "literal-executor"
  model: "executor-model"
policy:
  auto_resume_concurrency: 3
`)),
  };

  const health = __testables.buildHealthResponse(config, [{
    modelId: "executor.default",
    role: "executor",
    status: "unhealthy",
    summary: "Probe timed out.",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "executor-model",
    error: "timeout",
  }]) as {
    executor?: {
      configured_candidates?: string[];
      active_probe?: {
        mode?: string;
        healthy_candidates?: string[];
        health_summary?: {
          total?: number;
          healthy?: number;
          unhealthy?: number;
          disabled?: number;
        };
        health_checks?: Array<{ model_id?: string; status?: string; summary?: string }>;
      };
      runtime_lazy_selection?: {
        mode?: string;
        available?: boolean;
        selected_candidates?: string[];
      };
    };
  };

  assert.deepEqual(health.executor?.configured_candidates, ["executor.default"]);
  assert.equal(health.executor?.active_probe?.mode, "explicit_probe");
  assert.deepEqual(health.executor?.active_probe?.healthy_candidates, []);
  assert.deepEqual(health.executor?.active_probe?.health_summary, {
    total: 1,
    healthy: 0,
    unhealthy: 1,
    disabled: 0,
  });
  assert.deepEqual(health.executor?.active_probe?.health_checks, [{
    model_id: "executor.default",
    status: "unhealthy",
    summary: "Probe timed out.",
  }]);
  assert.equal(health.executor?.runtime_lazy_selection?.mode, "lazy_search_warmup");
  assert.equal(health.executor?.runtime_lazy_selection?.available, false);
  assert.deepEqual(health.executor?.runtime_lazy_selection?.selected_candidates, []);
});

test("NoHealthyExecutorError preserves structured probe results", () => {
  const error = new NoHealthyExecutorError([
    {
      modelId: "executor.default",
      role: "executor",
      status: "unhealthy",
      summary: "Probe failed with upstream status 503.",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "executor-model",
      error: "503 Service Unavailable",
    },
    {
      modelId: "executor_backup",
      role: "executor",
      status: "disabled",
      summary: "Skipped because the model is disabled in config.",
      baseUrl: "http://127.0.0.1:2234/v1",
      model: "executor-backup-model",
    },
  ]);

  assert.equal(error.name, "NoHealthyExecutorError");
  assert.equal(error.message.includes("executor.default"), true);
  assert.equal(error.message.includes("executor_backup"), true);
  assert.equal(error.results.length, 2);
  assert.equal(error.results[0]?.status, "unhealthy");
  assert.equal(error.results[1]?.status, "disabled");
});
