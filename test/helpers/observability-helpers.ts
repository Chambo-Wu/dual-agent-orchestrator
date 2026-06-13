import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import assert from "node:assert/strict";
import { persistJobRecord } from "../../src/job-store.js";
import { appendEvent } from "../../src/job-event-bus.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";
import { createUiEvent } from "../../src/workflow-ui-events.js";
import { buildMinimalConfig } from "./fake-runtime.js";

export { buildMinimalConfig };

export class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, number | string | string[]>();
  body = "";

  setHeader(name: string, value: number | string | string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  write(chunk: unknown): boolean {
    this.body += String(chunk);
    return true;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) {
      this.body += String(chunk);
    }
    this.emit("finish");
    return this;
  }
}

export function buildAuthorizedRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {
      authorization: "Bearer dual-agent-local",
    },
  } as IncomingMessage;
}

export function buildAuthorizedJsonRequest(method: "POST", url: string, body: unknown): IncomingMessage {
  const request = new EventEmitter() as IncomingMessage & EventEmitter;
  request.method = method;
  request.url = url;
  request.headers = {
    authorization: "Bearer dual-agent-local",
    "content-type": "application/json",
  };
  process.nextTick(() => {
    request.emit("data", JSON.stringify(body));
    request.emit("end");
  });
  return request;
}

export function findCandidateManifestPath(payload: {
  candidate_path?: string;
  proposal?: {
    targetFiles?: string[];
  };
}): string {
  const target = payload.proposal?.targetFiles?.find((item) => item.endsWith("/skill.json") || item.endsWith("\\skill.json"));
  assert.equal(typeof payload.candidate_path, "string");
  assert.equal(typeof target, "string");
  return join(payload.candidate_path!, target!);
}

export function persistObservabilityJob(jobId: string, goal: string): void {
  persistObservabilityJobWithOptions(jobId, goal);
}

export function persistObservabilityJobWithOptions(
  jobId: string,
  goal: string,
  options: {
    jobStatus?: "completed" | "failed" | "blocked";
    verified?: boolean;
    verificationStatus?: "verified" | "insufficient" | "failed";
    verificationSummary?: string;
    failedCheckNames?: string[];
    missingRequirements?: string[];
    taskAttempts?: number;
    includeArtifact?: boolean;
    includeRelatedEvent?: boolean;
  } = {},
): void {
  const taskRun = createTaskRunRecord({
    id: `${jobId}_task`,
    title: "Inspect repository entrypoints",
    description: goal,
    status: "completed",
    verified: options.verified ?? true,
    output: "Located the relevant files and symbols.",
    attempts: options.taskAttempts ?? 1,
    artifacts: [],
  });
  const verificationStatus = options.verificationStatus ?? "verified";
  const failedCheckNames = options.failedCheckNames ?? [];
  const missingRequirements = options.missingRequirements ?? [];
  const skillVerifyTaskRun = createTaskRunRecord({
    id: `${jobId}_plan__skill_verify`,
    title: "Verify Code Symbol Discovery",
    description: "Verify skill artifacts.",
    status: "completed",
    verified: verificationStatus === "verified",
    output: options.verificationSummary ?? (verificationStatus === "verified"
      ? "Skill verification satisfied."
      : verificationStatus === "insufficient"
        ? "Skill verification still needs more evidence."
        : "Skill verification failed."),
    attempts: 1,
    artifacts: [],
    verificationResult: {
      status: verificationStatus,
      summary: options.verificationSummary ?? (verificationStatus === "verified"
        ? "Skill verification satisfied."
        : verificationStatus === "insufficient"
          ? "Skill verification still needs more evidence."
          : "Skill verification failed."),
      checks: failedCheckNames.length > 0
        ? failedCheckNames.map((name) => ({
          name,
          passed: false,
          status: verificationStatus === "failed" ? "failed" : "insufficient",
          detail: `Verification check ${name} is not satisfied.`,
        }))
        : [{
          name: "artifact_presence",
          passed: verificationStatus === "verified",
          status: verificationStatus === "verified" ? "passed" : verificationStatus,
          detail: verificationStatus === "verified"
            ? "Required skill artifacts are present."
            : "Required skill artifacts are missing or incomplete.",
        }],
    },
  });
  const selectedSkill = {
    skill_id: "find.code_symbol",
    skill_action: "use_installed" as const,
    skill_reason: "The request needs repository symbol discovery before editing.",
    skill_install_status: "installed" as const,
  };
  const candidateSkills = [{
    skillId: "find.code_symbol",
    score: 0.98,
    reasons: ["The request needs repository symbol discovery before editing."],
    source: "rule" as const,
  }];
  const plan = createPlanRecord({
    id: `${jobId}_plan`,
    goal,
    mode: "task",
    taskRunIds: [taskRun.id, skillVerifyTaskRun.id],
    summary: "Observability-focused task plan.",
    intentRoute: {
      kind: "coding",
      reason: "matched engineering language",
      source: "heuristic",
    },
    candidateSkills,
    selectedSkill,
  });
  const job = createJobRecord({
    id: jobId,
    goal,
    mode: "task",
    status: options.jobStatus ?? "completed",
    verified: options.verified ?? verificationStatus === "verified",
    output: "done",
    plan,
    taskRuns: [taskRun, skillVerifyTaskRun],
    artifacts: options.includeArtifact === false
      ? []
      : [{
        id: `${jobId}_artifact`,
        type: "text",
        contentPreview: "Relevant symbol hits for verification.",
        source: "task_run",
        trustLevel: "medium",
        sourceTaskRunId: taskRun.id,
        relatedTaskRunId: taskRun.id,
        relatedStep: 1,
      }],
    verificationResult: {
      status: verificationStatus,
      summary: options.verificationSummary ?? (verificationStatus === "verified"
        ? "Skill verification satisfied."
        : verificationStatus === "insufficient"
          ? "Skill verification still needs more evidence."
          : "Skill verification failed."),
      checks: failedCheckNames.length > 0
        ? failedCheckNames.map((name) => ({
          name,
          passed: false,
          status: verificationStatus === "failed" ? "failed" : "insufficient",
          detail: `Verification check ${name} is not satisfied.`,
        }))
        : [{
          name: "artifact_presence",
          passed: verificationStatus === "verified",
          status: verificationStatus === "verified" ? "passed" : verificationStatus,
          detail: verificationStatus === "verified"
            ? "Required skill artifacts are present."
            : "Required skill artifacts are missing or incomplete.",
        }],
    },
    intentRoute: plan.intentRoute,
    candidateSkills,
    selectedSkill,
  });
  persistJobRecord({
    job,
    plan,
    taskRuns: [taskRun, skillVerifyTaskRun],
    artifacts: job.artifacts,
  });
  if (options.includeRelatedEvent !== false) {
    appendEvent(createUiEvent({
      jobId,
      seq: 1,
      agent: "planner",
      phase: "decision",
      type: "planner.decision",
      title: "Planner decision recorded",
      summary: "Selected the repository discovery skill.",
      status: "running",
      taskRunId: taskRun.id,
      meta: {
        selected_skill: "find.code_symbol",
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
        skill_install_status: "installed",
        skill_reason: "The request needs repository symbol discovery before editing.",
        candidate_skills: [{
          skillId: "find.code_symbol",
          score: 0.98,
          reasons: ["The request needs repository symbol discovery before editing."],
          source: "rule",
        }],
      },
    }));
  }
}
