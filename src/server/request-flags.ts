import type { IncomingMessage } from "node:http";
import { getHeaderValue } from "./auth.js";

function isTruthyFlag(value: string | undefined): boolean {
	return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export function shouldIncludeWorkflowEvents(req: IncomingMessage, requested?: boolean): boolean {
	if (requested === true) {
		return true;
	}
	return isTruthyFlag(getHeaderValue(req, "x-dual-agent-workflow-events")) || isTruthyFlag(getHeaderValue(req, "x-workflow-events"));
}

export function shouldMirrorProgressToContent(requested?: boolean): boolean {
	return requested !== false;
}
