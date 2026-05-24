import type { SearchResult } from "../types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let nextId = 1;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextId++, method, params };
}

async function sendJsonRpc(url: string, request: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}: ${resp.statusText}`);
  return await resp.json() as JsonRpcResponse;
}

let initialized = false;

export async function mcpInitialize(serverUrl: string, timeoutMs: number): Promise<void> {
  if (initialized) return;
  const req = makeRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dual-agent-orchestrator", version: "0.1.0" },
  });
  const resp = await sendJsonRpc(serverUrl, req, timeoutMs);
  if (resp.error) throw new Error(`MCP initialize failed: ${resp.error.message}`);
  // Send initialized notification
  await sendJsonRpc(serverUrl, makeRequest("notifications/initialized", {}), timeoutMs);
  initialized = true;
}

export async function mcpCallTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<SearchResult[]> {
  await mcpInitialize(serverUrl, timeoutMs);
  const req = makeRequest("tools/call", { name: toolName, arguments: args });
  const resp = await sendJsonRpc(serverUrl, req, timeoutMs);
  if (resp.error) throw new Error(`MCP tool call failed: ${resp.error.message}`);
  return normalizeMcpResponse(resp.result);
}

function normalizeMcpResponse(result: unknown): SearchResult[] {
  if (!result || typeof result !== "object") return [];
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
      const text = String((item as Record<string, unknown>).text || "");
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map((r: Record<string, unknown>) => ({
            title: String(r.title || ""),
            url: String(r.url || ""),
            snippet: String(r.snippet || r.description || ""),
          }));
        }
      } catch { /* not JSON, skip */ }
    }
  }
  return [];
}

export function resetMcpState(): void {
  initialized = false;
}
