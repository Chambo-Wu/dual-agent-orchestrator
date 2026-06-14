import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "./shared.js";

const DEFAULT_API_KEY = "dual-agent-local";

export function getServerApiKey(): string {
	return process.env.DUAL_AGENT_API_KEY?.trim() || process.env.API_KEY?.trim() || DEFAULT_API_KEY;
}

export function getHeaderValue(req: IncomingMessage, name: string): string {
	const raw = req.headers[name.toLowerCase()];
	if (Array.isArray(raw)) {
		return raw[0] ?? "";
	}
	return raw ?? "";
}

export function isAuthorized(req: IncomingMessage): boolean {
	const expectedKey = getServerApiKey();
	const authHeader = getHeaderValue(req, "authorization");
	const xApiKey = getHeaderValue(req, "x-api-key");
	const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
	return bearer === expectedKey || xApiKey.trim() === expectedKey;
}

export function unauthorizedResponse(res: ServerResponse): void {
	jsonResponse(res, 401, {
		error: {
			message: "Unauthorized. Provide Authorization: Bearer <api_key> or X-API-Key.",
			type: "authentication_error",
		},
	});
}
