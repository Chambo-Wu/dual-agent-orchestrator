export type FailureCategory =
  | "tool_failure"
  | "model_failure"
  | "validation_failure"
  | "verification_failure"
  | "approval_blocked"
  | "environment_failure"
  | "unknown_failure";

type FailureCategoryDefinition = {
  code: FailureCategory;
  label: string;
  title: string;
  description: string;
};

const FAILURE_CATEGORY_DEFINITIONS: Record<FailureCategory, FailureCategoryDefinition> = {
  tool_failure: {
    code: "tool_failure",
    label: "Tool failure",
    title: "Tool execution issue",
    description: "A tool call failed, was unavailable, or returned an execution error.",
  },
  model_failure: {
    code: "model_failure",
    label: "Model failure",
    title: "Model or generation issue",
    description: "The planner or executor returned an upstream/model-side failure or unusable output.",
  },
  validation_failure: {
    code: "validation_failure",
    label: "Validation failure",
    title: "Input or schema issue",
    description: "A request, plan, or payload failed validation, parsing, or schema checks.",
  },
  verification_failure: {
    code: "verification_failure",
    label: "Verification failure",
    title: "Verification issue",
    description: "Verifier checks found missing evidence, invalid artifacts, or failed acceptance criteria.",
  },
  approval_blocked: {
    code: "approval_blocked",
    label: "Approval blocked",
    title: "Waiting on approval",
    description: "The workflow is paused until an approval request is resolved.",
  },
  environment_failure: {
    code: "environment_failure",
    label: "Environment failure",
    title: "Runtime or environment issue",
    description: "Runtime state, workspace, config, or service availability blocked execution.",
  },
  unknown_failure: {
    code: "unknown_failure",
    label: "Unknown failure",
    title: "Unclassified issue",
    description: "Execution failed, but the failure did not match a more specific category yet.",
  },
};

export function getFailureCategoryDefinition(category: FailureCategory): FailureCategoryDefinition {
  return FAILURE_CATEGORY_DEFINITIONS[category];
}

export function getFailureCategoryLabel(category: FailureCategory | string | null | undefined): string {
  if (!category || !(category in FAILURE_CATEGORY_DEFINITIONS)) {
    return "Unknown failure";
  }
  return FAILURE_CATEGORY_DEFINITIONS[category as FailureCategory].label;
}

export function getFailureCategoryTitle(category: FailureCategory | string | null | undefined): string {
  if (!category || !(category in FAILURE_CATEGORY_DEFINITIONS)) {
    return "Unclassified issue";
  }
  return FAILURE_CATEGORY_DEFINITIONS[category as FailureCategory].title;
}

export function listFailureCategories(): FailureCategoryDefinition[] {
  return Object.values(FAILURE_CATEGORY_DEFINITIONS);
}

type FailureClassificationInput = {
  type?: string;
  status?: string;
  summary?: string;
  error?: string;
  tool?: string;
  verificationStatus?: string;
  recoveryReason?: string;
};

function normalizedText(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" | ")
    .toLowerCase();
}

export function classifyFailure(input: FailureClassificationInput): FailureCategory | null {
  const type = input.type?.toLowerCase() ?? "";
  const tool = input.tool?.trim();
  const status = input.status?.toLowerCase() ?? "";
  const text = normalizedText(input.summary, input.error, input.recoveryReason, input.verificationStatus, type);

  if (status === "success" || status === "completed") {
    return null;
  }

  if (
    type.includes("approval")
    || text.includes("awaiting approval")
    || text.includes("approval denied")
    || text.includes("resolve it through /approve")
  ) {
    return "approval_blocked";
  }

  if (
    type.includes("verification")
    || input.verificationStatus === "failed"
    || text.includes("verification failed")
    || text.includes("verification reported issues")
    || text.includes("verifier error")
  ) {
    return "verification_failure";
  }

  if (
    type.includes("plan.rejected")
    || text.includes("validation failed")
    || text.includes("invalid json")
    || text.includes("schema")
    || text.includes("invalid request")
    || text.includes("planner did not return workflow plan")
    || text.includes("approval not found")
    || text.includes("required")
    || text.includes("must be ")
    || text.includes("cannot resume a completed job")
    || text.includes("route not found")
  ) {
    return "validation_failure";
  }

  if (
    input.recoveryReason
    || text.includes("service restart")
    || text.includes("runtime limit")
    || text.includes("not executable in the current runtime")
    || text.includes("workspace")
    || text.includes("config")
    || text.includes("temporarily unavailable")
    || text.includes("retry shortly")
    || text.includes("currently running")
  ) {
    return "environment_failure";
  }

  if (
    tool
    || type.includes("tool.")
    || text.includes("tool \"")
    || text.includes("unknown tool")
    || text.includes("not registered")
    || text.includes("unsupported")
    || text.includes("http 403")
    || text.includes("fetch failed")
  ) {
    return "tool_failure";
  }

  if (
    type.includes("executor")
    || type.includes("planner")
    || text.includes("model")
    || text.includes("upstream")
    || text.includes("unable to parse executor output as json")
    || text.includes("planner output was not valid json")
    || text.includes("truncated")
  ) {
    return "model_failure";
  }

  if (status === "failed" || status === "blocked" || status === "partial_success") {
    return "unknown_failure";
  }

  return null;
}
