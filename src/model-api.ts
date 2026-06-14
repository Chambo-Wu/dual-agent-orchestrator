import { loadConfig, materializeRuntimeModelSelection } from "./config.js";
import type { OrchestratorConfig } from "./types.js";

const OPENAI_MODEL_ID = "dual-agent-orchestrator";

export interface ExposedModel {
	id: string;
	object: "model";
	owned_by: string;
	planner_model?: string;
	executor_model?: string;
	planner_base_url?: string;
	planner_api_key?: string;
	executor_base_url?: string;
	executor_api_key?: string;
	description?: string;
}

function getDefaultExposedModel(config: OrchestratorConfig): ExposedModel {
	return {
		id: OPENAI_MODEL_ID,
		object: "model",
		owned_by: "dual-agent-orchestrator",
		planner_model: config.planner.model,
		executor_model: config.executor.model,
		description: "Default dual-agent planner/executor route.",
	};
}

export function getExposedModels(config: OrchestratorConfig): ExposedModel[] {
	const raw = process.env.DUAL_AGENT_MODELS?.trim();
	if (!raw) {
		return [getDefaultExposedModel(config)];
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [getDefaultExposedModel(config)];
		}

		const models = parsed.flatMap((item): ExposedModel[] => {
			if (!item || typeof item !== "object") {
				return [];
			}

			const candidate = item as Record<string, unknown>;
			const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
			if (!id) {
				return [];
			}

			return [
				{
					id,
					object: "model",
					owned_by: typeof candidate.owned_by === "string" && candidate.owned_by.trim() ? candidate.owned_by : "dual-agent-orchestrator",
					planner_model: typeof candidate.planner_model === "string" ? candidate.planner_model : undefined,
					executor_model: typeof candidate.executor_model === "string" ? candidate.executor_model : undefined,
					planner_base_url: typeof candidate.planner_base_url === "string" ? candidate.planner_base_url : undefined,
					planner_api_key: typeof candidate.planner_api_key === "string" ? candidate.planner_api_key : undefined,
					executor_base_url: typeof candidate.executor_base_url === "string" ? candidate.executor_base_url : undefined,
					executor_api_key: typeof candidate.executor_api_key === "string" ? candidate.executor_api_key : undefined,
					description: typeof candidate.description === "string" ? candidate.description : undefined,
				},
			];
		});

		return models.length > 0 ? models : [getDefaultExposedModel(config)];
	} catch {
		return [getDefaultExposedModel(config)];
	}
}

export function resolveRequestedModel(
	config: OrchestratorConfig,
	requestedModel: string | undefined,
): { exposed: ExposedModel; resolvedConfig: OrchestratorConfig } {
	const exposedModels = getExposedModels(config);
	const exposed = exposedModels.find((item) => item.id === requestedModel) || exposedModels[0]!;
	const resolvedPlanner = {
		...config.planner,
		model: exposed.planner_model || config.planner.model,
		baseUrl: exposed.planner_base_url || config.planner.baseUrl,
		apiKey: exposed.planner_api_key || config.planner.apiKey,
	};
	const resolvedExecutor = {
		...config.executor,
		model: exposed.executor_model || config.executor.model,
		baseUrl: exposed.executor_base_url || config.executor.baseUrl,
		apiKey: exposed.executor_api_key || config.executor.apiKey,
	};

	return {
		exposed,
		resolvedConfig: materializeRuntimeModelSelection({
			...config,
			planner: {
				...resolvedPlanner,
			},
			executor: {
				...resolvedExecutor,
			},
			modelRegistry: {
				...config.modelRegistry,
				"planner.default": {
					...(config.modelRegistry["planner.default"] ?? {
						id: "planner.default",
						role: "planner",
						enabled: true,
						model: resolvedPlanner,
					}),
					model: resolvedPlanner,
				},
				"executor.default": {
					...(config.modelRegistry["executor.default"] ?? {
						id: "executor.default",
						role: "executor",
						enabled: true,
						model: resolvedExecutor,
					}),
					model: resolvedExecutor,
				},
			},
			policy: { ...config.policy },
		}),
	};
}

export function buildModelsResponse(config = loadConfig()): unknown {
	return {
		object: "list",
		data: getExposedModels(config).map((model) => ({
			id: model.id,
			object: "model",
			created: Math.floor(Date.now() / 1000),
			owned_by: model.owned_by,
			metadata: {
				planner_model: model.planner_model || config.planner.model,
				executor_model: model.executor_model || config.executor.model,
				executor_candidates: config.modelRouting.executorCandidates,
				description: model.description || "",
			},
		})),
	};
}
