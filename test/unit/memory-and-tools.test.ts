import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SharedMemory } from "../../src/memory/shared.js";
import { ToolRegistry } from "../../src/tool/registry.js";
import { executeTool, resetSearchCache } from "../../src/tools.js";
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

test("read_file rejects directory paths instead of reading them like files", async () => {
  const fixtureDir = resolve(WORKSPACE_ROOT, "tmp-tool-dir-read-test");
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });

  const readResult = await executeTool("read_file", { path: "tmp-tool-dir-read-test" });
  assert.equal(readResult.ok, false);
  assert.equal(readResult.error?.includes("not a readable file"), true);

  rmSync(fixtureDir, { recursive: true, force: true });
});

test("list_files returns structured failure for missing or non-directory paths", async () => {
  const missingResult = await executeTool("list_files", { path: "tmp-tool-missing-dir-test" });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.summary.includes("Failed to list"), true);

  const filePath = resolve(WORKSPACE_ROOT, "tmp-tool-list-file-test.txt");
  rmSync(filePath, { force: true });
  writeFileSync(filePath, "not a directory", "utf8");
  try {
    const fileResult = await executeTool("list_files", { path: "tmp-tool-list-file-test.txt" });
    assert.equal(fileResult.ok, false);
    assert.equal(fileResult.error?.includes("not a readable directory"), true);
  } finally {
    rmSync(filePath, { force: true });
  }
});

test("shell_command routes common PowerShell cmdlets to PowerShell on Windows", { skip: process.platform !== "win32" }, async () => {
  const fixtureDir = resolve(WORKSPACE_ROOT, "tmp-tool-powershell-shell-test");
  rmSync(fixtureDir, { recursive: true, force: true });
  try {
    const result = await executeTool("shell_command", {
      command: "New-Item -ItemType Directory -Force -Path tmp-tool-powershell-shell-test | Out-Null; Set-Content -Path tmp-tool-powershell-shell-test/out.txt -Value ok",
    });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(resolve(fixtureDir, "out.txt"), "utf8").trim(), "ok");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("extended tools reject invalid arguments predictably", async () => {
  resetSearchCache();
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
  resetSearchCache();
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

test("web_search parses current Bing-style result blocks with useful snippets", async () => {
  resetSearchCache();
  const originalTemplate = process.env.SEARCH_URL_TEMPLATE;
  const html = [
    '<html><body><ol id="b_results">',
    '<li class="b_algo"><h2><a target="_blank" href="https://example.com/report">Example Report</a></h2>',
    '<div class="b_caption"><p>Independent benchmark evidence with enough context for a grounded answer.</p></div></li>',
    '</ol></body></html>',
  ].join("");
  process.env.SEARCH_URL_TEMPLATE = `data:text/html,${encodeURIComponent(html)}`;

  try {
    const result = await executeTool("web_search", { query: "example benchmark", count: 1 });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.rawResult) as Array<{ title: string; url: string; snippet: string }>;
    assert.equal(parsed[0]?.title, "Example Report");
    assert.equal(parsed[0]?.url, "https://example.com/report");
    assert.equal(parsed[0]?.snippet.includes("benchmark evidence"), true);
  } finally {
    if (originalTemplate === undefined) {
      delete process.env.SEARCH_URL_TEMPLATE;
    } else {
      process.env.SEARCH_URL_TEMPLATE = originalTemplate;
    }
  }
});
