import type { WorkflowUiEvent } from "../workflow-ui-events.js";

export function parseNonNegativeIntegerParam(
	value: string | null | undefined,
	name: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
	if (value === null || value === undefined || value === "") {
		return { ok: true, value: undefined };
	}
	if (!/^\d+$/.test(value)) {
		return { ok: false, message: `${name} must be a non-negative integer.` };
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return { ok: false, message: `${name} must be a non-negative integer.` };
	}
	return { ok: true, value: parsed };
}

export type JobEventQuery = {
	type?: string;
	status?: string;
	agent?: string;
	phase?: string;
	taskRunId?: string;
};

export function readJobEventQuery(url: URL): JobEventQuery {
	const read = (name: string): string | undefined => {
		const value = url.searchParams.get(name)?.trim();
		return value ? value : undefined;
	};
	return {
		type: read("type"),
		status: read("status"),
		agent: read("agent"),
		phase: read("phase"),
		taskRunId: read("task_run_id") ?? read("taskRunId"),
	};
}

export function parseStringSetParam(url: URL, name: string): Set<string> {
	const values = url.searchParams
		.getAll(name)
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return new Set(values);
}

export function filterJobEvents(
	events: WorkflowUiEvent[],
	filters: {
		types?: Set<string>;
		statuses?: Set<string>;
		agents?: Set<string>;
		phases?: Set<string>;
		taskRunIds?: Set<string>;
		seq?: number;
		sinceSeq?: number;
	},
): WorkflowUiEvent[] {
	return events.filter((event) => {
		if (Number.isFinite(filters.sinceSeq) && event.seq <= (filters.sinceSeq as number)) {
			return false;
		}
		if (Number.isFinite(filters.seq) && event.seq !== filters.seq) {
			return false;
		}
		if (filters.types && filters.types.size > 0 && !filters.types.has(event.type)) {
			return false;
		}
		if (filters.statuses && filters.statuses.size > 0 && !filters.statuses.has(event.status)) {
			return false;
		}
		if (filters.agents && filters.agents.size > 0 && !filters.agents.has(event.agent)) {
			return false;
		}
		if (filters.phases && filters.phases.size > 0 && !filters.phases.has(event.phase)) {
			return false;
		}
		if (filters.taskRunIds && filters.taskRunIds.size > 0 && (!event.taskRunId || !filters.taskRunIds.has(event.taskRunId))) {
			return false;
		}
		return true;
	});
}
