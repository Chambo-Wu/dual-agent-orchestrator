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
];

function safePath(inputPath: unknown): string {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new Error("path must be a non-empty string");
  }
  return resolve(RUNTIME_ROOT, inputPath);
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

export function executeTool(name: string, args: Record<string, unknown>): ToolExecutionResult {
  if (name === "read_file") {
    const path = safePath(args.path);
    const content = readFileSync(path, "utf8");
    return {
      ok: true,
      summary: `Read file ${path}`,
      artifact: { type: "file", path, content_preview: content.slice(0, 200) },
      rawResult: content,
    };
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
    if (ok && !combined.trim()) {
      return {
        ok: false,
        summary: `Command produced no output in ${cwd}; output saved to ${outputPath}`,
        artifact: { type: "file", path: outputPath, content_preview: "(no output)" },
        rawResult: combined,
        error: "Command completed with empty output",
      };
    }
    return {
      ok,
      summary: ok
        ? `Command succeeded in ${cwd}; full output saved to ${outputPath}`
        : `Command exited with status ${String(result.status)}; output saved to ${outputPath}`,
      artifact: { type: "file", path: outputPath, content_preview: combined.slice(0, 200) },
      rawResult: combined,
      error: ok ? undefined : stderr || `Exit status ${String(result.status)}`,
    };
  }

  return {
    ok: false,
    summary: `Unknown tool: ${name}`,
    rawResult: "",
    error: `Tool ${name} is not registered`,
  };
}
