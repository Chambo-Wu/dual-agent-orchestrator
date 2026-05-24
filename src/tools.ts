import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SearchConfig, ToolDefinition, ToolExecutionResult } from "./types.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT } from "./paths.js";
import { createSearchProvider } from "./search/providers.js";
import { mcpCallTool } from "./search/mcp-client.js";

let activeSearchConfig: SearchConfig | undefined;

export function configureSearchTools(config: SearchConfig | undefined): void {
  activeSearchConfig = config;
}

export function getActiveSearchProvider(): string {
  return activeSearchConfig?.provider || "bing_html (legacy)";
}

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
    description: "Run a shell command inside the current project workspace. Auto-detects PowerShell, cmd, or POSIX shell.",
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
  {
    name: "http_request",
    description: "Make an HTTP request (GET, POST, etc.) and return status + body.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["url"],
    },
  },
  {
    name: "extract_text",
    description: "Extract readable text from HTML or raw content.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        format: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "parse_json",
    description: "Parse JSON and optionally extract a value by dot-path (e.g. data.results.0.title).",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        path: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "parse_csv",
    description: "Parse CSV content into structured rows. First row is used as headers.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        delimiter: { type: "string" },
        max_rows: { type: "number" },
      },
      required: ["content"],
    },
  },
  {
    name: "summarize_artifact",
    description: "Read an artifact file and produce a truncated summary.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_chars: { type: "number" },
      },
      required: ["path"],
    },
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

  const html = body;
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Bing HTML: multiple patterns for different Bing layouts
  const bingPatterns = [
    // Standard: <li class="b_algo">...<a href="URL">TITLE</a>...<p>SNIPPET</p> or <span class="b_lineclamp">SNIPPET</span>
    new RegExp(
      '<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?(?:<p[^>]*>([\\s\\S]*?)</p>|<span[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\\s\\S]*?)</span>)',
      "gi"
    ),
    // With caption div
    new RegExp(
      '<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\\s\\S]*?(?:<p[^>]*>([\\s\\S]*?)</p>|<span[^>]*>([\\s\\S]*?)</span>)',
      "gi"
    ),
    // With cite element
    new RegExp(
      '<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?<cite[^>]*>([\\s\\S]*?)</cite>',
      "gi"
    ),
  ];

  for (const bingRe of bingPatterns) {
    for (const m of html.matchAll(bingRe)) {
      if (results.length >= count) break;
      const url = m[1] || "";
      const title = stripHtmlTags(m[2] || "");
      const snippet = stripHtmlTags(m[3] || m[4] || "");
      if (url && title && url.startsWith("http")) {
        results.push({ title, url, snippet });
      }
    }
    if (results.length > 0) return results;
  }

  // DuckDuckGo fallback
  const ddgRe = new RegExp(
    '<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)</a>',
    "gi"
  );
  const ddgSRe = new RegExp(
    '<(?:a|span)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\\s\\S]*?)</(?:a|span)>',
    "gi"
  );
  const ddgMatches = [...html.matchAll(ddgRe)];
  const ddgSnippets = [...html.matchAll(ddgSRe)].map((m) => stripHtmlTags(m[1] || ""));
  for (let i = 0; i < ddgMatches.length && results.length < count; i++) {
    const href = ddgMatches[i]?.[1] ?? "";
    const title = stripHtmlTags(ddgMatches[i]?.[2] ?? "");
    if (!href || !title) continue;
    results.push({ title, url: href.startsWith("//") ? `https:${href}` : href, snippet: ddgSnippets[i] ?? "" });
  }
  if (results.length > 0) return results;

  // Generic fallback: extract any <a> tags with http href
  const genericRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  for (const m of html.matchAll(genericRe)) {
    if (results.length >= count) break;
    const url = m[1] || "";
    const title = stripHtmlTags(m[2] || "");
    if (!url || !title || seen.has(url)) continue;
    if (title.length < 5 || /^(sign in|log in|register|home|about|contact|privacy|terms)$/i.test(title)) continue;
    seen.add(url);
    const afterLink = html.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const snippetMatch = afterLink.match(/<(?:p|span|div)[^>]*>([\s\S]*?)<\/(?:p|span|div)>/);
    const snippet = snippetMatch ? stripHtmlTags(snippetMatch[1] || "") : "";
    results.push({ title, url, snippet });
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

    let results: Array<{ title: string; url: string; snippet: string }> = [];
    let providerUsed = "legacy";

    // MCP provider path
    if (activeSearchConfig?.provider === "mcp") {
      const mcpConfig = activeSearchConfig.providers.mcp || {};
      const serverUrl = typeof mcpConfig.server_url === "string" ? mcpConfig.server_url : "http://127.0.0.1:3000";
      const toolName = typeof mcpConfig.tool_name === "string" ? mcpConfig.tool_name : "web_search";
      const mcpTimeout = typeof mcpConfig.timeout_ms === "number" ? mcpConfig.timeout_ms : 30000;
      try {
        results = await mcpCallTool(serverUrl, toolName, { query, count }, mcpTimeout);
        providerUsed = "mcp";
      } catch (err) {
        if (!activeSearchConfig.fallbackEnabled) {
          return { ok: false, summary: "MCP search failed", rawResult: "", error: err instanceof Error ? err.message : String(err) };
        }
        // fall through to legacy
      }
    }

    // Configured provider path (non-MCP)
    if (results.length === 0 && activeSearchConfig && activeSearchConfig.provider !== "mcp") {
      try {
        const provider = createSearchProvider(activeSearchConfig);
        const request = provider.buildRequest(query, count);
        const timeoutMs = activeSearchConfig.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
        const fetchResult = await fetchUrlText(request.url, timeoutMs);
        if (fetchResult.ok) {
          results = provider.parseResults(fetchResult.body, count);
          providerUsed = activeSearchConfig.provider;
        } else if (!activeSearchConfig.fallbackEnabled) {
          return { ok: false, summary: `Search failed (${activeSearchConfig.provider})`, rawResult: fetchResult.body, error: fetchResult.error || "search failed" };
        }
      } catch {
        // fall through to legacy
      }
    }

    // Legacy fallback (no config or fallback enabled)
    if (results.length === 0) {
      const searchUrl = buildWebSearchUrl(query);
      const fetchResult = await fetchUrlText(searchUrl, DEFAULT_COMMAND_TIMEOUT_MS);
      if (!fetchResult.ok) {
        return { ok: false, summary: `Web search failed for query: ${query}`, rawResult: fetchResult.body, error: fetchResult.error || "web search failed" };
      }
      results = parseSearchResults(fetchResult.body, count);
      providerUsed = "legacy";
    }

    const artifactPath = saveJsonArtifact("web-search", results);
    const raw = JSON.stringify(results, null, 2);
    if (results.length === 0) {
      return {
        ok: false,
        summary: `Web search returned no parsed results (${providerUsed}); raw output saved to ${artifactPath}`,
        artifact: { type: "json", path: artifactPath, content_preview: raw.slice(0, 200) },
        rawResult: raw,
        error: "No search results could be parsed from the fetched page.",
      };
    }
    return {
      ok: true,
      summary: `Found ${results.length} results (${providerUsed})`,
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

  if (name === "http_request") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return { ok: false, summary: "http_request requires url.", rawResult: "", error: "url required" };
    const method = typeof args.method === "string" ? args.method.trim().toUpperCase() : "GET";
    const headers = args.headers && typeof args.headers === "object" ? args.headers as Record<string, string> : undefined;
    const body = typeof args.body === "string" ? args.body : undefined;
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 15_000;
    try {
      const resp = await fetch(url, {
        method,
        headers: { "User-Agent": "dual-agent-orchestrator", ...headers },
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const respBody = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      const result = { status: resp.status, headers: respHeaders, body: respBody.slice(0, 32_000) };
      const raw = JSON.stringify(result, null, 2);
      const outPath = saveJsonArtifact("http-response", result);
      return {
        ok: resp.ok,
        summary: `HTTP ${method} ${url} -> ${resp.status}`,
        artifact: { type: "json", path: outPath, content_preview: raw.slice(0, 200) },
        rawResult: raw,
        error: resp.ok ? undefined : `HTTP ${resp.status}: ${resp.statusText}`,
      };
    } catch (e) {
      return { ok: false, summary: `HTTP ${method} ${url} failed`, rawResult: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (name === "extract_text") {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return { ok: false, summary: "extract_text requires content.", rawResult: "", error: "content required" };
    const format = typeof args.format === "string" ? args.format : "auto";
    let text = content;
    if (format === "html" || (format === "auto" && /<html|<body|<div/i.test(content.slice(0, 500)))) {
      text = content
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<\/h[1-6]>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .replace(/ \n/g, "\n")
        .trim();
    }
    return { ok: true, summary: `Extracted ${text.length} chars`, rawResult: text };
  }

  if (name === "parse_json") {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return { ok: false, summary: "parse_json requires content.", rawResult: "", error: "content required" };
    try {
      let value: unknown = JSON.parse(content);
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (path) {
        for (const segment of path.split(".")) {
          if (value == null || typeof value !== "object") {
            return { ok: false, summary: `Path segment "${segment}" not found.`, rawResult: "", error: `Cannot traverse "${segment}" on non-object` };
          }
          const idx = Number(segment);
          if (Number.isInteger(idx) && Array.isArray(value)) {
            value = (value as unknown[])[idx];
          } else {
            value = (value as Record<string, unknown>)[segment];
          }
        }
      }
      const raw = JSON.stringify(value, null, 2);
      return { ok: true, summary: `Parsed JSON${path ? ` at "${path}"` : ""}`, rawResult: raw };
    } catch (e) {
      return { ok: false, summary: "Invalid JSON", rawResult: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (name === "parse_csv") {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return { ok: false, summary: "parse_csv requires content.", rawResult: "", error: "content required" };
    const delimiter = typeof args.delimiter === "string" && args.delimiter ? args.delimiter : ",";
    const maxRows = typeof args.max_rows === "number" ? args.max_rows : 100;
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return { ok: false, summary: "Empty CSV", rawResult: "[]", error: "No rows found" };
    const headers = lines[0]!.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
      const cells = lines[i]!.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
      const row: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]!] = cells[j] ?? "";
      }
      rows.push(row);
    }
    const raw = JSON.stringify(rows, null, 2);
    return { ok: true, summary: `Parsed ${rows.length} rows with ${headers.length} columns`, rawResult: raw };
  }

  if (name === "summarize_artifact") {
    const path = safePath(args.path);
    const maxChars = typeof args.max_chars === "number" ? args.max_chars : 2000;
    try {
      const content = readFileSync(path, "utf8");
      const summary = content.slice(0, maxChars);
      return {
        ok: true,
        summary: `Read ${content.length} chars, summarized to ${summary.length}`,
        artifact: { type: "file", path, content_preview: summary.slice(0, 200) },
        rawResult: summary,
      };
    } catch (e) {
      return { ok: false, summary: `Failed to read: ${path}`, rawResult: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    ok: false,
    summary: `Unknown tool: ${name}`,
    rawResult: "",
    error: `Tool ${name} is not registered`,
  };
}
