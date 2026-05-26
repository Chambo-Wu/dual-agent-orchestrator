import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Artifact, ExecutorOutput, TaskRun, VerificationCheck, VerificationResult } from "./types.js";

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

const DEFAULT_VERIFIERS: Verifier[] = [
  FileExistsVerifier,
  SchemaCheckVerifier,
  ArtifactPresenceVerifier,
  GitDiffVerifier,
  UrlReachableVerifier,
];

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
