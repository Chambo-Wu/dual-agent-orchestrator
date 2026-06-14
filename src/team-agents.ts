import type { TeamAgent } from "./team.js";
import type { OrchestratorConfig } from "./types.js";

function parseTeamAgentsEnv(value: string | undefined): TeamAgent[] {
	const raw = value?.trim();
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed
					.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof item.name === "string")
					.map((item) => ({ name: item.name as string, role: typeof item.role === "string" ? item.role : undefined }))
			: [];
	} catch {
		return [];
	}
}

function teamAgentsFromRegistry(config: OrchestratorConfig): TeamAgent[] {
	return Object.values(config.agents ?? {}).map((agent) => ({
		name: agent.id,
		role: agent.role,
	}));
}

export function resolveRegisteredRoleAgent(config: OrchestratorConfig | undefined, roleName: string): { id: string; role: string; model: string } | undefined {
	if (!config?.agents) {
		return undefined;
	}
	const normalizedRole = roleName.toLowerCase();
	const agent = Object.values(config.agents).find((candidate) => {
		const id = candidate.id.toLowerCase();
		const role = candidate.role.toLowerCase();
		return id === normalizedRole || role === normalizedRole || role.includes(normalizedRole);
	});
	return agent ? { id: agent.id, role: agent.role, model: agent.model.model } : undefined;
}

export function resolveTeamAgents(config: OrchestratorConfig, envValue = process.env.TEAM_AGENTS): TeamAgent[] {
	const envAgents = parseTeamAgentsEnv(envValue);
	if (envAgents.length > 0) {
		return envAgents;
	}
	const registeredAgents = teamAgentsFromRegistry(config);
	if (registeredAgents.length > 0) {
		return registeredAgents;
	}
	return [
		{ name: "planner", role: "planning and coordination" },
		{ name: "executor", role: "task execution" },
	];
}
