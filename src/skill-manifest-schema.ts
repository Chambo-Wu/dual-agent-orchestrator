import type { SkillManifest } from "./skill-types.js";

const VALID_SKILL_INTENTS = new Set([
  "find",
  "research",
  "coding",
  "data_analysis",
  "file_ops",
  "goal_planning",
]);

const VALID_SKILL_INSTALL_SOURCES = new Set([
  "builtin",
  "local_dir",
  "git",
  "package",
]);

const VALID_SKILL_EXECUTION_STRATEGIES = new Set([
  "prompt_template",
  "workflow_template",
  "custom_runtime",
]);

const VALID_ACTIVATION_MODES = new Set([
  "always",
  "intent_match",
  "planner_selected",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validateStringMap(value: unknown, fieldName: string, issues: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    issues.push(`${fieldName} must be an object of non-empty strings.`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) {
      issues.push(`${fieldName} contains an empty key.`);
    }
    if (!isNonEmptyString(entry)) {
      issues.push(`${fieldName}.${key} must be a non-empty string.`);
    }
  }
}

function validateVerification(value: unknown, issues: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    issues.push("verification must be an object.");
    return;
  }
  if (value.requiredArtifacts !== undefined && !isStringArray(value.requiredArtifacts)) {
    issues.push("verification.requiredArtifacts must be a non-empty string array when provided.");
  }
  if (value.successSignal !== undefined && !isNonEmptyString(value.successSignal)) {
    issues.push("verification.successSignal must be a non-empty string when provided.");
  }
  if (value.successSignalLabel !== undefined && !isNonEmptyString(value.successSignalLabel)) {
    issues.push("verification.successSignalLabel must be a non-empty string when provided.");
  }
  validateStringMap(value.artifactLabels, "verification.artifactLabels", issues);
  if (value.remediation !== undefined) {
    if (!isRecord(value.remediation)) {
      issues.push("verification.remediation must be an object.");
    } else {
      if (value.remediation.insufficient !== undefined && !isNonEmptyString(value.remediation.insufficient)) {
        issues.push("verification.remediation.insufficient must be a non-empty string when provided.");
      }
      if (value.remediation.failed !== undefined && !isNonEmptyString(value.remediation.failed)) {
        issues.push("verification.remediation.failed must be a non-empty string when provided.");
      }
      for (const key of Object.keys(value.remediation)) {
        if (key !== "insufficient" && key !== "failed") {
          issues.push(`verification.remediation contains unsupported key: ${key}`);
        }
      }
    }
  }
  if (isRecord(value.artifactLabels) && Array.isArray(value.requiredArtifacts)) {
    for (const key of Object.keys(value.artifactLabels)) {
      if (!value.requiredArtifacts.includes(key)) {
        issues.push(`verification.artifactLabels.${key} does not match any requiredArtifacts entry.`);
      }
    }
  }
}

export function validateSkillManifestShape(manifest: SkillManifest): string[] {
  const issues: string[] = [];

  if (!isNonEmptyString(manifest.id)) issues.push("id must be a non-empty string.");
  if (!isNonEmptyString(manifest.version)) issues.push("version must be a non-empty string.");
  if (!isNonEmptyString(manifest.title)) issues.push("title must be a non-empty string.");
  if (!isNonEmptyString(manifest.description)) issues.push("description must be a non-empty string.");
  if (!Array.isArray(manifest.intents) || manifest.intents.length === 0) {
    issues.push("intents must be a non-empty array.");
  } else if (manifest.intents.some((intent) => !VALID_SKILL_INTENTS.has(intent))) {
    issues.push("intents contains unsupported values.");
  }
  if (!isStringArray(manifest.keywords)) issues.push("keywords must be a non-empty string array.");
  if (!isStringArray(manifest.requiredTools)) issues.push("requiredTools must be a non-empty string array.");
  if (manifest.optionalTools !== undefined && !isStringArray(manifest.optionalTools)) {
    issues.push("optionalTools must be a non-empty string array when provided.");
  }

  if (!isRecord(manifest.install)) {
    issues.push("install must be an object.");
  } else {
    if (!VALID_SKILL_INSTALL_SOURCES.has(manifest.install.source)) {
      issues.push("install.source is unsupported.");
    }
    if (!isNonEmptyString(manifest.install.location)) {
      issues.push("install.location must be a non-empty string.");
    }
  }

  if (!isRecord(manifest.activation)) {
    issues.push("activation must be an object.");
  } else {
    if (!VALID_ACTIVATION_MODES.has(manifest.activation.mode)) {
      issues.push("activation.mode is unsupported.");
    }
    if (typeof manifest.activation.priority !== "number") {
      issues.push("activation.priority must be a number.");
    }
  }

  if (!isRecord(manifest.execution)) {
    issues.push("execution must be an object.");
  } else {
    if (!VALID_SKILL_EXECUTION_STRATEGIES.has(manifest.execution.strategy)) {
      issues.push("execution.strategy is unsupported.");
    }
    if (manifest.execution.strategy === "workflow_template" && !isNonEmptyString(manifest.execution.templateId)) {
      issues.push("execution.templateId must be provided for workflow_template skills.");
    }
    if (manifest.execution.strategy === "custom_runtime" && !isNonEmptyString(manifest.execution.runtimeEntry)) {
      issues.push("execution.runtimeEntry must be provided for custom_runtime skills.");
    }
  }

  validateVerification(manifest.verification, issues);
  return issues;
}
