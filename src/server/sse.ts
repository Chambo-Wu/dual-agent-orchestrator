import type { ServerResponse } from "node:http";

export function sseWrite(res: ServerResponse, payload: string): void {
	res.write(`data: ${payload}\n\n`);
}

export function sseWriteEvent(res: ServerResponse, eventName: string, payload: string, eventId?: number): void {
	if (eventId !== undefined) {
		res.write(`id: ${eventId}\n`);
	}
	res.write(`event: ${eventName}\n`);
	sseWrite(res, payload);
}
