import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SharedMemory } from "../../src/memory/shared.js";
import { ToolRegistry } from "../../src/tool/registry.js";
import { executeTool } from "../../src/tools.js";
import { WORKSPACE_ROOT } from "../../src/paths.js";

test("shared memory isolates task-scoped values", async () => {
  const memory = new SharedMemory();

  await memory.writeScoped("task", "agent", "context", "task value", "task-1");

  assert.equal((await memory.readScoped("task", "agent", "context", "task-1"))?.value, "task value");
  assert.equal(await memory.readScoped("task", "agent", "context", "task-2"), null);
});

test("tool registry executes registered handlers and reports unknown tools", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "echo", description: "echo", parameters: {} }, (args) => ({
    ok: true,
    summary: "echo",
    rawResult: JSON.stringify(args),
  }));

  assert.equal(registry.has("echo"), true);
  assert.equal((await registry.execute("echo", { msg: "hi" })).ok, true);

  const missing = await registry.execute("missing", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.includes("not registered"), true);
});

test("file tools resolve relative paths from workspace root", async () => {
  const fixtureDir = resolve(WORKSPACE_ROOT, "tmp-tool-path-test");
  const rootFile = resolve(WORKSPACE_ROOT, "tmp-tool-path-test.txt");
  const runtimeFile = resolve(fixtureDir, "nested.txt");

  rmSync(rootFile, { force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(runtimeFile, "nested", "utf8");

  const writeResult = await executeTool("write_file", { path: "tmp-tool-path-test.txt", content: "root-data" });
  assert.equal(writeResult.ok, true);
  assert.equal(existsSync(rootFile), true);
  assert.equal(readFileSync(rootFile, "utf8"), "root-data");

  const readResult = await executeTool("read_file", { path: "tmp-tool-path-test/nested.txt" });
  assert.equal(readResult.ok, true);
  assert.equal(readResult.rawResult, "nested");

  const listResult = await executeTool("list_files", { path: "tmp-tool-path-test" });
  assert.equal(listResult.ok, true);
  assert.equal(listResult.rawResult.includes("nested.txt"), true);

  rmSync(rootFile, { force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("extended tools reject invalid arguments predictably", async () => {
  const missingQuery = await executeTool("web_search", {});
  assert.equal(missingQuery.ok, false);
  assert.equal(missingQuery.error, "query required");

  const missingUrl = await executeTool("url_fetch", {});
  assert.equal(missingUrl.ok, false);
  assert.equal(missingUrl.error, "url required");

  const unsupportedGit = await executeTool("git_command", { subcommand: "reset" });
  assert.equal(unsupportedGit.ok, false);
  assert.equal(unsupportedGit.error?.includes("Unsupported"), true);
});

test("web_search writes a real artifact path when results are returned", async () => {
  const originalTemplate = process.env.SEARCH_URL_TEMPLATE;
  process.env.SEARCH_URL_TEMPLATE = "data:application/json,{\"results\":[{\"title\":\"DeepSeek\",\"url\":\"https://www.deepseek.com/\",\"snippet\":\"preview\"}]}";

  try {
    const result = await executeTool("web_search", { query: "DeepSeek V4", count: 1 });
    assert.equal(result.ok, true);
    assert.equal(Boolean(result.artifact?.path), true);
    assert.equal(result.artifact?.path?.includes("runtime"), true);
  } finally {
    if (originalTemplate === undefined) {
      delete process.env.SEARCH_URL_TEMPLATE;
    } else {
      process.env.SEARCH_URL_TEMPLATE = originalTemplate;
    }
  }
});
