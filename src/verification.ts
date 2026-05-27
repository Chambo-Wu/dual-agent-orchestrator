import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { parseModelJson } from "./json.js";
import type { Artifact, ExecutorOutput, ModelConfig, RunOptions, TaskRun, VerificationCheck, VerificationResult } from "./types.js";

export interface VerificationContext {
  jobId: string;
  goal: string;
  executorHistory: ExecutorOutput[];
  artifacts: Artifact[];
  taskRuns: TaskRun[];
  workspaceRoot: string;
  runtimeRoot: string;
  acceptance?: {
    minimumArtifactCount?: number;
    requiredArtifactType?: Artifact["type"];
    requiredSchema?: "json";
  };
}

export interface Verifier {
  name: string;
  verify(context: VerificationContext): Promise<VerificationCheck>;
}

type ModelVerifierResponse = {
  passed?: boolean;
  summary?: string;
  concerns?: string[];
};

const FileExistsVerifier: Verifier = {
  name: "file_exists",
  async verify(context) {
    const fileArtifacts = context.artifacts.filter((a) => a.type === "file" && a.path);
    const relatedArtifactIds = fileArtifacts.map((artifact) => artifact.id);
    if (fileArtifacts.length === 0) {
      return { name: "file_exists", passed: true, detail: "No file artifacts to check." };
    }
    const missing = fileArtifacts.filter((a) => !existsSync(a.path!));
    if (missing.length > 0) {
      return {
        name: "file_exists",
        passed: false,
        detail: `Missing files: ${missing.map((a) => a.path).join(", ")}`,
        relatedArtifactIds: missing.map((artifact) => artifact.id),
      };
    }
    return { name: "file_exists", passed: true, detail: `All ${fileArtifacts.length} file artifacts exist.`, relatedArtifactIds };
  },
};

const SchemaCheckVerifier: Verifier = {
  name: "schema_check",
  async verify(context) {
    const jsonArtifacts = context.artifacts.filter((a) => {
      if (a.type !== "json" || !a.path || !existsSync(a.path)) {
        return false;
      }
      try {
        return statSync(a.path).isFile();
      } catch {
        return false;
      }
    });
    const relatedArtifactIds = jsonArtifacts.map((artifact) => artifact.id);
    if (jsonArtifacts.length === 0) {
      return { name: "schema_check", passed: true, detail: "No JSON artifacts to check." };
    }
    const errors: string[] = [];
    for (const artifact of jsonArtifacts) {
      try {
        if (existsSync(artifact.path!)) {
          const content = readFileSync(artifact.path!, "utf8");
          JSON.parse(content);
        }
      } catch (e) {
        errors.push(`${artifact.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (errors.length > 0) {
      return { name: "schema_check", passed: false, detail: `Invalid JSON: ${errors.join("; ")}`, relatedArtifactIds };
    }
    return { name: "schema_check", passed: true, detail: `All ${jsonArtifacts.length} JSON artifacts are valid.`, relatedArtifactIds };
  },
};

const ArtifactPresenceVerifier: Verifier = {
  name: "artifact_presence",
  async verify(context) {
    if (context.artifacts.length === 0) {
      const hasNativeTools = context.executorHistory.some((h) => h.tool_calls_made.length > 0);
      if (hasNativeTools) {
        return {
          name: "artifact_presence",
          passed: false,
          status: "insufficient",
          detail: "Tool calls were made but no artifacts were produced.",
          relatedArtifactIds: [],
        };
      }
      return { name: "artifact_presence", passed: true, detail: "No tools used, no artifacts expected." };
    }
    const emptyPreviews = context.artifacts.filter((a) => !a.contentPreview || a.contentPreview.trim() === "");
    if (emptyPreviews.length === context.artifacts.length) {
      return {
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "All artifacts have empty previews.",
        relatedArtifactIds: emptyPreviews.map((artifact) => artifact.id),
      };
    }
    return { name: "artifact_presence", passed: true, detail: `${context.artifacts.length} artifacts present with content.`, relatedArtifactIds: context.artifacts.map((artifact) => artifact.id) };
  },
};

const GitDiffVerifier: Verifier = {
  name: "git_diff",
  async verify(context) {
    try {
      const result = spawnSync("git", ["diff", "--stat"], {
        cwd: context.workspaceRoot,
        encoding: "utf8",
        timeout: 5000,
      });
      const output = (result.stdout || "").trim();
      if (!output) {
        return { name: "git_diff", passed: true, detail: "No file changes detected in workspace." };
      }
      const changedFiles = output.split("\n").filter((l) => l.trim()).length;
      return { name: "git_diff", passed: true, detail: `${changedFiles} file(s) changed in workspace.` };
    } catch {
      return { name: "git_diff", passed: true, detail: "Git not available, skipping diff check." };
    }
  },
};

const UrlReachableVerifier: Verifier = {
  name: "url_reachable",
  async verify(context) {
    const urlArtifacts = context.artifacts.filter((a) => a.type === "json" && a.contentPreview.includes("http"));
    const relatedArtifactIds = urlArtifacts.map((artifact) => artifact.id);
    if (urlArtifacts.length === 0) {
      return { name: "url_reachable", passed: true, detail: "No URL artifacts to check." };
    }
    return { name: "url_reachable", passed: true, detail: `Skipped URL reachability check for ${urlArtifacts.length} artifacts.`, relatedArtifactIds };
  },
};

const AcceptanceCriteriaVerifier: Verifier = {
  name: "acceptance_criteria",
  async verify(context) {
    const acceptance = context.acceptance;
    if (!acceptance) {
      return { name: "acceptance_criteria", passed: true, detail: "No explicit acceptance criteria to check." };
    }

    const issues: string[] = [];
    const relatedArtifactIds = new Set<string>();
    const minimumArtifactCount = acceptance.minimumArtifactCount;
    if (minimumArtifactCount !== undefined && context.artifacts.length < minimumArtifactCount) {
      issues.push(`Expected at least ${minimumArtifactCount} artifact(s), found ${context.artifacts.length}.`);
    }

    if (acceptance.requiredArtifactType) {
      const matchingArtifacts = context.artifacts.filter((artifact) => artifact.type === acceptance.requiredArtifactType);
      matchingArtifacts.forEach((artifact) => relatedArtifactIds.add(artifact.id));
      if (matchingArtifacts.length === 0) {
        issues.push(`Expected at least one ${acceptance.requiredArtifactType} artifact.`);
      }
    }

    if (acceptance.requiredSchema === "json") {
      const jsonArtifacts = context.artifacts.filter((artifact) => artifact.type === "json");
      jsonArtifacts.forEach((artifact) => relatedArtifactIds.add(artifact.id));
      if (jsonArtifacts.length === 0) {
        issues.push("Expected at least one JSON artifact for required_schema=json.");
      }
    }

    if (issues.length > 0) {
      return {
        name: "acceptance_criteria",
        passed: false,
        status: "insufficient",
        detail: issues.join(" "),
        relatedArtifactIds: [...relatedArtifactIds],
      };
    }
    return { name: "acceptance_criteria", passed: true, detail: "Explicit acceptance criteria satisfied.", relatedArtifactIds: [...relatedArtifactIds] };
  },
};

export const DEFAULT_VERIFIERS: Verifier[] = [
  FileExistsVerifier,
  SchemaCheckVerifier,
  ArtifactPresenceVerifier,
  GitDiffVerifier,
  UrlReachableVerifier,
  AcceptanceCriteriaVerifier,
];

function truncateForVerifier(value: string, limit = 1200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

function buildModelVerifierMessages(context: VerificationContext): ChatMessage[] {
  const taskSummary = context.taskRuns.map((taskRun) => ({
    id: taskRun.id,
    title: taskRun.title,
    status: taskRun.status,
    assignee: taskRun.assignee,
    verified: taskRun.verified,
    output: truncateForVerifier(taskRun.output, 800),
    artifact_count: taskRun.artifacts.length,
  }));
  const artifactSummary = context.artifacts.slice(0, 12).map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    trustLevel: artifact.trustLevel,
    preview: truncateForVerifier(artifact.contentPreview, 600),
  }));

  return [
    {
      role: "system",
      content: "You are a strict verifier. Decide whether the task result is sufficiently supported by the provided task outputs and artifacts. Output only valid JSON.",
    },
    {
      role: "user",
      content: JSON.stringify({
        required_schema: {
          passed: "boolean",
          summary: "short explanation",
          concerns: ["optional list of concerns"],
        },
        goal: context.goal,
        task_runs: taskSummary,
        artifacts: artifactSummary,
      }, null, 2),
    },
  ];
}

export function createModelVerifier(
  model: ModelConfig,
  options?: {
    runChat?: typeof runChatCompletionDetailed;
    runOptions?: RunOptions;
  },
): Verifier {
  return {
    name: "model_verifier",
    async verify(context) {
      const runner = options?.runChat ?? runChatCompletionDetailed;
      const response = await runner(model, buildModelVerifierMessages(context), undefined, options?.runOptions);
      const raw = response.content || response.reasoning || "";
      const parsed = parseModelJson<ModelVerifierResponse>(raw);
      const passed = parsed.passed === true;
      const summary = typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : passed
          ? "Model verifier approved the result."
          : "Model verifier rejected the result.";
      const concerns = Array.isArray(parsed.concerns)
        ? parsed.concerns.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      return {
        name: "model_verifier",
        passed,
        detail: concerns.length > 0 ? `${summary} Concerns: ${concerns.join("; ")}` : summary,
      };
    },
  };
}

export async function runVerifiers(
  context: VerificationContext,
  verifiers?: Verifier[],
): Promise<VerificationResult> {
  const activeVerifiers = verifiers ?? DEFAULT_VERIFIERS;
  const checks = await Promise.all(
    activeVerifiers.map((v) =>
      v.verify(context).catch((err) => ({
        name: v.name,
        passed: false,
        status: "failed" as const,
        detail: `Verifier error: ${err instanceof Error ? err.message : String(err)}`,
      })),
    ),
  );
  const failedChecks = checks.filter((check) => !check.passed);
  const insufficientChecks = failedChecks.filter((check) => check.status === "insufficient");
  const hardFailedChecks = failedChecks.filter((check) => check.status !== "insufficient");
  const status: VerificationResult["status"] = hardFailedChecks.length > 0
    ? "failed"
    : insufficientChecks.length > 0
      ? "insufficient"
      : "verified";
  return {
    status,
    summary: failedChecks.length === 0
      ? "Verification completed successfully."
      : failedChecks.map((check) => `${check.name}: ${check.detail}`).join("; "),
    checks,
  };
}

export function verificationPassed(result: VerificationResult): boolean {
  return result.status === "verified";
}
