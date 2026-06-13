import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_ROOT = resolve(process.env.DUAL_AGENT_RUNTIME_ROOT?.trim() || resolve(PROJECT_ROOT, "runtime"));
export const ARTIFACTS_ROOT = resolve(RUNTIME_ROOT, "artifacts");
export const WORKSPACE_ROOT = PROJECT_ROOT;

export function resolveWorkspacePath(pathText: string): string {
  return isAbsolute(pathText) ? resolve(pathText) : resolve(PROJECT_ROOT, pathText);
}

export function resolveRuntimeAwarePath(pathText: string): string {
  if (isAbsolute(pathText)) {
    return resolve(pathText);
  }
  const normalized = pathText.replace(/\\/g, "/");
  if (normalized === "runtime") {
    return RUNTIME_ROOT;
  }
  if (normalized.startsWith("runtime/")) {
    return resolve(RUNTIME_ROOT, normalized.slice("runtime/".length));
  }
  return resolve(PROJECT_ROOT, pathText);
}

export function toRuntimeAwareRelativePath(pathText: string): string {
  const resolved = resolve(pathText);
  const fromRuntime = relative(RUNTIME_ROOT, resolved).replace(/\\/g, "/");
  return fromRuntime && !fromRuntime.startsWith("../") && fromRuntime !== ".."
    ? `runtime/${fromRuntime}`
    : relative(PROJECT_ROOT, resolved).replace(/\\/g, "/");
}

export function ensureRuntimeDirectories(): void {
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  mkdirSync(ARTIFACTS_ROOT, { recursive: true });
}
