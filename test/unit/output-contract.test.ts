import test from "node:test";
import assert from "node:assert/strict";
import {
  getExecutorDecisionText,
  getExecutorDisplaySummary,
  getPlannerDecisionText,
  summarizeVerification,
  verificationPassed,
} from "../../src/output-contract.js";
import { createModelVerifier, runVerifiers } from "../../src/verification.js";
import type { ExecutorOutput, PlannerOutput, VerificationResult } from "../../src/types.js";
import { buildMinimalConfig, modelResponseFromJson } from "../helpers/fake-runtime.js";

test("planner decision text prefers explicit decision fields over reasoning scaffolding", () => {
  const planner: PlannerOutput = {
    goal: "goal",
    status: "final",
    reasoning_summary: "internal reasoning",
    next_step: "next step",
    audit: { verdict: "approved", notes: "" },
    final_answer: "final answer",
    decision_text: "decision text",
  };

  assert.equal(getPlannerDecisionText(planner), "decision text");
  assert.equal(getPlannerDecisionText({ ...planner, decision_text: undefined }), "final answer");
});

test("executor contract separates display summary from decision text", () => {
  const executor: ExecutorOutput = {
    status: "failed",
    summary: "Decision summary",
    display_summary: "Display summary",
    tool_calls_made: [],
    artifacts: [],
    raw_result: "raw detail",
    error: "error detail",
    source: "model_text",
  };

  assert.equal(getExecutorDisplaySummary(executor), "Display summary");
  assert.equal(getExecutorDecisionText(executor), "Decision summary");
});

test("executor display summary falls back to synthesized summary over tool tail output", async () => {
  const { __testables } = await import("../../src/orchestrator.js");
  const finalized = __testables.finalizeExecutorResult(
    {
      content: JSON.stringify({
        status: "success",
        summary: "Dual Agent Orchestrator is a planner plus executor runtime with OpenAI-compatible and Anthropic-style APIs.",
        raw_result: "Concise project introduction.",
        tool_calls_made: [],
        artifacts: [],
      }),
      reasoning: "",
      toolCalls: [],
      raw: {},
    },
    {
      executedCalls: [
        { tool: "list_files", arguments: { path: "D:\\Android\\dual-agent-orchestrator" } },
        { tool: "read_file", arguments: { path: "D:\\Android\\dual-agent-orchestrator\\README.md" } },
      ],
      artifacts: [],
      lastSummary: "Listed 3 entries in D:\\Android\\dual-agent-orchestrator\\config",
      lastRawResult: "[\"config.yml\",\"example.config.yml\",\"task-routing.yml\"]",
      ok: true,
    },
  );

  assert.equal(
    finalized.summary,
    "Dual Agent Orchestrator is a planner plus executor runtime with OpenAI-compatible and Anthropic-style APIs.",
  );
  assert.equal(finalized.raw_result, "Concise project introduction.");
});

test("contract helpers accept partial event payloads", () => {
  assert.equal(
    getPlannerDecisionText({
      decision_text: "User-facing decision",
      reasoning_summary: "internal reasoning",
      next_step: "next step",
    }),
    "User-facing decision",
  );
  assert.equal(
    getExecutorDisplaySummary({
      display_summary: "Display text",
      summary: "Decision text",
      raw_result: "raw detail",
    }),
    "Display text",
  );
});

test("verification helpers consume structured verification results", () => {
  const failed: VerificationResult = {
    status: "failed",
    summary: "",
    checks: [
      { name: "file_exists", passed: false, detail: "Missing report.md" },
      { name: "artifact_presence", passed: true, detail: "1 artifact present" },
    ],
  };
  const passed: VerificationResult = {
    status: "verified",
    summary: "Verification completed successfully.",
    checks: [
      { name: "file_exists", passed: true, detail: "All files exist" },
    ],
  };

  assert.equal(verificationPassed(failed), false);
  assert.equal(verificationPassed(passed), true);
  assert.equal(summarizeVerification(failed).includes("FAIL file_exists: Missing report.md"), true);
  assert.equal(summarizeVerification(passed), "PASS file_exists: All files exist");
});

test("model verifier maps model JSON approval into a verification check", async () => {
  const config = buildMinimalConfig();
  const modelsSeen: string[] = [];
  const verifier = createModelVerifier(
    {
      ...config.executor,
      model: "verifier-model",
    },
    {
      runChat: async (modelConfig, messages) => {
        modelsSeen.push(modelConfig.model);
        assert.equal(messages.some((message) => message.content.includes("Summarize project")), true);
        return modelResponseFromJson({
          passed: true,
          summary: "The result is supported.",
          concerns: [],
        });
      },
    },
  );

  const check = await verifier.verify({
    jobId: "job_model_verifier_pass",
    goal: "Summarize project",
    executorHistory: [],
    artifacts: [],
    taskRuns: [{
      id: "task_model_verifier_pass",
      title: "Summarize",
      description: "Summarize project",
      status: "completed",
      verified: true,
      output: "Project summary",
      attempts: 1,
      artifacts: [],
      dependsOn: [],
    }],
    workspaceRoot: process.cwd(),
    runtimeRoot: process.cwd(),
  });

  assert.deepEqual(modelsSeen, ["verifier-model"]);
  assert.equal(check.name, "model_verifier");
  assert.equal(check.passed, true);
  assert.equal(check.detail, "The result is supported.");
});

test("model verifier participates in unified verification failure results", async () => {
  const config = buildMinimalConfig();
  const verifier = createModelVerifier(config.executor, {
    runChat: async () => modelResponseFromJson({
      passed: false,
      summary: "The output is not sufficiently supported.",
      concerns: ["No artifact evidence"],
    }),
  });

  const result = await runVerifiers({
    jobId: "job_model_verifier_fail",
    goal: "Summarize project",
    executorHistory: [],
    artifacts: [],
    taskRuns: [{
      id: "task_model_verifier_fail",
      title: "Summarize",
      description: "Summarize project",
      status: "completed",
      verified: true,
      output: "Unsupported summary",
      attempts: 1,
      artifacts: [],
      dependsOn: [],
    }],
    workspaceRoot: process.cwd(),
    runtimeRoot: process.cwd(),
  }, [verifier]);

  assert.equal(result.status, "failed");
  assert.equal(result.checks[0]?.name, "model_verifier");
  assert.equal(result.checks[0]?.passed, false);
  assert.equal(result.summary.includes("No artifact evidence"), true);
});
