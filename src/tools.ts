import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolDefinition, ToolExecutionResult } from "./types.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT } from "./paths.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const POWERSHELL_CANDIDATES = [
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "pwsh.exe",
];
const CMD_CANDIDATES = [
  "C:\\Windows\\System32\\cmd.exe",
  "cmd.exe",
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a local UTF-8 text file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write UTF-8 text into a local file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in a local directory.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "shell_command",
    description: "Run a PowerShell command inside the current project workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "web_search",
    description: "Search the web. Returns titles, URLs, and snippets.",
    parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] },
  },
  {
    name: "url_fetch",
    description: "Fetch a URL and extract text content.",
    parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "number" } }, required: ["url"] },
  },
  {
    name: "git_command",
    description: "Run a read-only git command. Supports: status, diff, log, show, blame.",
    parameters: { type: "object", properties: { subcommand: { type: "string" }, args: { type: "string" } }, required: ["subcommand"] },
  },
];

function safePath(inputPath: unknown): string {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new Error("path must be a non-empty string");
  }
  return resolve(WORKSPACE_ROOT, inputPath);
}

function safeWorkspacePath(inputPath: unknown): string {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    return WORKSPACE_ROOT;
  }
  return resolve(WORKSPACE_ROOT, inputPath);
}

function runPowerShellCommand(command: string, cwd: string, timeoutMs: number) {
  let lastResult: ReturnType<typeof spawnSync> | null = null;
  for (const executable of POWERSHELL_CANDIDATES) {
    const normalizedCommand = normalizePotentiallyInteractiveWebCmd(command);
    const wrappedCommand = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${normalizedCommand}`;
    const result = spawnSync(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrappedCommand],
      { cwd, encoding: "utf8", timeout: timeoutMs, shell: false }
    );
    lastResult = result;
    if (!result.error || !/EPERM|ENOENT/i.test(result.error.message)) {
      return result;
    }
  }
  return lastResult?.error ? null : lastResult;
}

function normalizePotentiallyInteractiveWebCmd(command: string): string {
  let normalized = command;
  normalized = normalized.replace(/\bcurl(?=\s)/gi, "curl.exe");
  normalized = normalized.replace(/\bInvoke-WebRequest\b(?![^|;\r\n]*-UseBasicParsing)/gi, "Invoke-WebRequest -UseBasicParsing");
  normalized = normalized.replace(/\bInvoke-RestMethod\b(?![^|;\r\n]*-UseBasicParsing)/gi, "Invoke-RestMethod -UseBasicParsing");
  normalized = normalized.replace(/\|\s*Format-Table\b[^|;\r\n]*/gi, "| Out-String -Width 4096");
  return normalized;
}

function prefersPowerShell(command: string): boolean {
  return /\b(ConvertFrom-Json|ConvertTo-Json|Invoke-WebRequest|Invoke-RestMethod|Select-Object|Out-File|Get-ChildItem|ForEach-Object)\b/i.test(command)
    || /\$\w+/.test(command)
    || /@\{/.test(command);
}

function saveShellOutput(output: string): string {
  const dir = resolve(RUNTIME_ROOT, "command-results");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trimmed = output.trim();
  const extension = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "txt";
  const path = resolve(dir, `${timestamp}-${Math.random().toString(36).slice(2, 8)}.${extension}`);
  writeFileSync(path, output, "utf8");
  return path;
}

function saveJsonArtifact(prefix: string, payload: unknown): string {
  const dir = resolve(RUNTIME_ROOT, "command-results");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(dir, `${timestamp}-${prefix}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

function runCmdCommand(command: string, cwd: string, timeoutMs: number) {
  let lastResult: ReturnType<typeof spawnSync> | null = null;
  for (const executable of CMD_CANDIDATES) {
    const wrappedCommand = `chcp 65001>nul & ${command}`;
    const result = spawnSync(
      executable,
      ["/d", "/s", "/c", wrappedCommand],
      { cwd, encoding: "utf8", timeout: timeoutMs, shell: false }
    );
    lastResult = result;
    if (!result.error || !/EPERM|ENOENT/i.test(result.error.message)) {
      return result;
    }
  }
  return lastResult;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

async function fetchUrlText(url: string, timeoutMs: number): Promise<{ ok: boolean; body: string; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!resp.ok) {
      return { ok: false, body: "", error: `HTTP ${resp.status}: ${resp.statusText}` };
    }
    const body = await resp.text();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, body: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function buildWebSearchUrl(query: string): string {
  const template = process.env.SEARCH_URL_TEMPLATE || "";
  if (template) {
    return template.replace("{query}", encodeURIComponent(query));
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

function parseSearchResults(body: string, count: number): Array<{ title: string; url: string; snippet: string }> {
  const trimmed = body.trim();
  // JSON API response
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed);
      if (data.web?.results) {
        return (data.web.results || []).slice(0, count).map((r: any) => ({
          title: r.title || "", url: r.url || "", snippet: r.description || "",
        }));
      }
      if (Array.isArray(data)) {
        return data.slice(0, count).map((r: any) => ({
          title: r.title || "", url: r.url || "", snippet: r.snippet || r.description || "",
        }));
      }
      if (Array.isArray(data.results)) {
        return data.results.slice(0, count).map((r: any) => ({
          title: r.title || "", url: r.url || "", snippet: r.snippet || r.description || "",
        }));
      }
    } catch { /* fall through */ }
  }

  // Bing HTML: <li class="b_algo"><h2><a href="URL">TITLE</a></h2><p>SNIPPET</p>
  const html = body;
  const bingResults: Array<{ title: string; url: string; snippet: string }> = [];
  // Use RegExp constructor to avoid regex literal escaping issues
  const bingRe = new RegExp(
    '<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?(?:<p[^>]*>([\\s\\S]*?)</p>)?',
    "gi"
  );
  for (const m of html.matchAll(bingRe)) {
    if (bingResults.length >= count) break;
    const url = m[1] || "";
    const title = stripHtmlTags(m[2] || "");
    const snippet = stripHtmlTags(m[3] || "");
    if (url && title && url.startsWith("http")) {
      bingResults.push({ title, url, snippet });
    }
  }
  if (bingResults.length > 0) return bingResults;

  // DuckDuckGo fallback
  const ddgRe = new RegExp(
    '<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)</a>',
    "gi"
  );
  const ddgSRe = new RegExp(
    '<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\\s\\S]*?)</a>',
    "gi"
  );
  const ddgMatches = [...html.matchAll(ddgRe)];
  const ddgSnippets = [...html.matchAll(ddgSRe)].map((m) => stripHtmlTags(m[1] || ""));
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (let i = 0; i < ddgMatches.length && results.length < count; i++) {
    const href = ddgMatches[i]?.[1] ?? "";
    const title = stripHtmlTags(ddgMatches[i]?.[2] ?? "");
    if (!href || !title) continue;
    results.push({ title, url: href.startsWith("//") ? `https:${href}` : href, snippet: ddgSnippets[i] ?? "" });
  }
  return results;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  if (name === "read_file") {
    const path = safePath(args.path);
    try {
      const content = readFileSync(path, "utf8");
      return {
        ok: true,
        summary: `Read file ${path}`,
        artifact: { type: "file", path, content_preview: content.slice(0, 200) },
        rawResult: content,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, summary: `Failed to read: ${path}`, rawResult: "", error: msg };
    }
  }

  if (name === "write_file") {
    const path = safePath(args.path);
    const content = typeof args.content === "string" ? args.content : "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return {
      ok: true,
      summary: `Wrote file ${path}`,
      artifact: { type: "file", path, content_preview: content.slice(0, 200) },
      rawResult: content,
    };
  }

  if (name === "list_files") {
    const path = safePath(args.path);
    const entries = readdirSync(path, { withFileTypes: true }).map((entry) => entry.name);
    return {
      ok: true,
      summary: `Listed ${entries.length} entries in ${path}`,
      artifact: { type: "json", path, content_preview: JSON.stringify(entries).slice(0, 200) },
      rawResult: JSON.stringify(entries, null, 2),
    };
  }

  if (name === "shell_command") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) {
      return {
        ok: false,
        summary: "shell_command requires a non-empty command string.",
        rawResult: "",
        error: "command must be a non-empty string",
      };
    }

    const cwd = safeWorkspacePath(args.cwd);
    const timeoutMs = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms)
      ? Math.max(1_000, Math.floor(args.timeout_ms))
      : DEFAULT_COMMAND_TIMEOUT_MS;

    const normalizedCommand = normalizePotentiallyInteractiveWebCmd(command);
    const result = prefersPowerShell(normalizedCommand)
      ? (runPowerShellCommand(normalizedCommand, cwd, timeoutMs) ?? runCmdCommand(normalizedCommand, cwd, timeoutMs))
      : (runCmdCommand(normalizedCommand, cwd, timeoutMs) ?? runPowerShellCommand(normalizedCommand, cwd, timeoutMs));
    if (!result) {
      return {
        ok: false,
        summary: `Command failed in ${cwd}`,
        rawResult: "",
        error: "Unable to launch PowerShell.",
      };
    }

    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const outputPath = saveShellOutput(combined || "(no output)");

    if (result.error) {
      return {
        ok: false,
        summary: `Command failed in ${cwd}; output saved to ${outputPath}`,
        artifact: { type: "file", path: outputPath, content_preview: combined.slice(0, 200) },
        rawResult: combined,
        error: result.error.message,
      };
    }

    const ok = result.status === 0;
    return {
      ok,
      summary: ok
        ? `Command succeeded in ${cwd}; full output saved to ${outputPath}`
        : `Command exited with status ${String(result.status)}; output saved to ${outputPath}`,
      artifact: { type: "file", path: outputPath, content_preview: (combined || "(no output)").slice(0, 200) },
      rawResult: combined,
      error: ok ? undefined : stderr || `Exit status ${String(result.status)}`,
    };
  }

  if (name === "web_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { ok: false, summary: "web_search requires query.", rawResult: "", error: "query required" };
    const count = Math.min(Math.max(typeof args.count === "number" ? args.count : 5, 1), 10);
    const searchUrl = buildWebSearchUrl(query);
    const fetchResult = await fetchUrlText(searchUrl, DEFAULT_COMMAND_TIMEOUT_MS);
    if (!fetchResult.ok) {
      return {
        ok: false,
        summary: `Web search failed for query: ${query}`,
        rawResult: fetchResult.body,
        error: fetchResult.error || "web search failed",
      };
    }
    const results = parseSearchResults(fetchResult.body, count);
    const artifactPath = saveJsonArtifact("web-search", results);
    const raw = JSON.stringify(results, null, 2);
    if (results.length === 0) {
      return {
        ok: false,
        summary: `Web search returned no parsed results; raw output saved to ${artifactPath}`,
        artifact: { type: "json", path: artifactPath, content_preview: raw.slice(0, 200) },
        rawResult: raw,
        error: "No search results could be parsed from the fetched page.",
      };
    }
    return {
      ok: true,
      summary: `Found ${results.length} results`,
      artifact: { type: "json", path: artifactPath, content_preview: raw.slice(0, 200) },
      rawResult: raw,
    };
  }

  if (name === "url_fetch") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return { ok: false, summary: "url_fetch requires url.", rawResult: "", error: "url required" };
    const maxChars = typeof args.max_chars === "number" ? args.max_chars : 8000;
    const fetchResult = await fetchUrlText(url, 15000);
    if (!fetchResult.ok) return { ok: false, summary: "Fetch failed", rawResult: "", error: fetchResult.error };
    let text = fetchResult.body;
    if (/<html|<body/i.test(text.slice(0, 500))) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    }
    const trunc = text.slice(0, maxChars);
    const outPath = saveShellOutput(trunc);
    return { ok: true, summary: `Fetched ${url} (${text.length} chars)`, artifact: { type: "file", path: outPath, content_preview: trunc.slice(0, 200) }, rawResult: trunc };
  }

  if (name === "git_command") {
    const sub = typeof args.subcommand === "string" ? args.subcommand.trim() : "";
    const allowed = ["status", "diff", "log", "show", "blame"];
    if (!allowed.includes(sub)) return { ok: false, summary: "git supports: " + allowed.join(", "), rawResult: "", error: "Unsupported: " + sub };
    const extra = typeof args.args === "string" ? args.args : "";
    const gitArgs = sub === "log" ? [sub, "--oneline", "-20", ...extra.split(" ").filter(Boolean)] : [sub, ...extra.split(" ").filter(Boolean)];
    const result = spawnSync("git", gitArgs, { cwd: WORKSPACE_ROOT, encoding: "utf8", timeout: 10000 });
    const output = ((result.stdout || "") + (result.stderr || "")).trim();
    const ok = result.status === 0;
    return { ok, summary: ok ? `git ${sub} ok` : `git ${sub} failed`, rawResult: output, error: ok ? undefined : (result.stderr || "").trim() };
  }

  return {
    ok: false,
    summary: `Unknown tool: ${name}`,
    rawResult: "",
    error: `Tool ${name} is not registered`,
  };
}
