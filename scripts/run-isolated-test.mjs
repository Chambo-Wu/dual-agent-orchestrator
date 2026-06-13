import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
let pattern = "";
const files = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--pattern") {
    pattern = args[index + 1] || "";
    index += 1;
    continue;
  }
  files.push(arg);
}

if (files.length === 0) {
  console.error("Usage: node scripts/run-isolated-test.mjs [--pattern <regex>] <test-file...>");
  process.exit(2);
}

const safeName = (pattern || files.join("-"))
  .replace(/[^a-zA-Z0-9_.-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 80) || "node-test";
const runtimeRoot = resolve("runtime", "test-runs", `${Date.now()}-${process.pid}-${safeName}`);
mkdirSync(runtimeRoot, { recursive: true });

const nodeArgs = ["--import", "tsx", "--test"];
if (pattern) {
  nodeArgs.push("--test-name-pattern", pattern);
}
nodeArgs.push(...files);

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    DUAL_AGENT_RUNTIME_ROOT: runtimeRoot,
  },
});

if (process.env.DUAL_AGENT_KEEP_TEST_RUNTIME !== "1") {
  try {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.warn(`Warning: could not remove isolated runtime ${runtimeRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(result.status ?? 1);
