import test from "node:test";
import assert from "node:assert/strict";
import { assessWorkflowExecutionSupport, buildWorkflowFallbackExecutorRequest, parseWorkflowPlan, validateWorkflowPlan } from "../../src/workflow-plan.js";
import { TOOL_DEFINITIONS } from "../../src/tools.js";

test("workflow plan parses and validates a minimal milestone A plan", () => {
  const plan = parseWorkflowPlan({
    id: "wf_demo",
    strategy: "research_and_write",
    summary: "Collect evidence, then write a result.",
    tasks: [
      {
        id: "t1",
        title: "Collect evidence",
        kind: "delegate",
        role: "worker",
        instruction: "Collect evidence with direct tools.",
        allowed_tools: ["web_search", "read_file"],
        depends_on: [],
        required: true,
      },
    ],
    finish_when: {
      mode: "all_required_tasks_completed",
    },
    replan_policy: {
      allow_runtime_replan: true,
      max_replans: 1,
    },
  });

  assert.ok(plan);
  const validation = validateWorkflowPlan(plan!, TOOL_DEFINITIONS);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.issues, []);
});

test("workflow plan validation rejects duplicate ids, unknown tools, and cycles", () => {
  const plan = parseWorkflowPlan({
    id: "wf_invalid",
    strategy: "broken",
    summary: "Broken plan.",
    tasks: [
      {
        id: "t1",
        title: "One",
        kind: "delegate",
        role: "worker",
        instruction: "First task.",
        allowed_tools: ["missing_tool"],
        depends_on: ["t2"],
        required: true,
      },
      {
        id: "t1",
        title: "Two",
        kind: "write",
        role: "worker",
        instruction: "Second task.",
        allowed_tools: ["write_file"],
        depends_on: ["t1"],
        required: true,
      },
    ],
    finish_when: {
      mode: "any_of",
      task_ids: ["missing_task"],
    },
  });

  assert.ok(plan);
  const validation = validateWorkflowPlan(plan!, TOOL_DEFINITIONS);
  assert.equal(validation.valid, false);
  assert.equal(validation.issues.some((issue) => issue.includes("duplicate task id")), true);
  assert.equal(validation.issues.some((issue) => issue.includes("unknown tool")), true);
  assert.equal(validation.issues.some((issue) => issue.includes("cycle detected")), true);
  assert.equal(validation.issues.some((issue) => issue.includes("finish_when references unknown task")), true);
});

test("workflow fallback executor request uses the first required task", () => {
  const plan = parseWorkflowPlan({
    id: "wf_fallback",
    strategy: "report",
    summary: "Write the report.",
    tasks: [
      {
        id: "optional",
        title: "Optional prework",
        kind: "read",
        role: "worker",
        instruction: "Optional prework.",
        allowed_tools: ["read_file"],
        depends_on: [],
        required: false,
      },
      {
        id: "required",
        title: "Write report",
        kind: "write",
        role: "worker",
        instruction: "Write the markdown report.",
        allowed_tools: ["write_file"],
        depends_on: [],
        required: true,
      },
    ],
    finish_when: {
      mode: "all_required_tasks_completed",
    },
  });

  assert.ok(plan);
  const fallback = buildWorkflowFallbackExecutorRequest(plan!);
  assert.ok(fallback);
  assert.equal(fallback?.allowed_tools.includes("write_file"), true);
  assert.equal(fallback?.instruction.includes("Write report"), true);
  assert.equal(fallback?.expected_output.includes("required"), true);
});

test("workflow execution support includes verify in milestone C", () => {
  const plan = parseWorkflowPlan({
    id: "wf_verify_support",
    strategy: "verify_then_write",
    summary: "Verify artifacts before writing.",
    tasks: [
      {
        id: "t1",
        title: "Read source",
        kind: "read",
        role: "worker",
        instruction: "Read source.txt.",
        allowed_tools: ["read_file"],
        depends_on: [],
        required: true,
      },
      {
        id: "t2",
        title: "Verify source",
        kind: "verify",
        role: "verifier",
        instruction: "Verify the source artifact is present.",
        allowed_tools: ["read_file"],
        depends_on: ["t1"],
        required: true,
        constraints: {
          verifier_profile: "system_and_model",
          verifier_agent_id: "verifier_a",
        },
      },
    ],
    finish_when: {
      mode: "all_required_tasks_completed",
    },
  });

  assert.ok(plan);
  assert.equal(plan.tasks[1]?.constraints?.verifier_profile, "system_and_model");
  assert.equal(plan.tasks[1]?.constraints?.verifier_agent_id, "verifier_a");
  const support = assessWorkflowExecutionSupport(plan!);
  assert.equal(support.supported, true);
  assert.deepEqual(support.issues, []);
});

test("workflow plan validation constrains verifier profile fields to verify tasks", () => {
  const plan = parseWorkflowPlan({
    id: "wf_invalid_verifier_profile",
    strategy: "invalid_verifier_profile",
    summary: "Invalid verifier constraints.",
    tasks: [
      {
        id: "t1",
        title: "Write report",
        kind: "write",
        role: "worker",
        instruction: "Write report.md.",
        allowed_tools: ["write_file"],
        depends_on: [],
        required: true,
        constraints: {
          verifier_profile: "system_and_model",
          verifier_agent_id: "verifier_a",
        },
      },
      {
        id: "t2",
        title: "Verify report",
        kind: "verify",
        role: "verifier",
        instruction: "Verify report.md.",
        allowed_tools: [],
        depends_on: ["t1"],
        required: true,
        constraints: {
          verifier_profile: "unsupported_profile",
        },
      },
    ],
    finish_when: {
      mode: "all_required_tasks_completed",
    },
  });

  assert.ok(plan);
  const validation = validateWorkflowPlan(plan!, TOOL_DEFINITIONS);
  assert.equal(validation.valid, false);
  assert.equal(validation.issues.some((issue) => issue.includes("defines verifier_profile but is not a verify task")), true);
  assert.equal(validation.issues.some((issue) => issue.includes("defines verifier_agent_id but is not a verify task")), true);
  assert.equal(validation.issues.some((issue) => issue.includes("unsupported verifier_profile")), true);
});

test("workflow execution support allows advanced finish_when modes in milestone C", () => {
  const plan = parseWorkflowPlan({
    id: "wf_finish_modes",
    strategy: "finish_modes",
    summary: "Support any_of in runtime.",
    tasks: [
      {
        id: "t1",
        title: "Read source",
        kind: "read",
        role: "worker",
        instruction: "Read source.txt.",
        allowed_tools: ["read_file"],
        depends_on: [],
        required: true,
      },
      {
        id: "t2",
        title: "Read backup",
        kind: "read",
        role: "worker",
        instruction: "Read backup.txt.",
        allowed_tools: ["read_file"],
        depends_on: [],
        required: true,
      },
    ],
    finish_when: {
      mode: "any_of",
      task_ids: ["t1", "t2"],
    },
  });

  assert.ok(plan);
  const support = assessWorkflowExecutionSupport(plan!);
  assert.equal(support.supported, true);
  assert.deepEqual(support.issues, []);
});
