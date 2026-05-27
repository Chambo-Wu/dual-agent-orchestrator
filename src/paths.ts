import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_ROOT = resolve(PROJECT_ROOT, "runtime");
export const ARTIFACTS_ROOT = resolve(RUNTIME_ROOT, "artifacts");
export const WORKSPACE_ROOT = PROJECT_ROOT;

export function ensureRuntimeDirectories(): void {
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  mkdirSync(ARTIFACTS_ROOT, { recursive: true });
}
