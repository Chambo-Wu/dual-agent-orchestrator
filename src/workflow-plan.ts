import type { ToolDefinition, WorkflowPlan, WorkflowTaskKind, WorkflowTaskSpec, WorkflowRole } from "./types.js";

const SUPPORTED_TASK_KINDS = new Set<WorkflowTaskKind>([
  "search",
  "fetch",
  "read",
  "extract",
  "transform",
  "write",
  "verify",
  "synthesize",
  "approval",
  "delegate",
]);

const SUPPORTED_ROLES = new Set<WorkflowRole>([
  "worker",
  "verifier",
  "synthesizer",
  "planner_proxy",
]);

export interface WorkflowPlanValidationResult {
  valid: boolean;
  issues: string[];
}

export interface WorkflowExecutionSupportResult {
  supported: boolean;
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function parseWorkflowTaskSpec(value: unknown): WorkflowTaskSpec | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = isNonEmptyString(value.id) ? value.id.trim() : "";
  const title = isNonEmptyString(value.title) ? value.title.trim() : "";
  const kind = isNonEmptyString(value.kind) ? value.kind.trim() as WorkflowTaskKind : undefined;
  const role = isNonEmptyString(value.role) ? value.role.trim() as WorkflowRole : undefined;
  const instruction = isNonEmptyString(value.instruction) ? value.instruction.trim() : "";
  const allowedTools = normalizeStringArray(value.allowed_tools);
  const dependsOn = normalizeStringArray(value.depends_on);
  const required = typeof value.required === "boolean" ? value.required : true;

  if (!id || !title || !kind || !role || !instruction) {
    return undefined;
  }

  const retryPolicy = isRecord(value.retry_policy)
    ? {
        max_attempts: typeof value.retry_policy.max_attempts === "number" ? value.retry_policy.max_attempts : 1,
        on_failure: isNonEmptyString(value.retry_policy.on_failure)
          ? value.retry_policy.on_failure as "replan" | "fail" | "skip" | "fallback"
          : "fail",
        fallback_task_id: isNonEmptyString(value.retry_policy.fallback_task_id) ? value.retry_policy.fallback_task_id.trim() : undefined,
      }
    : undefined;

  const outputs = isRecord(value.outputs)
    ? {
        artifacts: normalizeStringArray(value.outputs.artifacts),
        memory_key: isNonEmptyString(value.outputs.memory_key) ? value.outputs.memory_key.trim() : undefined,
      }
    : undefined;

  const input = isRecord(value.input)
    ? {
        from_memory: normalizeStringArray(value.input.from_memory),
        from_artifacts: normalizeStringArray(value.input.from_artifacts),
      }
    : undefined;

  const constraints = isRecord(value.constraints)
    ? {
        max_tool_rounds: typeof value.constraints.max_tool_rounds === "number" ? value.constraints.max_tool_rounds : undefined,
        max_runtime_seconds: typeof value.constraints.max_runtime_seconds === "number" ? value.constraints.max_runtime_seconds : undefined,
        require_structured_output: typeof value.constraints.require_structured_output === "boolean" ? value.constraints.require_structured_output : undefined,
      }
    : undefined;

  return {
    id,
    title,
    kind,
    role,
    instruction,
    allowed_tools: allowedTools,
    depends_on: dependsOn,
    required,
    input,
    constraints,
    retry_policy: retryPolicy,
    outputs,
  };
}

export function parseWorkflowPlan(value: unknown): WorkflowPlan | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = isNonEmptyString(value.id) ? value.id.trim() : "";
  const strategy = isNonEmptyString(value.strategy) ? value.strategy.trim() : "";
  const summary = isNonEmptyString(value.summary) ? value.summary.trim() : "";
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map((item) => parseWorkflowTaskSpec(item)).filter((item): item is WorkflowTaskSpec => Boolean(item))
    : [];
  const finishWhen = isRecord(value.finish_when)
    ? {
        mode: isNonEmptyString(value.finish_when.mode)
          ? value.finish_when.mode as WorkflowPlan["finish_when"]["mode"]
          : "all_required_tasks_completed",
        task_ids: normalizeStringArray(value.finish_when.task_ids),
      }
    : undefined;
  const replanPolicy = isRecord(value.replan_policy)
    ? {
        allow_runtime_replan: typeof value.replan_policy.allow_runtime_replan === "boolean" ? value.replan_policy.allow_runtime_replan : false,
        max_replans: typeof value.replan_policy.max_replans === "number" ? value.replan_policy.max_replans : 0,
      }
    : undefined;

  if (!id || !strategy || !summary || !finishWhen || tasks.length === 0) {
    return undefined;
  }

  return {
    id,
    strategy,
    summary,
    tasks,
    finish_when: finishWhen,
    replan_policy: replanPolicy,
  };
}

export function validateWorkflowPlan(plan: WorkflowPlan, tools: readonly ToolDefinition[]): WorkflowPlanValidationResult {
  const issues: string[] = [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const taskIds = new Set<string>();

  if (plan.tasks.length > 16) {
    issues.push(`workflow plan defines ${plan.tasks.length} tasks, which exceeds the current runtime limit of 16`);
  }

  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) {
      issues.push(`duplicate task id: ${task.id}`);
    }
    taskIds.add(task.id);

    if (!SUPPORTED_TASK_KINDS.has(task.kind)) {
      issues.push(`unsupported task kind: ${task.kind}`);
    }
    if (!SUPPORTED_ROLES.has(task.role)) {
      issues.push(`unsupported workflow role: ${task.role}`);
    }
    for (const tool of task.allowed_tools) {
      if (!toolNames.has(tool)) {
        issues.push(`task ${task.id} references unknown tool: ${tool}`);
      }
    }
    if (task.retry_policy?.max_attempts !== undefined && task.retry_policy.max_attempts < 0) {
      issues.push(`task ${task.id} has invalid retry max_attempts`);
    }
  }

  for (const task of plan.tasks) {
    for (const depId of task.depends_on) {
      if (!taskIds.has(depId)) {
        issues.push(`task ${task.id} depends on unknown task ${depId}`);
      }
      if (depId === task.id) {
        issues.push(`task ${task.id} depends on itself`);
      }
    }
    if (task.retry_policy?.on_failure === "fallback") {
      if (!task.retry_policy.fallback_task_id) {
        issues.push(`task ${task.id} uses fallback on_failure but does not define fallback_task_id`);
      } else if (!taskIds.has(task.retry_policy.fallback_task_id)) {
        issues.push(`task ${task.id} references unknown fallback task ${task.retry_policy.fallback_task_id}`);
      } else if (task.retry_policy.fallback_task_id === task.id) {
        issues.push(`task ${task.id} cannot fallback to itself`);
      }
    }
  }

  if (plan.finish_when.task_ids) {
    for (const taskId of plan.finish_when.task_ids) {
      if (!taskIds.has(taskId)) {
        issues.push(`finish_when references unknown task ${taskId}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task]));

  function visit(taskId: string): void {
    if (visited.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      issues.push(`cycle detected at task ${taskId}`);
      return;
    }
    visiting.add(taskId);
    const task = taskMap.get(taskId);
    for (const depId of task?.depends_on ?? []) {
      visit(depId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of plan.tasks) {
    visit(task.id);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function buildWorkflowFallbackExecutorRequest(plan: WorkflowPlan): {
  instruction: string;
  allowed_tools: string[];
  expected_output: string;
} | undefined {
  const firstTask = plan.tasks.find((task) => task.required !== false) ?? plan.tasks[0];
  if (!firstTask) {
    return undefined;
  }
  return {
    instruction: `Runtime fallback: execute the first workflow task directly.\nTask title: ${firstTask.title}\nTask kind: ${firstTask.kind}\nTask instruction: ${firstTask.instruction}`,
    allowed_tools: firstTask.allowed_tools,
    expected_output: `Progress for workflow task ${firstTask.id} (${firstTask.title}).`,
  };
}

export function assessWorkflowExecutionSupport(plan: WorkflowPlan): WorkflowExecutionSupportResult {
  const issues: string[] = [];
  const milestoneCSupportedKinds = new Set<WorkflowTaskKind>([
    "delegate",
    "write",
    "approval",
    "read",
    "search",
    "fetch",
    "extract",
    "verify",
    "synthesize",
  ]);

  for (const task of plan.tasks) {
    if (!milestoneCSupportedKinds.has(task.kind)) {
      issues.push(`unsupported workflow task kind for the current runtime: ${task.kind}`);
    }
  }

  return {
    supported: issues.length === 0,
    issues,
  };
}
