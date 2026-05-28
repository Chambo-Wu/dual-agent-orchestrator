import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import type { RunLogger } from "./logger.js";
import type { AgentToolPolicy, Artifact, Job, OrchestratorConfig, Plan, RegisteredAgent, RunOptions, Task, TaskRun, TaskSpec, TeamConfig } from "./types.js";
import { materializeRuntimeModelSelection } from "./config.js";
import { createTask, validateTaskDependencies } from "./task/task.js";
import { TaskQueue } from "./task/queue.js";
import { Scheduler, type AgentInfo } from "./orchestrator/scheduler.js";
import { SharedMemory } from "./memory/shared.js";
import { RunCancelledError, runTask, detectTaskType, getRoutePolicy } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { buildDecompositionPrompt, buildSynthesisPrompt, buildTaskPrompt } from "./orchestrator/prompts.js";
import { Tracer } from "./trace.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "./workflow-contract.js";
import { buildWorkflowGraph } from "./workflow-graph.js";
import { mergeRuntimeDeps, type RuntimeDeps } from "./runtime/deps.js";
import { buildControlledFallbackTask, parseTeamTaskSpecs } from "./team-schema.js";

const COMPLEXITY_SIGNALS = [
  /\bfirst\b.*\bthen\b/i,
  /\bstep\s*\d/i,
  /\bcollaborate\b/i,
  /\bin parallel\b/i,
  /\bmulti[- ]?step\b/i,
  /\band also\b/i,
  /\bthen\b.*\band\b/i,
  /\d+\.\s+\S/,
];

function isSimpleGoal(goal: string): boolean {
  if (goal.length > 200) return false;
  return !COMPLEXITY_SIGNALS.some((re) => re.test(goal));
}

function selectBestAgent(goal: string, agents: AgentInfo[]): AgentInfo {
  const goalLower = goal.toLowerCase();
  let best = agents[0]!;
  let bestScore = 0;
  for (const agent of agents) {
    const roleLower = (agent.role ?? agent.name).toLowerCase();
    let score = 0;
    for (const word of roleLower.split(/[^a-z0-9一-鿿]+/)) {
      if (word.length >= 2 && goalLower.includes(word)) score++;
    }
    for (const word of goalLower.split(/[^a-z0-9一-鿿]+/)) {
      if (word.length >= 2 && roleLower.includes(word)) score++;
    }
    if (score > bestScore) { bestScore = score; best = agent; }
  }
  return best;
}

export interface TeamAgent {
  name: string;
  role?: string;
}

export interface TeamRunResult {
  goal: string;
  finalAnswer: string;
  taskResults: Map<string, { success: boolean; output: string }>;
  memorySummary: string;
  tasks: Task[];
  job: Job;
  plan: Plan;
  taskRuns: TaskRun[];
  artifacts: Artifact[];
}

function buildSubtaskConfig(config: OrchestratorConfig): OrchestratorConfig {
  return {
    ...config,
    policy: {
      ...config.policy,
      maxSteps: Math.min(config.policy.maxSteps, 2),
      maxReplans: Math.min(config.policy.maxReplans, 1),
      maxToolRetries: Math.min(config.policy.maxToolRetries, 1),
    },
  };
}

function resolveRegisteredAgent(config: OrchestratorConfig, assignee: string | undefined): RegisteredAgent | undefined {
  if (!assignee || !config.agents) {
    return undefined;
  }
  return config.agents[assignee];
}

function resolveExecutorAgent(config: OrchestratorConfig, assignee: string | undefined): RegisteredAgent | undefined {
  const direct = resolveRegisteredAgent(config, assignee);
  if (direct) {
    return direct;
  }
  if (config.defaultExecutorAgent && config.agents?.[config.defaultExecutorAgent]) {
    return config.agents[config.defaultExecutorAgent];
  }
  return undefined;
}

function resolveRoleAgent(config: OrchestratorConfig, roleName: string): RegisteredAgent | undefined {
  const normalizedRole = roleName.toLowerCase();
  return Object.values(config.agents ?? {}).find((agent) => {
    const id = agent.id.toLowerCase();
    const role = agent.role.toLowerCase();
    return id === normalizedRole || role === normalizedRole || role.includes(normalizedRole);
  });
}

function applyAgentToolPolicy(requestedTools: string[], policy?: AgentToolPolicy): string[] {
  let tools = [...requestedTools];
  if (policy?.allow && policy.allow.length > 0) {
    const allowed = new Set(policy.allow);
    tools = tools.filter((tool) => allowed.has(tool));
  }
  if (policy?.deny && policy.deny.length > 0) {
    const denied = new Set(policy.deny);
    tools = tools.filter((tool) => !denied.has(tool));
  }
  return Array.from(new Set(tools));
}

function buildAgentScopedRoutePolicy(
  routePolicy: ReturnType<typeof getRoutePolicy>,
  agent: RegisteredAgent | undefined,
): ReturnType<typeof getRoutePolicy> {
  if (!agent?.tools) {
    return routePolicy;
  }
  return {
    ...routePolicy,
    preferredTools: applyAgentToolPolicy(routePolicy.preferredTools, agent.tools),
  };
}

function buildAgentScopedConfig(config: OrchestratorConfig, agent: RegisteredAgent | undefined): OrchestratorConfig {
  if (!agent) {
    return config;
  }
  return materializeRuntimeModelSelection({
    ...config,
    executor: agent.model,
    modelRegistry: {
      ...config.modelRegistry,
      "executor.default": {
        ...(config.modelRegistry["executor.default"] ?? {
          id: "executor.default",
          role: "executor",
          enabled: true,
          model: agent.model,
        }),
        model: agent.model,
      },
    },
    modelRouting: {
      ...config.modelRouting,
      executorCandidates: ["executor.default"],
    },
    executorToolPolicy: agent.tools,
  });
}

function buildAgentScopedPlannerConfig(config: OrchestratorConfig, agent: RegisteredAgent | undefined): OrchestratorConfig {
  if (!agent) {
    return config;
  }
  return materializeRuntimeModelSelection({
    ...config,
    planner: agent.model,
    modelRegistry: {
      ...config.modelRegistry,
      "planner.default": {
        ...(config.modelRegistry["planner.default"] ?? {
          id: "planner.default",
          role: "planner",
          enabled: true,
          model: agent.model,
        }),
        model: agent.model,
      },
    },
    modelRouting: {
      ...config.modelRouting,
      plannerCandidates: ["planner.default"],
    },
  });
}

function getAgentConcurrencyLimit(agent: RegisteredAgent | undefined, fallback: number): number {
  return agent?.limits?.max_concurrency ?? fallback;
}

function getAgentRuntimeKey(agent: RegisteredAgent | undefined, assignee: string | undefined): string {
  return agent?.id ?? assignee ?? "unassigned";
}

async function buildDependencyContextFromMemory(
  sharedMem: SharedMemory,
  task: Task,
  queue: TaskQueue,
): Promise<string | undefined> {
  const dependencyIds = task.memoryScope === "all"
    ? queue.list().filter((item) => item.status === "completed").map((item) => item.id)
    : [...(task.dependsOn ?? [])];
  const contextParts: string[] = [];

  for (const depId of dependencyIds) {
    const dep = queue.get(depId);
    if (!dep || dep.status !== "completed") continue;
    const entry = await sharedMem.readScoped("task", dep.assignee ?? "unassigned", "result", dep.id);
    const value = entry?.value ?? dep.result;
    if (value) {
      contextParts.push(`### ${dep.title} (by ${dep.assignee ?? "unknown"})\n${value}`);
    }
  }

  return contextParts.length > 0 ? contextParts.join("\n\n") : undefined;
}

async function executeWithRetry<T>(
  task: Task,
  fn: () => Promise<T>,
  tracer: Tracer,
  logger?: RunLogger,
  options?: RunOptions,
): Promise<T> {
  const maxRetries = task.maxRetries ?? 0;
  const baseDelay = task.retryDelayMs ?? 1000;
  const backoff = task.retryBackoff ?? 2;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    assertNotCancelled(options);
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(backoff, attempt), 30_000);
        tracer.emit("task.retry", { taskId: task.id, attempt: attempt + 1, delay, error: msg });
        logger?.log("team.task.retry", { taskId: task.id, attempt: attempt + 1, delay, error: msg });
        await sleep(delay, options);
      }
    }
  }
  throw lastError;
}

function assertNotCancelled(options?: RunOptions): void {
  if (!options?.abortSignal?.aborted) return;
  const reason = options.abortSignal.reason;
  throw reason instanceof Error ? reason : new RunCancelledError(typeof reason === "string" ? reason : undefined);
}

function sleep(ms: number, options?: RunOptions): Promise<void> {
  if (options?.abortSignal?.aborted) {
    return Promise.reject(options.abortSignal.reason instanceof Error ? options.abortSignal.reason : new RunCancelledError());
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(options?.abortSignal?.reason instanceof Error ? options.abortSignal.reason : new RunCancelledError());
    };
    options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runTeam(
  config: OrchestratorConfig,
  goal: string,
  teamAgents: TeamAgent[],
  logger?: RunLogger,
  tracer?: Tracer,
  teamConfig?: TeamConfig,
  deps?: Partial<RuntimeDeps>,
  options?: RunOptions,
): Promise<TeamRunResult> {
  const runtimeDeps = mergeRuntimeDeps(deps);
  assertNotCancelled(options);
  const sharedMem = new SharedMemory();
  const subtaskConfig = buildSubtaskConfig(config);
  const agentNames = teamAgents.map((a) => a.name);
  const trace = tracer ?? new Tracer(logger);
  const maxConcurrency = teamConfig?.maxConcurrency ?? 5;
  const maxRounds = teamConfig?.maxRounds ?? 20;

  logger?.log("team.start", { goal, agents: agentNames, maxConcurrency });

  if (isSimpleGoal(goal) && teamAgents.length > 0) {
    const best = selectBestAgent(goal, teamAgents);
    logger?.log("team.short_circuit", { agent: best.name, reason: "simple_goal" });
    trace.emit("goal.achieved", { agent: best.name, reason: "simple_goal" });
    const routing = loadTaskRoutingConfig(config.taskRoutingPath);
    const taskType = detectTaskType(goal, routing);
    const agent = resolveExecutorAgent(config, best.name);
    const routePolicy = buildAgentScopedRoutePolicy(getRoutePolicy(taskType, routing), agent);
    const result = await runtimeDeps.runTask(buildAgentScopedConfig(config, agent), goal, routePolicy, logger, runtimeDeps, options);
    const taskRun = createTaskRunRecord({
      id: result.taskRuns[0]?.id,
      title: result.taskRuns[0]?.title ?? goal,
      description: result.taskRuns[0]?.description ?? goal,
      status: result.status,
      assignee: best.name,
      dependsOn: [],
      verified: result.verified,
      output: result.output,
      artifacts: result.artifacts,
      attempts: result.executorHistory.length,
      executorHistory: result.executorHistory,
    });
    const plan = createPlanRecord({
      goal,
      mode: "team",
      taskRunIds: [taskRun.id],
      summary: "Team orchestration short-circuited to a single agent.",
    });
    const workflowGraph = buildWorkflowGraph(plan.id, [taskRun], plan.summary);
    const job = createJobRecord({
      goal,
      mode: "team",
      status: result.status,
      verified: result.verified,
      output: result.output,
      plan,
      taskRuns: [taskRun],
      artifacts: result.artifacts,
      memorySummary: "",
      workflowGraph,
    });
    return {
      goal,
      finalAnswer: result.output,
      taskResults: new Map([[best.name, { success: result.status === "completed", output: result.output }]]),
      memorySummary: "",
      tasks: [],
      job,
      plan,
      taskRuns: [taskRun],
      artifacts: result.artifacts,
    };
  }

  // Step 1: Coordinator decomposition
  trace.emit("round.started", { round: 0, phase: "decomposition" });
  logger?.log("team.decomposition.start", { agents: agentNames });
  const decompositionPrompt = buildDecompositionPrompt(goal, agentNames);
  const decompositionMessages: ChatMessage[] = [
    { role: "system", content: "You are a task planning coordinator. Output only valid JSON." },
    { role: "user", content: decompositionPrompt },
  ];

  let decompositionRaw: string;
  try {
    decompositionRaw = await runtimeDeps.runTeamDecomposition(config, goal, agentNames, logger, runtimeDeps, options);
    logger?.log("team.decomposition.response", { raw: decompositionRaw });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.log("team.decomposition.error", { error: msg });
    decompositionRaw = "";
  }

  // Step 2: Parse tasks
  const parsedTaskSpecs = parseTeamTaskSpecs(decompositionRaw, agentNames);
  let taskSpecs = parsedTaskSpecs.tasks;
  let fallbackReason = "";
  if (!parsedTaskSpecs.valid) {
    fallbackReason = parsedTaskSpecs.errors.join("; ") || "decomposition parse failed";
    logger?.log("team.decomposition.fallback", { reason: fallbackReason });
    const best = teamAgents.length > 0 ? selectBestAgent(goal, teamAgents) : undefined;
    taskSpecs = [buildControlledFallbackTask(goal, best?.name, fallbackReason)];
  }

  // Step 3: Load tasks into queue
  const queue = new TaskQueue();
  const titleToId = new Map<string, string>();
  const taskIds: string[] = [];

  for (const spec of taskSpecs) {
    const task = createTask(spec);
    titleToId.set(spec.title.toLowerCase().trim(), task.id);
    taskIds.push(task.id);
    trace.emit("task.created", { taskId: task.id, title: task.title, assignee: task.assignee });
  }

  for (let i = 0; i < taskSpecs.length; i++) {
    const spec = taskSpecs[i]!;
    const taskId = taskIds[i]!;
    let dependsOn: string[] | undefined;
    if (spec.dependsOn && spec.dependsOn.length > 0) {
      dependsOn = spec.dependsOn.map((ref) => titleToId.get(ref.toLowerCase().trim()) ?? ref);
    }
    const task = createTask({ ...spec, dependsOn });
    queue.add({ ...task, id: taskId });
  }

  const validation = validateTaskDependencies(queue.list());
  if (!validation.valid) {
    logger?.log("team.dependency_warning", { errors: validation.errors });
  }

  // Step 4: Auto-assign
  const scheduler = new Scheduler("dependency-first");
  scheduler.autoAssign(queue, teamAgents);

  logger?.log("team.plan", {
    tasks: queue.list().map((t) => ({
      id: t.id, title: t.title, status: t.status, assignee: t.assignee, dependsOn: t.dependsOn,
    })),
    fallback_reason: fallbackReason,
  });

  if (teamConfig?.planOnly) {
    const taskRuns = queue.list().map((task) => createTaskRunRecord({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      dependsOn: task.dependsOn ?? [],
      verified: false,
      output: "",
      attempts: 0,
      artifacts: [],
    }));
    const plan = createPlanRecord({
      goal,
      mode: "team",
      taskRunIds: taskRuns.map((taskRun) => taskRun.id),
      summary: fallbackReason
        ? `Team plan only with controlled fallback: ${fallbackReason}`
        : `Team plan only with ${taskRuns.length} task runs.`,
    });
    const workflowGraph = buildWorkflowGraph(plan.id, taskRuns, plan.summary);
    const job = createJobRecord({
      goal,
      mode: "team",
      status: "blocked",
      verified: false,
      output: fallbackReason ? `Plan generated with fallback: ${fallbackReason}` : "Plan generated without execution.",
      plan,
      taskRuns,
      artifacts: [],
      memorySummary: "",
      workflowGraph,
    });
    return {
      goal,
      finalAnswer: job.output,
      taskResults: new Map(),
      memorySummary: "",
      tasks: queue.list(),
      job,
      plan,
      taskRuns,
      artifacts: [],
    };
  }

  // Step 5: Event-driven task dispatch with concurrency control
  const taskResults = new Map<string, { success: boolean; output: string }>();
  const taskRunsById = new Map<string, TaskRun>();
  let activeCount = 0;
  const activeByAgent = new Map<string, number>();
  const inFlight: Set<Promise<void>> = new Set();
  let resolveAllComplete: (() => void) | undefined;
  const allComplete = new Promise<void>((r) => { resolveAllComplete = r; });

  async function dispatchTask(task: Task): Promise<void> {
    assertNotCancelled(options);
    const agentName = task.assignee ?? "unassigned";
    const agent = resolveExecutorAgent(config, agentName);
    const agentRuntimeKey = getAgentRuntimeKey(agent, agentName);
    activeCount++;
    activeByAgent.set(agentRuntimeKey, (activeByAgent.get(agentRuntimeKey) ?? 0) + 1);
    queue.update(task.id, { status: "in_progress" });
    trace.emit("task.started", { taskId: task.id, title: task.title, assignee: task.assignee });

    const dependencyContext = await buildDependencyContextFromMemory(sharedMem, task, queue);

    if (dependencyContext) {
      await sharedMem.writeScoped("task", agentName, "context", dependencyContext, task.id);
    }

    const taskPrompt = buildTaskPrompt(task.title, task.description, dependencyContext);
    const routing = loadTaskRoutingConfig(config.taskRoutingPath);
    const taskType = detectTaskType(taskPrompt, routing);
    const routePolicy = buildAgentScopedRoutePolicy(getRoutePolicy(taskType, routing), agent);
    const agentScopedConfig = buildAgentScopedConfig(subtaskConfig, agent);

    try {
      logger?.log("team.task.start", {
        taskId: task.id,
        title: task.title,
        assignee: agentName,
        routed_agent: agent?.id ?? null,
        executor_model: agent?.model.model ?? subtaskConfig.executor.model,
        preferred_tools: routePolicy.preferredTools,
      });

      const result = await executeWithRetry(task, async () => {
        return await runtimeDeps.runTask(agentScopedConfig, taskPrompt, routePolicy, logger, runtimeDeps, options);
      }, trace, logger, options);

      const output = result.output;
      const success = result.status === "completed";
      const verified = result.verified;

      if (result.status === "completed") {
        queue.complete(task.id, output, verified);
      } else if (result.status === "failed") {
        queue.fail(task.id, output);
      } else {
        queue.complete(task.id, output, false);
      }
      taskResults.set(task.id, { success, output });
      taskRunsById.set(task.id, createTaskRunRecord({
        id: task.id,
        title: task.title,
        description: task.description,
        status: result.status === "completed" ? "completed" : result.status,
        assignee: agentName,
        dependsOn: task.dependsOn ?? [],
        verified,
        output,
        artifacts: result.artifacts,
        attempts: result.executorHistory.length,
        executorHistory: result.executorHistory,
      }));

      await sharedMem.write(agentName, `task:${task.id}:result`, output);
      await sharedMem.writeScoped("task", agentName, "result", output, task.id, {
        title: task.title,
        status: result.status,
        verified,
      });
      sharedMem.advanceTurn();

      trace.emit(verified ? "task.completed" : "task.blocked", { taskId: task.id, agent: agentName, verified });
      logger?.log("team.task.complete", { taskId: task.id, success, verified, output: output.slice(0, 200) });
    } catch (err) {
      const cancelled = err instanceof RunCancelledError || options?.abortSignal?.aborted;
      const errMsg = cancelled ? "Run cancelled." : err instanceof Error ? err.message : String(err);
      queue.fail(task.id, errMsg);
      taskResults.set(task.id, { success: false, output: errMsg });
      taskRunsById.set(task.id, createTaskRunRecord({
        id: task.id,
        title: task.title,
        description: task.description,
        status: cancelled ? "blocked" : "failed",
        assignee: agentName,
        dependsOn: task.dependsOn ?? [],
        verified: false,
        output: errMsg,
        artifacts: [],
        attempts: 1,
      }));
      trace.emit(cancelled ? "task.blocked" : "task.failed", { taskId: task.id, agent: task.assignee, error: errMsg });
      logger?.log(cancelled ? "team.task.cancelled" : "team.task.failed", { taskId: task.id, error: errMsg });
    }

    activeCount--;
    activeByAgent.set(agentRuntimeKey, Math.max(0, (activeByAgent.get(agentRuntimeKey) ?? 1) - 1));
    void tryDrain();
  }

  const dispatchQueue: Task[] = [];
  let draining = false;

  async function tryDrain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (dispatchQueue.length > 0 && activeCount < maxConcurrency) {
      if (options?.abortSignal?.aborted) {
        queue.skipRemaining("Skipped: run cancelled.");
        break;
      }
      const dispatchIndex = dispatchQueue.findIndex((task) => {
        const assignee = task.assignee ?? "unassigned";
        const agent = resolveExecutorAgent(config, assignee);
        const runtimeKey = getAgentRuntimeKey(agent, assignee);
        const activeForAgent = activeByAgent.get(runtimeKey) ?? 0;
        return activeForAgent < getAgentConcurrencyLimit(agent, maxConcurrency);
      });
      if (dispatchIndex < 0) {
        break;
      }
      const [task] = dispatchQueue.splice(dispatchIndex, 1);
      if (!task) {
        break;
      }
      const p = dispatchTask(task).catch(() => {});
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
    }
    draining = false;
  }

  queue.on("task:ready", (task) => {
    dispatchQueue.push(task);
    void tryDrain();
  });

  queue.on("all:complete", () => {
    if (resolveAllComplete) resolveAllComplete();
  });

  // Approval gate
  if (teamConfig?.onApproval) {
    const pendingBeforeDispatch = queue.getByStatus("pending");
    if (pendingBeforeDispatch.length > 0) {
      const awaitingApproval = pendingBeforeDispatch.map((task) =>
        queue.update(task.id, { status: "awaiting_approval", result: "Waiting for approval." })
      );
      for (const task of awaitingApproval) {
        trace.emit("task.awaiting_approval", { taskId: task.id, title: task.title, assignee: task.assignee });
        options?.onEvent?.({
          type: "workflow.task.awaiting_approval",
          data: {
            task_id: task.id,
            title: task.title,
            kind: "approval",
            role: task.assignee ?? "worker",
            assignee: task.assignee ?? null,
            depends_on: task.dependsOn ?? [],
          },
        });
      }

      const approved = await teamConfig.onApproval(awaitingApproval);
      if (!approved) {
        queue.skipRemaining("Skipped: approval rejected.");
      } else {
        for (const task of awaitingApproval) {
          queue.update(task.id, { status: "pending", result: undefined });
        }
      }
    }
  }

  for (const task of queue.getByStatus("pending")) {
    dispatchQueue.push(task);
  }
  void tryDrain();

  const timeoutMs = (teamConfig as Record<string, unknown> | undefined)?.timeoutMs;
  const effectiveTimeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : maxRounds * 120_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timeoutHandle = setTimeout(() => r("timeout"), effectiveTimeout);
  });
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (options?.abortSignal?.aborted) {
      resolve("cancelled");
      return;
    }
    options?.abortSignal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });
  const raceResult = await Promise.race([allComplete.then(() => "complete" as const), timeout, cancelled]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  // Wait for all in-flight tasks to settle before synthesis to avoid race conditions
  if (inFlight.size > 0) {
    logger?.log("team.settling", { inFlight: inFlight.size });
    await Promise.allSettled([...inFlight]);
  }

  if (raceResult === "timeout") {
    logger?.log("team.timeout", { elapsed: effectiveTimeout });
    trace.emit("round.completed", { reason: "timeout" });
  }

  // Step 6: Coordinator synthesis
  const completedTasks = queue.list().filter((t) => t.status === "completed" || t.status === "failed");
  const resultsText = completedTasks.map((t) => {
    const taskRun = taskRunsById.get(t.id);
    const verified = taskRun?.verified ? "VERIFIED" : "UNVERIFIED";
    return `### ${t.title} (${t.assignee ?? "unassigned"}) — ${taskRun?.status === "completed" ? "SUCCESS" : "FAILED"} [${verified}]\n${taskRun?.output ?? "no output"}`;
  }).join("\n\n");

  const completedIds = completedTasks.map((t) => t.id);
  const memorySummary = await sharedMem.getSummary({ taskIds: completedIds });

  trace.emit("synthesis.started", { completedTasks: completedTasks.length });
  logger?.log("team.synthesis.start", { completedTasks: completedTasks.length });

  let finalAnswer: string;
  try {
    if (raceResult === "cancelled") {
      finalAnswer = "Run cancelled.";
    } else {
      const synthesizerAgent = resolveRoleAgent(config, "synthesizer");
      const synthesisConfig = buildAgentScopedPlannerConfig(config, synthesizerAgent);
      logger?.log("team.synthesis.route", {
        routed_agent: synthesizerAgent?.id ?? null,
        planner_model: synthesisConfig.planner.model,
      });
      finalAnswer = await runtimeDeps.runTeamSynthesis(synthesisConfig, goal, resultsText, memorySummary, logger, runtimeDeps, options);
    }
  } catch {
    finalAnswer = completedTasks
      .filter((t) => taskResults.get(t.id)?.success)
      .map((t) => taskResults.get(t.id)?.output ?? "")
      .join("\n\n");
  }

  trace.emit("synthesis.completed", { output: finalAnswer.slice(0, 200) });
  await sharedMem.writeScoped("global", "coordinator", "synthesis", finalAnswer);

  logger?.log("team.complete", {
    goal,
    taskCount: taskIds.length,
    completedCount: completedTasks.filter((t) => t.status === "completed").length,
    failedCount: completedTasks.filter((t) => t.status === "failed").length,
    traceSummary: trace.getSummary(),
  });

  const taskRuns = queue.list().map((task) => {
    const existing = taskRunsById.get(task.id);
    if (existing) {
      return existing;
    }
    return createTaskRunRecord({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      dependsOn: task.dependsOn ?? [],
      verified: task.verified ?? false,
      output: task.result ?? "",
      attempts: 0,
      artifacts: [],
    });
  });
  const artifacts = taskRuns.flatMap((taskRun) => taskRun.artifacts);
  const teamStatus = raceResult === "timeout" || raceResult === "cancelled"
    ? "blocked"
    : taskRuns.every((taskRun) => taskRun.status === "completed")
      ? "completed"
      : taskRuns.some((taskRun) => taskRun.status === "completed")
        ? "completed"
        : taskRuns.some((taskRun) => taskRun.status === "failed")
          ? "failed"
          : "blocked";
  const teamVerified = taskRuns.length > 0
    ? taskRuns.every((taskRun) => taskRun.status !== "completed" || taskRun.verified)
    : true;
  const plan = createPlanRecord({
    goal,
    mode: "team",
    taskRunIds: taskRuns.map((taskRun) => taskRun.id),
    summary: `Team plan with ${taskRuns.length} task runs.`,
  });
  const workflowGraph = buildWorkflowGraph(plan.id, taskRuns, plan.summary);
  const job = createJobRecord({
    goal,
    mode: "team",
    status: teamStatus,
    verified: teamVerified,
    output: finalAnswer,
    plan,
    taskRuns,
    artifacts,
    memorySummary,
    workflowGraph,
  });

  return { goal, finalAnswer, taskResults, memorySummary, tasks: queue.list(), job, plan, taskRuns, artifacts };
}
