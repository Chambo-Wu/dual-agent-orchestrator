import { runChatCompletionDetailed, UpstreamServiceError, type ChatMessage } from "./providers/openai-compatible.js";
import { getRoutedModels, materializeRuntimeModelSelection } from "./config.js";
import type { ModelResponse, OrchestratorConfig, RegisteredModel } from "./types.js";

export type ModelHealthStatus = "healthy" | "unhealthy" | "disabled";

export interface ModelHealthResult {
  modelId: string;
  role: RegisteredModel["role"];
  status: ModelHealthStatus;
  summary: string;
  baseUrl: string;
  model: string;
  error?: string;
}

export class NoHealthyExecutorError extends Error {
  readonly results: ModelHealthResult[];

  constructor(results: ModelHealthResult[]) {
    const detail = results.length > 0
      ? results.map((result) => `${result.modelId}: ${result.summary}`).join("; ")
      : "No executor candidates were configured.";
    super(`No healthy executor models are available. ${detail}`);
    this.name = "NoHealthyExecutorError";
    this.results = results;
  }
}

const PROBE_MESSAGES: ChatMessage[] = [
  {
    role: "user",
    content: "Reply with OK.",
  },
];

function summarizeProbeSuccess(response: ModelResponse): string {
  const content = response.content.trim();
  const reasoning = response.reasoning.trim();
  if (content) {
    return `Probe succeeded with content: ${content.slice(0, 80)}`;
  }
  if (reasoning) {
    return `Probe succeeded with reasoning: ${reasoning.slice(0, 80)}`;
  }
  if (response.toolCalls.length > 0) {
    return "Probe succeeded with native tool-call capable response.";
  }
  return "Probe succeeded.";
}

function summarizeProbeFailure(error: unknown): string {
  if (error instanceof UpstreamServiceError) {
    return `Probe failed with upstream status ${error.statusCode}.`;
  }
  if (error instanceof Error) {
    if (/abort|timeout/i.test(error.message)) {
      return "Probe timed out.";
    }
    return `Probe failed: ${error.message}`;
  }
  return `Probe failed: ${String(error)}`;
}

async function probeRegisteredModel(
  candidate: RegisteredModel,
  runner: typeof runChatCompletionDetailed,
): Promise<ModelHealthResult> {
  if (!candidate.enabled) {
    return {
      modelId: candidate.id,
      role: candidate.role,
      status: "disabled",
      summary: "Skipped because the model is disabled in config.",
      baseUrl: candidate.model.baseUrl,
      model: candidate.model.model,
    };
  }

  try {
    const response = await runner(candidate.model, PROBE_MESSAGES, undefined, undefined, {
      temperature: 0,
      maxTokens: Math.min(candidate.model.maxTokens, 8),
    });
    return {
      modelId: candidate.id,
      role: candidate.role,
      status: "healthy",
      summary: summarizeProbeSuccess(response),
      baseUrl: candidate.model.baseUrl,
      model: candidate.model.model,
    };
  } catch (error) {
    return {
      modelId: candidate.id,
      role: candidate.role,
      status: "unhealthy",
      summary: summarizeProbeFailure(error),
      baseUrl: candidate.model.baseUrl,
      model: candidate.model.model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildHealthyExecutorRuntimeConfig(
  config: OrchestratorConfig,
  runner: typeof runChatCompletionDetailed = runChatCompletionDetailed,
): Promise<{
  config: OrchestratorConfig;
  results: ModelHealthResult[];
  healthyExecutorIds: string[];
}> {
  const executorCandidates = getRoutedModels(config, "executor", { includeDisabled: true });
  const results = await Promise.all(executorCandidates.map((candidate) => probeRegisteredModel(candidate, runner)));
  const healthyExecutorIds = results
    .filter((result) => result.status === "healthy")
    .map((result) => result.modelId);

  if (healthyExecutorIds.length === 0) {
    return {
      config: {
        ...config,
        modelRouting: {
          ...config.modelRouting,
          executorCandidates: [],
        },
      },
      results,
      healthyExecutorIds,
    };
  }

  return {
    config: materializeRuntimeModelSelection({
      ...config,
      modelRouting: {
        ...config.modelRouting,
        executorCandidates: healthyExecutorIds,
      },
    }),
    results,
    healthyExecutorIds,
  };
}
