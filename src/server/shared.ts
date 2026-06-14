import { type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig } from "../config.js";
import type { OrchestratorConfig } from "../types.js";
import { classifyFailure } from "../failure-classification.js";
import { WORKSPACE_ROOT } from "../paths.js";

let configOverrideForTests: OrchestratorConfig | null = null;

export function getRuntimeConfig(): OrchestratorConfig {
  return configOverrideForTests ?? loadConfig();
}

export function setConfigOverrideForTests(config: OrchestratorConfig | null): void {
  if (!config) {
    configOverrideForTests = null;
    return;
  }

  const normalizedConfig = structuredClone(config);
  if (isAbsolute(normalizedConfig.skills.builtinDir)) {
    const relativeBuiltinDir = relative(WORKSPACE_ROOT, resolve(normalizedConfig.skills.builtinDir)).replace(/\\/g, "/");
    if (relativeBuiltinDir && !relativeBuiltinDir.startsWith("../") && relativeBuiltinDir !== "..") {
      normalizedConfig.skills.builtinDir = relativeBuiltinDir;
    }
  }
  configOverrideForTests = normalizedConfig;
}

export function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (responseAlreadyStarted(res)) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function responseAlreadyStarted(res: ServerResponse): boolean {
  const state = res as ServerResponse & { headersSent?: boolean; writableEnded?: boolean };
  return state.headersSent === true || state.writableEnded === true;
}

export function jsonErrorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  classification?: {
    status?: string;
    error?: string;
    summary?: string;
  },
  extras?: Record<string, unknown>,
): void {
  jsonResponse(res, statusCode, {
    error: {
      message,
      type,
      failure_category: classifyFailure({
        type,
        status: classification?.status,
        error: classification?.error ?? message,
        summary: classification?.summary ?? message,
      }),
      ...(extras ?? {}),
    },
  });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

export function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let raw = "";
    let totalBytes = 0;
    const decoder = new TextDecoder();
    req.on("data", (chunk) => {
      const str = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      totalBytes += Buffer.byteLength(str);
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds maximum size of 10MB."));
        return;
      }
      raw += str;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(new Error("Invalid JSON in request body."));
      }
    });
    req.on("error", reject);
  });
}
