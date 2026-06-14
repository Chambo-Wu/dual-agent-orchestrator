import type { ServerResponse } from "node:http";
import { classifyFailure } from "./failure-classification.js";
import { responseAlreadyStarted } from "./server/shared.js";

const PLANNER_FAILURE_THRESHOLD = 3;
const PLANNER_COOLDOWN_MS = 60_000;

type PlannerCircuitState = {
	consecutiveFailures: number;
	openUntil: number;
	lastFailureAt: number;
	lastFailureMessage: string;
};

export const plannerCircuit: PlannerCircuitState = {
	consecutiveFailures: 0,
	openUntil: 0,
	lastFailureAt: 0,
	lastFailureMessage: "",
};

export class ServiceUnavailableError extends Error {
	readonly retryAfterSeconds: number;

	constructor(message: string, retryAfterSeconds: number) {
		super(message);
		this.name = "ServiceUnavailableError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

function secondsUntilCircuitHalfOpen(): number {
	return Math.max(1, Math.ceil((plannerCircuit.openUntil - Date.now()) / 1000));
}

export function getPlannerCircuitRetryAfterSeconds(): number {
	return secondsUntilCircuitHalfOpen();
}

export function isPlannerCircuitOpen(): boolean {
	return plannerCircuit.openUntil > Date.now();
}

export function assertPlannerCircuitClosed(): void {
	if (isPlannerCircuitOpen()) {
		throw new ServiceUnavailableError("Planner is temporarily unavailable after repeated upstream failures.", secondsUntilCircuitHalfOpen());
	}
}

export function markPlannerSuccess(): void {
	plannerCircuit.consecutiveFailures = 0;
	plannerCircuit.openUntil = 0;
	plannerCircuit.lastFailureAt = 0;
	plannerCircuit.lastFailureMessage = "";
}

export function markPlannerFailure(message: string): ServiceUnavailableError {
	plannerCircuit.consecutiveFailures += 1;
	plannerCircuit.lastFailureAt = Date.now();
	plannerCircuit.lastFailureMessage = message;

	if (plannerCircuit.consecutiveFailures >= PLANNER_FAILURE_THRESHOLD) {
		plannerCircuit.openUntil = Date.now() + PLANNER_COOLDOWN_MS;
	}

	return new ServiceUnavailableError(
		plannerCircuit.openUntil > Date.now()
			? "Planner is temporarily unavailable after repeated upstream failures."
			: "Planner request failed. Please retry shortly.",
		plannerCircuit.openUntil > Date.now() ? secondsUntilCircuitHalfOpen() : 5,
	);
}

export function serviceUnavailableResponse(res: ServerResponse, message: string, retryAfterSeconds: number): void {
	if (responseAlreadyStarted(res)) {
		return;
	}
	res.statusCode = 503;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Retry-After", String(retryAfterSeconds));
	res.end(
		JSON.stringify({
			error: {
				message,
				type: "service_unavailable",
				failure_category: classifyFailure({
					type: "service_unavailable",
					status: "failed",
					error: message,
					summary: message,
				}),
				retry_after: retryAfterSeconds,
			},
		}),
	);
}
