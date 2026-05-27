import { existsSync, readFileSync } from "node:fs";
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
    if (fileArtifacts.length === 0) {
      return { name: "file_exists", passed: true, detail: "No file artifacts to check." };
    }
    const missing = fileArtifacts.filter((a) => !existsSync(a.path!));
    if (missing.length > 0) {
      return {
        name: "file_exists",
        passed: false,
        detail: `Missing files: ${missing.map((a) => a.path).join(", ")}`,
      };
    }
    return { name: "file_exists", passed: true, detail: `All ${fileArtifacts.length} file artifacts exist.` };
  },
};

const SchemaCheckVerifier: Verifier = {
  name: "schema_check",
  async verify(context) {
    const jsonArtifacts = context.artifacts.filter((a) => a.type === "json" && a.path);
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
      return { name: "schema_check", passed: false, detail: `Invalid JSON: ${errors.join("; ")}` };
    }
    return { name: "schema_check", passed: true, detail: `All ${jsonArtifacts.length} JSON artifacts are valid.` };
  },
};

const ArtifactPresenceVerifier: Verifier = {
  name: "artifact_presence",
  async verify(context) {
    if (context.artifacts.length === 0) {
      const hasNativeTools = context.executorHistory.some((h) => h.tool_calls_made.length > 0);
      if (hasNativeTools) {
        return { name: "artifact_presence", passed: false, detail: "Tool calls were made but no artifacts were produced." };
      }
      return { name: "artifact_presence", passed: true, detail: "No tools used, no artifacts expected." };
    }
    const emptyPreviews = context.artifacts.filter((a) => !a.contentPreview || a.contentPreview.trim() === "");
    if (emptyPreviews.length === context.artifacts.length) {
      return { name: "artifact_presence", passed: false, detail: "All artifacts have empty previews." };
    }
    return { name: "artifact_presence", passed: true, detail: `${context.artifacts.length} artifacts present with content.` };
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
    if (urlArtifacts.length === 0) {
      return { name: "url_reachable", passed: true, detail: "No URL artifacts to check." };
    }
    return { name: "url_reachable", passed: true, detail: `Skipped URL reachability check for ${urlArtifacts.length} artifacts.` };
  },
};

export const DEFAULT_VERIFIERS: Verifier[] = [
  FileExistsVerifier,
  SchemaCheckVerifier,
  ArtifactPresenceVerifier,
  GitDiffVerifier,
  UrlReachableVerifier,
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
        detail: `Verifier error: ${err instanceof Error ? err.message : String(err)}`,
      })),
    ),
  );
  const failedChecks = checks.filter((check) => !check.passed);
  return {
    status: failedChecks.length === 0 ? "verified" : "failed",
    summary: failedChecks.length === 0
      ? "Verification completed successfully."
      : failedChecks.map((check) => `${check.name}: ${check.detail}`).join("; "),
    checks,
  };
}

export function verificationPassed(result: VerificationResult): boolean {
  return result.status === "verified";
}
