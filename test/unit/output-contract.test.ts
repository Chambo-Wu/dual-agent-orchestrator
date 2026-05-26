import test from "node:test";
import assert from "node:assert/strict";
import {
  getExecutorDecisionText,
  getExecutorDisplaySummary,
  getPlannerDecisionText,
  summarizeVerification,
  verificationPassed,
} from "../../src/output-contract.js";
import type { ExecutorOutput, PlannerOutput, VerificationResult } from "../../src/types.js";

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
