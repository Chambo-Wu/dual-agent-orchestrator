import type { ChatMessage } from "../../src/providers/openai-compatible.js";
import type { ModelConfig, ModelResponse, PlannerOutput, RoutePolicy, RunTaskResult, ExecutorOutput, OrchestratorConfig } from "../../src/types.js";
import type { RuntimeDeps } from "../../src/runtime/deps.js";

type ChatCall = {
  config: ModelConfig;
  messages: ChatMessage[];
};

export function createFakeChatRunner(responses: ModelResponse[]) {
  const calls: ChatCall[] = [];
  let index = 0;

  return {
    calls,
    runner: async (config: ModelConfig, messages: ChatMessage[]): Promise<ModelResponse> => {
      calls.push({ config, messages });
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error(`No fake chat response available for call ${index}.`);
      }
      return response;
    },
  };
}

export function createFakeRuntimeDeps(overrides?: Partial<RuntimeDeps>): Partial<RuntimeDeps> {
  return { ...overrides };
}

export function plannerNeedExecutor(request: PlannerOutput["executor_request"]): PlannerOutput {
  return {
    goal: "fake-goal",
    status: "need_executor",
    reasoning_summary: "Need executor",
    next_step: "Run executor",
    audit: { verdict: "not_applicable", notes: "" },
    executor_request: request,
  };
}

export function plannerFinal(answer: string): PlannerOutput {
  return {
    goal: "fake-goal",
    status: "final",
    reasoning_summary: "Done",
    next_step: "",
    audit: { verdict: "approved", notes: "" },
    final_answer: answer,
  };
}

export function modelResponseFromJson(value: unknown): ModelResponse {
  return {
    content: JSON.stringify(value),
    reasoning: "",
    toolCalls: [],
    raw: value,
  };
}

export function executorSuccess(overrides?: Partial<ExecutorOutput>): ExecutorOutput {
  return {
    status: "success",
    summary: "ok",
    tool_calls_made: [],
    artifacts: [],
    raw_result: "ok",
    source: "model_text",
    ...overrides,
  };
}

export function fakeRunTaskResult(overrides?: Partial<RunTaskResult>): RunTaskResult {
  return {
    status: "completed",
    output: "ok",
    verified: true,
    executorHistory: [],
    job: {
      id: "job_test",
      goal: "goal",
      mode: "task",
      status: "completed",
      verified: true,
      output: "ok",
      plan: { id: "plan_test", goal: "goal", mode: "task", taskRunIds: ["taskrun_test"] },
      taskRuns: [],
      artifacts: [],
    },
    plan: { id: "plan_test", goal: "goal", mode: "task", taskRunIds: ["taskrun_test"] },
    taskRuns: [],
    artifacts: [],
    ...overrides,
  };
}

export function buildMinimalConfig(): OrchestratorConfig {
  return {
    planner: {
      provider: "openai_compatible",
      baseUrl: "http://planner.test/v1",
      apiKey: "planner-key",
      model: "planner-model",
      timeoutMs: 1000,
      maxTokens: 512,
      temperature: 0,
    },
    executor: {
      provider: "openai_compatible",
      baseUrl: "http://executor.test/v1",
      apiKey: "executor-key",
      model: "executor-model",
      timeoutMs: 1000,
      maxTokens: 512,
      temperature: 0,
    },
    modelRegistry: {
      "planner.default": {
        id: "planner.default",
        role: "planner",
        enabled: true,
        model: {
          provider: "openai_compatible",
          baseUrl: "http://planner.test/v1",
          apiKey: "planner-key",
          model: "planner-model",
          timeoutMs: 1000,
          maxTokens: 512,
          temperature: 0,
        },
      },
      "executor.default": {
        id: "executor.default",
        role: "executor",
        enabled: true,
        model: {
          provider: "openai_compatible",
          baseUrl: "http://executor.test/v1",
          apiKey: "executor-key",
          model: "executor-model",
          timeoutMs: 1000,
          maxTokens: 512,
          temperature: 0,
        },
      },
    },
    modelRouting: {
      plannerCandidates: ["planner.default"],
      executorCandidates: ["executor.default"],
    },
    policy: {
      maxSteps: 4,
      maxReplans: 2,
      maxToolRetries: 1,
      plannerHistoryMaxEntries: 4,
      plannerHistoryPreviewChars: 160,
      maxRepeatedExecutorRequests: 2,
      autoResumeConcurrency: 3,
    },
    taskRoutingPath: "config/task-routing.yml",
  };
}

export function buildRoutePolicy(overrides?: Partial<RoutePolicy>): RoutePolicy {
  return {
    type: "general",
    matchers: [],
    plannerInstruction: "Task type: general.",
    enableRanking: false,
    requireEvidenceBeforeFinal: false,
    minGroundedCandidates: 0,
    requireArtifactReadback: false,
    requireNonEmptyArtifact: false,
    preferredTools: ["list_files"],
    artifactPriority: ["artifact"],
    completionChecklist: ["finish the task"],
    fallbackRule: "prefer small steps",
    ...overrides,
  };
}
