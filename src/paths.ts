import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_ROOT = resolve(PROJECT_ROOT, "runtime");
export const WORKSPACE_ROOT = PROJECT_ROOT;
