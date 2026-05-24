import type { RunLogger } from "../logger.js";
import { runChatCompletionDetailed, type ChatMessage } from "../providers/openai-compatible.js";
import type { ModelConfig, ModelResponse, OrchestratorConfig, PlannerOutput, RoutePolicy, RunOptions, RunTaskResult, ToolDefinition } from "../types.js";
import { buildDecompositionPrompt, buildSynthesisPrompt } from "../orchestrator/prompts.js";

export interface RuntimeDeps {
  runChatCompletionDetailed: (
    config: ModelConfig,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: RunOptions
  ) => Promise<ModelResponse>;
  runTask: (
    config: OrchestratorConfig,
    taskPrompt: string,
    routePolicy: RoutePolicy,
    logger?: RunLogger,
    deps?: Partial<RuntimeDeps>,
    options?: RunOptions
  ) => Promise<RunTaskResult>;
  runPlannerStep: (
    config: OrchestratorConfig,
    userGoal: string,
    executorHistory: RunTaskResult["executorHistory"],
    replanCount: number,
    routePolicy: RoutePolicy,
    stepNumber: number,
    logger?: RunLogger,
    deps?: Partial<RuntimeDeps>,
    options?: RunOptions
  ) => Promise<PlannerOutput>;
  runExecutorStep: (
    config: OrchestratorConfig,
    planner: PlannerOutput,
    stepNumber: number,
    logger?: RunLogger,
    deps?: Partial<RuntimeDeps>,
    options?: RunOptions
  ) => Promise<RunTaskResult["executorHistory"][number]>;
  runTeamSynthesis: (
    config: OrchestratorConfig,
    goal: string,
    resultsText: string,
    memorySummary: string,
    logger?: RunLogger,
    deps?: Partial<RuntimeDeps>,
    options?: RunOptions
  ) => Promise<string>;
  runTeamDecomposition: (
    config: OrchestratorConfig,
    goal: string,
    agentNames: string[],
    logger?: RunLogger,
    deps?: Partial<RuntimeDeps>,
    options?: RunOptions
  ) => Promise<string>;
}

export function mergeRuntimeDeps(overrides?: Partial<RuntimeDeps>): RuntimeDeps {
  return {
    runChatCompletionDetailed,
    runTask: async (config, taskPrompt, routePolicy, logger, deps, options) => {
      const module = await import("../orchestrator.js");
      return module.runTask(config, taskPrompt, routePolicy, logger, deps, options);
    },
    runPlannerStep: async (config, userGoal, executorHistory, replanCount, routePolicy, stepNumber, logger, deps, options) => {
      const module = await import("../orchestrator.js");
      const plannerFn = (module as typeof module & {
        __testables?: {
          runPlannerStep?: RuntimeDeps["runPlannerStep"];
        };
      }).__testables?.runPlannerStep;
      if (!plannerFn) {
        throw new Error("Runtime dependency runPlannerStep is not available.");
      }
      return plannerFn(config, userGoal, executorHistory, replanCount, routePolicy, stepNumber, logger, deps, options);
    },
    runExecutorStep: async (config, planner, stepNumber, logger, deps, options) => {
      const module = await import("../orchestrator.js");
      return module.runExecutorStep(config, planner, stepNumber, logger, deps, options);
    },
    runTeamSynthesis: async (config, goal, resultsText, memorySummary, _logger, _deps, options) => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a coordinator synthesizing multi-task results into a coherent answer." },
        { role: "user", content: buildSynthesisPrompt(goal, resultsText, memorySummary) },
      ];
      const response = await runChatCompletionDetailed(config.planner, messages, undefined, options);
      return response.content || response.reasoning || "";
    },
    runTeamDecomposition: async (config, goal, agentNames, _logger, _deps, options) => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a task planning coordinator. Output only valid JSON." },
        { role: "user", content: buildDecompositionPrompt(goal, agentNames) },
      ];
      const response = await runChatCompletionDetailed(config.planner, messages, undefined, options);
      return response.content || response.reasoning || "";
    },
    ...overrides,
  };
}
