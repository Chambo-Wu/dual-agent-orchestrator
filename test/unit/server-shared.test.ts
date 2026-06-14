import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getRuntimeConfig, setConfigOverrideForTests } from "../../src/server/shared.js";
import { buildMinimalConfig } from "../helpers/fake-runtime.js";

test("test config override normalizes a clone without mutating the caller config", () => {
  const config = buildMinimalConfig();
  const absoluteBuiltinDir = resolve(process.cwd(), "runtime/test-server-shared/skills");
  config.skills.builtinDir = absoluteBuiltinDir;

  try {
    setConfigOverrideForTests(config);

    const runtimeConfig = getRuntimeConfig();
    assert.equal(config.skills.builtinDir, absoluteBuiltinDir);
    assert.notEqual(runtimeConfig, config);
    assert.notEqual(runtimeConfig.skills, config.skills);
    assert.equal(runtimeConfig.skills.builtinDir, "runtime/test-server-shared/skills");
  } finally {
    setConfigOverrideForTests(null);
  }
});
