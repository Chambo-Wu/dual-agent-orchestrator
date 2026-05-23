import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Artifact, ExecutorOutput, TaskRun } from "./types.js";

export interface VerificationResult {
  passed: boolean;
  verifier: string;
  message: string;
}

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
  verify(context: VerificationContext): Promise<VerificationResult>;
}

const FileExistsVerifier: Verifier = {
  name: "file_exists",
  async verify(context) {
    const fileArtifacts = context.artifacts.filter((a) => a.type === "file" && a.path);
    if (fileArtifacts.length === 0) {
      return { passed: true, verifier: "file_exists", message: "No file artifacts to check." };
    }
    const missing = fileArtifacts.filter((a) => !existsSync(a.path!));
    if (missing.length > 0) {
      return {
        passed: false,
        verifier: "file_exists",
        message: `Missing files: ${missing.map((a) => a.path).join(", ")}`,
      };
    }
    return { passed: true, verifier: "file_exists", message: `All ${fileArtifacts.length} file artifacts exist.` };
  },
};

const SchemaCheckVerifier: Verifier = {
  name: "schema_check",
  async verify(context) {
    const jsonArtifacts = context.artifacts.filter((a) => a.type === "json" && a.path);
    if (jsonArtifacts.length === 0) {
      return { passed: true, verifier: "schema_check", message: "No JSON artifacts to check." };
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
      return { passed: false, verifier: "schema_check", message: `Invalid JSON: ${errors.join("; ")}` };
    }
    return { passed: true, verifier: "schema_check", message: `All ${jsonArtifacts.length} JSON artifacts are valid.` };
  },
};

const ArtifactPresenceVerifier: Verifier = {
  name: "artifact_presence",
  async verify(context) {
    if (context.artifacts.length === 0) {
      const hasNativeTools = context.executorHistory.some((h) => h.tool_calls_made.length > 0);
      if (hasNativeTools) {
        return { passed: false, verifier: "artifact_presence", message: "Tool calls were made but no artifacts were produced." };
      }
      return { passed: true, verifier: "artifact_presence", message: "No tools used, no artifacts expected." };
    }
    const emptyPreviews = context.artifacts.filter((a) => !a.contentPreview || a.contentPreview.trim() === "");
    if (emptyPreviews.length === context.artifacts.length) {
      return { passed: false, verifier: "artifact_presence", message: "All artifacts have empty previews." };
    }
    return { passed: true, verifier: "artifact_presence", message: `${context.artifacts.length} artifacts present with content.` };
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
        return { passed: true, verifier: "git_diff", message: "No file changes detected in workspace." };
      }
      const changedFiles = output.split("\n").filter((l) => l.trim()).length;
      return { passed: true, verifier: "git_diff", message: `${changedFiles} file(s) changed in workspace.` };
    } catch {
      return { passed: true, verifier: "git_diff", message: "Git not available, skipping diff check." };
    }
  },
};

const UrlReachableVerifier: Verifier = {
  name: "url_reachable",
  async verify(context) {
    const urlArtifacts = context.artifacts.filter((a) => a.type === "json" && a.contentPreview.includes("http"));
    if (urlArtifacts.length === 0) {
      return { passed: true, verifier: "url_reachable", message: "No URL artifacts to check." };
    }
    return { passed: true, verifier: "url_reachable", message: `Skipped URL reachability check for ${urlArtifacts.length} artifacts.` };
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
): Promise<VerificationResult[]> {
  const activeVerifiers = verifiers ?? DEFAULT_VERIFIERS;
  return Promise.all(
    activeVerifiers.map((v) =>
      v.verify(context).catch((err) => ({
        passed: false,
        verifier: v.name,
        message: `Verifier error: ${err instanceof Error ? err.message : String(err)}`,
      })),
    ),
  );
}

export function verificationPassed(results: VerificationResult[]): boolean {
  return results.every((r) => r.passed);
}
