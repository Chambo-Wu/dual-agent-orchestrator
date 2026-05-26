import type { VerificationResult } from "./types.js";

type PlannerDecisionTextInput = {
  decision_text?: string;
  final_answer?: string;
  clarification_question?: string;
  next_step?: string;
  reasoning_summary?: string;
};

type ExecutorTextInput = {
  display_summary?: string;
  summary?: string;
  raw_result?: string;
  error?: string;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getPlannerDecisionText(output: PlannerDecisionTextInput): string {
  return output.decision_text?.trim()
    || output.final_answer?.trim()
    || output.clarification_question?.trim()
    || output.next_step?.trim()
    || output.reasoning_summary?.trim()
    || "";
}

export function getExecutorDisplaySummary(output: ExecutorTextInput): string {
  return trimmed(output.display_summary)
    || trimmed(output.summary)
    || trimmed(output.raw_result)
    || trimmed(output.error)
    || "";
}

export function getExecutorDecisionText(output: ExecutorTextInput): string {
  return trimmed(output.summary)
    || trimmed(output.raw_result)
    || trimmed(output.error)
    || "";
}

export function verificationPassed(result: VerificationResult): boolean {
  return result.status === "verified";
}

export function summarizeVerification(result: VerificationResult): string {
  if (result.checks.length > 0) {
    return result.checks
      .map((check) => `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`)
      .join("\n");
  }
  return result.summary.trim();
}
