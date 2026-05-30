import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { __testables } from "../../src/index.js";
import { readTimelineUiStateFromUrl, reduceTimelineUiState, renderTimelineHtml, writeTimelineUiStateToUrl } from "../../src/timeline.js";
import { normalizeWorkflowEvent } from "../../src/workflow-ui-events.js";
import { WORKSPACE_ROOT } from "../../src/paths.js";
import type { StoredJobRecord } from "../../src/job-store.js";
import type { Artifact, CandidateSkillSummary, IntentRouteMetadata, Job, Plan, TaskRun } from "../../src/types.js";

const TEST_INTENT_ROUTE: IntentRouteMetadata = {
  kind: "coding",
  reason: "matched engineering language",
  source: "heuristic",
};

const TEST_CANDIDATE_SKILLS: CandidateSkillSummary[] = [{
  skillId: "find.code_symbol",
  score: 0.98,
  reasons: ["Repository symbol lookup is likely needed before editing."],
  source: "rule",
}];

test("claude control messages are short-circuited before orchestration", () => {
  assert.equal(__testables.isClaudeControlMessage("/init"), true);
  assert.equal(__testables.isClaudeControlMessage("<command-message>init</command-message>\n<command-name>/init</command-name>"), true);
  assert.equal(__testables.isClaudeControlMessage("[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]"), true);
  assert.equal(__testables.isClaudeControlMessage("介绍一下这个项目"), false);

  const initResponse = __testables.buildClaudeControlResponse("/init");
  assert.equal(initResponse?.job.status, "completed");
  assert.equal(initResponse?.job.verified, true);
  assert.equal(initResponse?.taskRuns.length, 1);
  assert.equal(initResponse?.content.includes("ready"), true);

  const wrappedInitResponse = __testables.buildClaudeControlResponse("<command-message>init</command-message>\n<command-name>/init</command-name>");
  assert.equal(wrappedInitResponse?.job.status, "completed");
  assert.equal(wrappedInitResponse?.content.includes("ready"), true);

  const suggestionResponse = __testables.buildClaudeControlResponse("[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]");
  assert.equal(suggestionResponse?.job.status, "completed");
  assert.equal(suggestionResponse?.content, "");
});

function buildRecord(taskRuns: TaskRun[]): StoredJobRecord {
  const plan: Plan = {
    id: "plan_workflow_1",
    goal: "Test workflow summary",
    mode: "task",
    taskRunIds: taskRuns.map((taskRun) => taskRun.id),
    summary: "Workflow summary test.",
    intentRoute: TEST_INTENT_ROUTE,
    candidateSkills: TEST_CANDIDATE_SKILLS,
  };
  const job: Job = {
    id: "job_workflow_1",
    goal: "Test workflow summary",
    mode: "task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    plan,
    taskRuns,
    artifacts: [],
    intentRoute: TEST_INTENT_ROUTE,
    candidateSkills: TEST_CANDIDATE_SKILLS,
  };
  return {
    savedAt: new Date().toISOString(),
    job,
    plan,
    taskRuns,
    artifacts: [] as Artifact[],
    control: {
      pendingApprovalId: "appr_1",
      approvalStatus: "pending",
    },
  };
}

test("buildJobResponse includes workflow summary with counts and current approval task", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [],
      attempts: 1,
    },
    {
      id: "task_waiting",
      title: "Approval task",
      description: "await approval",
      status: "awaiting_approval",
      assignee: "worker",
      dependsOn: ["task_done"],
      verified: false,
      output: "Waiting for approval.",
      artifacts: [],
      attempts: 0,
    },
    {
      id: "task_pending",
      title: "Pending task",
      description: "pending",
      status: "pending",
      assignee: "worker",
      dependsOn: ["task_waiting"],
      verified: false,
      output: "",
      artifacts: [],
      attempts: 0,
    },
  ]);

  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      workflow_id: string;
      task_counts: Record<string, number>;
      current_task: Record<string, unknown> | null;
      awaiting_approval_task: Record<string, unknown> | null;
    };
  };

  assert.equal(response.workflow_summary.workflow_id, "plan_workflow_1");
  assert.equal(response.workflow_summary.task_counts.completed, 1);
  assert.equal(response.workflow_summary.task_counts.awaiting_approval, 1);
  assert.equal(response.workflow_summary.task_counts.pending, 1);
  assert.equal(response.workflow_summary.current_task?.id, "task_waiting");
  assert.equal(response.workflow_summary.awaiting_approval_task?.id, "task_waiting");
});

test("buildJobResponse and workflow summary expose unified candidate skills", () => {
  const record = buildRecord([]);
  const response = __testables.buildJobResponse(record) as {
    candidate_skills: CandidateSkillSummary[];
    workflow_summary: {
      candidate_skills: CandidateSkillSummary[];
    };
    job?: {
      candidateSkills?: CandidateSkillSummary[];
    };
    plan?: {
      candidateSkills?: CandidateSkillSummary[];
    };
  };

  assert.equal(response.candidate_skills.length, 1);
  assert.equal(response.candidate_skills[0]?.skillId, "find.code_symbol");
  assert.equal(response.workflow_summary.candidate_skills[0]?.skillId, "find.code_symbol");
  assert.equal(response.job?.candidateSkills?.[0]?.skillId, "find.code_symbol");
  assert.equal(response.plan?.candidateSkills?.[0]?.skillId, "find.code_symbol");
});

test("buildJobResponse exposes skill verification summary from workflow verify task", () => {
  const record = buildRecord([{
    id: "plan_workflow_1__skill_verify",
    title: "Verify Code Symbol Discovery",
    description: "Verify skill artifacts.",
    status: "completed",
    assignee: "verifier",
    dependsOn: [],
    verified: true,
    output: "Skill verification satisfied.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "verified",
      summary: "Skill verification satisfied.",
      checks: [{
        name: "artifact_presence",
        passed: true,
        status: "passed",
        detail: "Required skill artifacts are present.",
      }],
    },
  }]);
  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      skill_verification?: {
        skill_id?: string | null;
        skill_title?: string | null;
        title?: string;
        verification_status?: string;
        verification_label?: string;
        action_required?: boolean;
        summary?: string | null;
        outcome_summary?: string | null;
        next_action?: string | null;
        required_artifacts?: string[];
        success_signal_label?: string | null;
        check_count?: number;
        failed_check_names?: string[];
        missing_requirements?: string[];
      } | null;
    };
  };

  assert.equal(response.workflow_summary.skill_verification?.skill_id, null);
  assert.equal(response.workflow_summary.skill_verification?.skill_title, null);
  assert.equal(response.workflow_summary.skill_verification?.title, "Verify Code Symbol Discovery");
  assert.equal(response.workflow_summary.skill_verification?.verification_status, "verified");
  assert.equal(response.workflow_summary.skill_verification?.verification_label, "Verified");
  assert.equal(response.workflow_summary.skill_verification?.action_required, false);
  assert.equal(response.workflow_summary.skill_verification?.summary, "Skill verification satisfied.");
  assert.equal(response.workflow_summary.skill_verification?.outcome_summary, "Skill verification satisfied.");
  assert.equal(response.workflow_summary.skill_verification?.next_action, null);
  assert.deepEqual(response.workflow_summary.skill_verification?.required_artifacts, []);
  assert.equal(response.workflow_summary.skill_verification?.success_signal_label, null);
  assert.equal(response.workflow_summary.skill_verification?.check_count, 1);
  assert.deepEqual(response.workflow_summary.skill_verification?.failed_check_names, []);
  assert.deepEqual(response.workflow_summary.skill_verification?.missing_requirements, []);
});

test("buildJobResponse exposes reusable skill outcome summary when a selected skill exists", () => {
  const record = buildRecord([{
    id: "plan_workflow_1__skill_verify",
    title: "Verify Code Symbol Discovery",
    description: "Verify skill artifacts.",
    status: "completed",
    assignee: "verifier",
    dependsOn: [],
    verified: true,
    output: "Skill verification satisfied.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "verified",
      summary: "Skill verification satisfied.",
      checks: [{
        name: "artifact_presence",
        passed: true,
        status: "passed",
        detail: "Required skill artifacts are present.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.code_symbol",
    skill_action: "use_installed",
    skill_reason: "Need repository discovery first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;
  record.job.status = "completed";
  record.job.verified = true;

  const response = __testables.buildJobResponse(record) as {
    skill_outcome?: {
      selectedSkillId?: string;
      verificationStatus?: string | null;
      failedCheckNames?: string[];
      missingRequirements?: string[];
      summary?: string;
    } | null;
    workflow_summary: {
      skill_outcome?: {
        selectedSkillId?: string;
        verificationStatus?: string | null;
        summary?: string;
      } | null;
    };
  };

  assert.equal(response.skill_outcome?.selectedSkillId, "find.code_symbol");
  assert.equal(response.skill_outcome?.verificationStatus, "verified");
  assert.deepEqual(response.skill_outcome?.failedCheckNames, []);
  assert.deepEqual(response.skill_outcome?.missingRequirements, []);
  assert.equal(response.workflow_summary.skill_outcome?.selectedSkillId, "find.code_symbol");
  assert.equal(response.workflow_summary.skill_outcome?.summary, "Code Symbol Discovery completed with verified evidence.");
});

test("buildJobResponse omits skill outcome summary when no selected skill exists", () => {
  const record = buildRecord([]);
  const response = __testables.buildJobResponse(record) as {
    skill_outcome?: unknown;
    workflow_summary: {
      skill_outcome?: unknown;
    };
  };

  assert.equal(response.skill_outcome ?? null, null);
  assert.equal(response.workflow_summary.skill_outcome ?? null, null);
});

test("buildJobResponse carries insufficient skill outcome details for reflection inputs", () => {
  const record = buildRecord([{
    id: "plan_workflow_1__skill_verify",
    title: "Verify Official Source Discovery",
    description: "Verify skill artifacts.",
    status: "blocked",
    assignee: "verifier",
    dependsOn: [],
    verified: false,
    output: "Verification needs more evidence.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "insufficient",
      summary: "artifact_presence: Required skill artifacts are missing.",
      checks: [{
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "Required skill artifacts are missing.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.official_sources",
    skill_action: "use_installed",
    skill_reason: "Need official evidence first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;
  record.job.status = "blocked";

  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      skill_outcome?: {
        verificationStatus?: string | null;
        failedCheckNames?: string[];
        missingRequirements?: string[];
      } | null;
    };
  };

  assert.equal(response.workflow_summary.skill_outcome?.verificationStatus, "insufficient");
  assert.deepEqual(response.workflow_summary.skill_outcome?.failedCheckNames, [
    "Official Source Discovery: missing required skill artifacts (search result evidence, primary-source summaries)",
  ]);
  assert.deepEqual(response.workflow_summary.skill_outcome?.missingRequirements, [
    "Official Source Discovery still needs evidence artifacts: search result evidence, primary-source summaries.",
  ]);
});

test("buildJobResponse classifies verified skill outcomes into discovery or optimization reflections", () => {
  const record = buildRecord([{
    id: "task_discovery",
    title: "Run Code Symbol Discovery",
    description: "Collect repository entrypoints.",
    status: "completed",
    assignee: "worker",
    dependsOn: [],
    verified: true,
    output: "Collected relevant symbol hits.",
    artifacts: [],
    attempts: 1,
  }, {
    id: "plan_workflow_1__skill_verify",
    title: "Verify Code Symbol Discovery",
    description: "Verify skill artifacts.",
    status: "completed",
    assignee: "verifier",
    dependsOn: ["task_discovery"],
    verified: true,
    output: "Skill verification satisfied.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "verified",
      summary: "Skill verification satisfied.",
      checks: [{
        name: "artifact_presence",
        passed: true,
        status: "passed",
        detail: "Required skill artifacts are present.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.code_symbol",
    skill_action: "use_installed",
    skill_reason: "Need repository discovery first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;
  record.job.status = "completed";
  record.job.verified = true;
  record.artifacts = [{
    id: "art_symbol_hits",
    type: "text",
    contentPreview: "src/index.ts -> bootstrapServer",
    source: "task_run",
    sourceTaskRunId: "task_discovery",
  }];

  const response = __testables.buildJobResponse(record) as {
    skill_reflection?: {
      reflectionKind?: string;
      recommendedAction?: string;
      evidence?: {
        silentBypassSignal?: boolean;
        artifactIds?: string[];
      };
    } | null;
  };

  assert.equal(response.skill_reflection?.reflectionKind, "discovery");
  assert.equal(response.skill_reflection?.recommendedAction, "append_appendix");
  assert.equal(response.skill_reflection?.evidence?.silentBypassSignal, false);
  assert.deepEqual(response.skill_reflection?.evidence?.artifactIds, ["art_symbol_hits"]);
});

test("buildJobResponse classifies attempted-but-insufficient skill outcomes as skill_defect", () => {
  const record = buildRecord([{
    id: "task_sources",
    title: "Fetch official sources",
    description: "Collect sources.",
    status: "completed",
    assignee: "worker",
    dependsOn: [],
    verified: false,
    output: "Fetched weak sources.",
    artifacts: [],
    attempts: 2,
  }, {
    id: "plan_workflow_1__skill_verify",
    title: "Verify Official Source Discovery",
    description: "Verify skill artifacts.",
    status: "blocked",
    assignee: "verifier",
    dependsOn: ["task_sources"],
    verified: false,
    output: "Verification needs more evidence.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "insufficient",
      summary: "artifact_presence: Required skill artifacts are missing.",
      checks: [{
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "Required skill artifacts are missing.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.official_sources",
    skill_action: "use_installed",
    skill_reason: "Need official evidence first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;
  record.job.status = "blocked";
  record.artifacts = [{
    id: "art_search_results",
    type: "text",
    contentPreview: "Result list",
    source: "task_run",
    sourceTaskRunId: "task_sources",
  }];

  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      skill_reflection?: {
        reflectionKind?: string;
        recommendedAction?: string;
        evidence?: {
          silentBypassSignal?: boolean;
        };
      } | null;
    };
  };

  assert.equal(response.workflow_summary.skill_reflection?.reflectionKind, "skill_defect");
  assert.equal(response.workflow_summary.skill_reflection?.recommendedAction, "patch_body");
  assert.equal(response.workflow_summary.skill_reflection?.evidence?.silentBypassSignal, false);
});

test("buildJobResponse marks silent skill bypass as execution_lapse", () => {
  const record = buildRecord([{
    id: "task_generic",
    title: "Generic task",
    description: "No skill-specific evidence.",
    status: "failed",
    assignee: "worker",
    dependsOn: [],
    verified: false,
    output: "Task failed before using the skill properly.",
    artifacts: [],
    attempts: 1,
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.workspace_files",
    skill_action: "use_installed",
    skill_reason: "Need workspace discovery first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;
  record.job.status = "failed";

  const response = __testables.buildJobResponse(record) as {
    skill_reflection?: {
      reflectionKind?: string;
      recommendedAction?: string;
      evidence?: {
        silentBypassSignal?: boolean;
      };
    } | null;
  };

  assert.equal(response.skill_reflection?.reflectionKind, "execution_lapse");
  assert.equal(response.skill_reflection?.recommendedAction, "append_appendix");
  assert.equal(response.skill_reflection?.evidence?.silentBypassSignal, true);
});

test("buildJobResponse standardizes insufficient skill verification into actionable summary", () => {
  const record = buildRecord([{
    id: "plan_workflow_1__skill_verify",
    title: "Verify Code Symbol Discovery",
    description: "Verify skill artifacts.",
    status: "blocked",
    assignee: "verifier",
    dependsOn: [],
    verified: false,
    output: "Verification needs more evidence.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "insufficient",
      summary: "artifact_presence: Required skill artifacts are missing.",
      checks: [{
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "Required skill artifacts are missing.",
      }],
    },
  }]);
  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      skill_verification?: {
        skill_id?: string | null;
        skill_title?: string | null;
        verification_status?: string;
        verification_label?: string;
        action_required?: boolean;
        next_action?: string | null;
        required_artifacts?: string[];
        success_signal_label?: string | null;
        failed_check_names?: string[];
        missing_requirements?: string[];
      } | null;
    };
  };

  assert.equal(response.workflow_summary.skill_verification?.skill_id, null);
  assert.equal(response.workflow_summary.skill_verification?.skill_title, null);
  assert.equal(response.workflow_summary.skill_verification?.verification_status, "insufficient");
  assert.equal(response.workflow_summary.skill_verification?.verification_label, "Needs evidence");
  assert.equal(response.workflow_summary.skill_verification?.action_required, true);
  assert.equal(response.workflow_summary.skill_verification?.next_action, "Collect the missing skill evidence and rerun verification.");
  assert.deepEqual(response.workflow_summary.skill_verification?.required_artifacts, []);
  assert.equal(response.workflow_summary.skill_verification?.success_signal_label, null);
  assert.deepEqual(response.workflow_summary.skill_verification?.failed_check_names, ["missing required skill artifacts"]);
  assert.deepEqual(response.workflow_summary.skill_verification?.missing_requirements, ["evidence artifacts: required skill evidence."]);
});

test("buildJobResponse maps skill verification gaps into skill-aware explanations when skill metadata exists", () => {
  const record = buildRecord([{
    id: "plan_workflow_1__skill_verify",
    title: "Verify Code Symbol Discovery",
    description: "Verify skill artifacts.",
    status: "blocked",
    assignee: "verifier",
    dependsOn: [],
    verified: false,
    output: "Verification needs more evidence.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "insufficient",
      summary: "artifact_presence: Required skill artifacts are missing.",
      checks: [{
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "Required skill artifacts are missing.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.code_symbol",
    skill_action: "use_installed",
    skill_reason: "Need repository discovery first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;

  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      skill_verification?: {
        skill_id?: string | null;
        skill_title?: string | null;
        required_artifacts?: string[];
        success_signal_label?: string | null;
        failed_check_names?: string[];
        missing_requirements?: string[];
      } | null;
    };
  };

  assert.equal(response.workflow_summary.skill_verification?.skill_id, "find.code_symbol");
  assert.equal(response.workflow_summary.skill_verification?.skill_title, "Code Symbol Discovery");
  assert.deepEqual(response.workflow_summary.skill_verification?.required_artifacts, ["relevant symbol hits", "supporting file excerpts"]);
  assert.equal(response.workflow_summary.skill_verification?.success_signal_label, "identify at least one relevant entrypoint");
  assert.deepEqual(
    response.workflow_summary.skill_verification?.failed_check_names,
    ["Code Symbol Discovery: missing required skill artifacts (relevant symbol hits, supporting file excerpts)"],
  );
  assert.deepEqual(
    response.workflow_summary.skill_verification?.missing_requirements,
    ["Code Symbol Discovery still needs evidence artifacts: relevant symbol hits, supporting file excerpts."],
  );
  assert.equal(
    response.workflow_summary.skill_verification?.next_action,
    "Capture concrete symbol hits and supporting file excerpts, then rerun skill verification.",
  );
});

test("buildJobResponse emits skill-specific remediation for official source discovery", () => {
  const record = buildRecord([{
    id: "plan_workflow_1__skill_verify",
    title: "Verify Official Source Discovery",
    description: "Verify skill artifacts.",
    status: "blocked",
    assignee: "verifier",
    dependsOn: [],
    verified: false,
    output: "Verification needs more evidence.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "insufficient",
      summary: "artifact_presence: Required skill artifacts are missing.",
      checks: [{
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "Required skill artifacts are missing.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.official_sources",
    skill_action: "use_installed",
    skill_reason: "Need official evidence first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;

  const response = __testables.buildJobResponse(record) as {
    workflow_summary: {
      skill_verification?: {
        required_artifacts?: string[];
        success_signal_label?: string | null;
        next_action?: string | null;
        missing_requirements?: string[];
      } | null;
    };
  };

  assert.deepEqual(response.workflow_summary.skill_verification?.required_artifacts, ["search result evidence", "primary-source summaries"]);
  assert.equal(response.workflow_summary.skill_verification?.success_signal_label, "capture at least two non-empty primary sources");
  assert.deepEqual(
    response.workflow_summary.skill_verification?.missing_requirements,
    ["Official Source Discovery still needs evidence artifacts: search result evidence, primary-source summaries."],
  );
  assert.equal(
    response.workflow_summary.skill_verification?.next_action,
    "Fetch at least two primary sources and summarize why they are official, then rerun skill verification.",
  );
});

test("buildJobResponse exposes top-level intent route metadata", () => {
  const record = buildRecord([]);
  const response = __testables.buildJobResponse(record) as {
    intent_route?: IntentRouteMetadata | null;
    job?: { intentRoute?: IntentRouteMetadata };
    plan?: { intentRoute?: IntentRouteMetadata };
  };

  assert.equal(response.intent_route?.kind, "coding");
  assert.equal(response.intent_route?.source, "heuristic");
  assert.equal(response.job?.intentRoute?.kind, "coding");
  assert.equal(response.plan?.intentRoute?.kind, "coding");
});

test("buildStepList marks current and approval-blocked workflow steps", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [],
      attempts: 1,
    },
    {
      id: "task_waiting",
      title: "Approval task",
      description: "await approval",
      status: "awaiting_approval",
      assignee: "worker",
      dependsOn: ["task_done"],
      verified: false,
      output: "Waiting for approval.",
      artifacts: [],
      attempts: 0,
    },
    {
      id: "task_pending",
      title: "Pending task",
      description: "pending",
      status: "pending",
      assignee: "worker",
      dependsOn: ["task_waiting"],
      verified: false,
      output: "",
      artifacts: [],
      attempts: 0,
    },
  ]);

  const steps = __testables.buildStepList(record) as Array<{
    id: string;
    is_current_task: boolean;
    is_awaiting_approval_task: boolean;
    workflow_position: { index: number; total: number };
  }>;

  assert.equal(steps.length, 3);
  assert.equal(steps[0]?.workflow_position.index, 1);
  assert.equal(steps[0]?.workflow_position.total, 3);
  assert.equal(steps[1]?.id, "task_waiting");
  assert.equal(steps[1]?.is_current_task, true);
  assert.equal(steps[1]?.is_awaiting_approval_task, true);
  assert.equal(steps[2]?.is_current_task, false);
});

test("buildStepList exposes executor display summary when available", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [],
      attempts: 1,
      executorHistory: [{
        status: "success",
        summary: "Decision summary",
        display_summary: "Display summary",
        tool_calls_made: [],
        artifacts: [],
        raw_result: "raw detail",
        source: "model_text",
      }],
    },
  ]);

  const steps = __testables.buildStepList(record) as Array<{
    latest_executor_summary: string | null;
  }>;

  assert.equal(steps[0]?.latest_executor_summary, "Display summary");
});

test("buildJobEvents exposes artifact metadata for control-plane consumers", () => {
  const record = buildRecord([
    {
      id: "task_done",
      title: "Completed task",
      description: "done",
      status: "completed",
      assignee: "worker",
      dependsOn: [],
      verified: true,
      output: "done",
      artifacts: [{
        id: "artifact_1",
        type: "file",
        path: "runtime/source.txt",
        contentPreview: "source",
        source: "executor",
        trustLevel: "high",
        sourceTaskRunId: "task_done",
        relatedTaskRunId: "task_done",
        relatedStep: 2,
      }],
      attempts: 1,
    },
  ]);
  record.artifacts = record.taskRuns.flatMap((taskRun) => taskRun.artifacts);

  const events = __testables.buildJobEvents(record);
  const artifactEvent = events.find((event) => event.type === "artifact.created");

  assert.equal(artifactEvent?.meta.trust_level, "high");
  assert.equal(artifactEvent?.meta.related_task_run_id, "task_done");
  assert.equal(artifactEvent?.meta.related_step, 2);
});

test("buildJobEvents reconstructs a dedicated intent routing event", () => {
  const record = buildRecord([]);
  const events = __testables.buildJobEvents(record) as Array<{
    type: string;
    meta?: Record<string, unknown>;
    summary?: string;
  }>;
  const routeEvent = events.find((event) => event.type === "system.intent_routed");

  assert.equal(Boolean(routeEvent), true);
  assert.equal(routeEvent?.meta?.intent_kind, "coding");
  assert.equal(routeEvent?.meta?.intent_source, "heuristic");
  assert.equal(routeEvent?.summary, "Request routed to coding.");
});

test("buildJobEvents emits a dedicated skill reflection event", () => {
  const record = buildRecord([{
    id: "task_sources",
    title: "Fetch official sources",
    description: "Collect sources.",
    status: "completed",
    assignee: "worker",
    dependsOn: [],
    verified: false,
    output: "Fetched weak sources.",
    artifacts: [],
    attempts: 2,
  }, {
    id: "plan_workflow_1__skill_verify",
    title: "Verify Official Source Discovery",
    description: "Verify skill artifacts.",
    status: "blocked",
    assignee: "verifier",
    dependsOn: ["task_sources"],
    verified: false,
    output: "Verification needs more evidence.",
    artifacts: [],
    attempts: 1,
    verificationResult: {
      status: "insufficient",
      summary: "artifact_presence: Required skill artifacts are missing.",
      checks: [{
        name: "artifact_presence",
        passed: false,
        status: "insufficient",
        detail: "Required skill artifacts are missing.",
      }],
    },
  }]);
  record.plan.selectedSkill = {
    skill_id: "find.official_sources",
    skill_action: "use_installed",
    skill_reason: "Need official evidence first.",
    skill_install_status: "installed",
  };
  record.job.selectedSkill = record.plan.selectedSkill;
  record.job.status = "blocked";
  record.artifacts = [{
    id: "art_search_results",
    type: "text",
    contentPreview: "Result list",
    source: "task_run",
    sourceTaskRunId: "task_sources",
  }];

  const events = __testables.buildJobEvents(record);
  const reflectionEvent = events.find((event) => event.type === "system.skill_reflection_recorded");

  assert.equal(reflectionEvent?.title, "Skill reflection recorded");
  assert.equal(reflectionEvent?.meta.reflection_kind, "skill_defect");
  assert.equal(reflectionEvent?.meta.recommended_action, "patch_body");
  assert.equal(reflectionEvent?.meta.silent_bypass_signal, false);
  assert.deepEqual(reflectionEvent?.meta.related_artifact_ids, ["art_search_results"]);
});

test("buildJobEvents classifies failure categories for blocked and failed records", () => {
  const record = buildRecord([
    {
      id: "task_failed",
      title: "Failed task",
      description: "failed",
      status: "failed",
      assignee: "worker",
      dependsOn: [],
      verified: false,
      output: "Verification failed because the report file is missing.",
      artifacts: [],
      attempts: 1,
      executorHistory: [{
        status: "failed",
        summary: "Fetch failed",
        tool_calls_made: [{ tool: "url_fetch", arguments: { url: "https://example.com" } }],
        artifacts: [],
        raw_result: "",
        error: "HTTP 403: Forbidden",
        source: "native_tool",
      }],
    },
  ]);
  record.job.status = "blocked";
  record.job.output = "Execution was interrupted by a service restart. The job can be resumed from the control plane.";
  record.control = {
    recoveredAt: new Date().toISOString(),
    recoveryReason: "service_restart",
  };

  const events = __testables.buildJobEvents(record);
  const stepEvent = events.find((event) => event.type === "step.failed");
  const executorEvent = events.find((event) => event.type === "executor.failed");
  const recoveryEvent = events.find((event) => event.type === "job.recovered");

  assert.equal(stepEvent?.meta.failure_category, "verification_failure");
  assert.equal(executorEvent?.meta.failure_category, "tool_failure");
  assert.equal(recoveryEvent?.meta.failure_category, "environment_failure");
});

test("buildJobResponse reflects live executor status and artifact count from persisted events", () => {
  const taskRunId = "task_live";
  const record = buildRecord([
    {
      id: taskRunId,
      title: "Live task",
      description: "running",
      status: "in_progress",
      assignee: "worker",
      dependsOn: [],
      verified: false,
      output: "running",
      artifacts: [],
      attempts: 2,
    },
  ]);
  record.job.id = "job_live_snapshot";
  record.plan.id = "plan_live_snapshot";
  record.job.status = "running";
  record.job.output = "running";

  const jobDir = resolve(WORKSPACE_ROOT, "runtime", "jobs", record.job.id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(resolve(jobDir, "events.jsonl"), [
    JSON.stringify({
      id: "evt_1",
      jobId: record.job.id,
      seq: 1,
      time: new Date().toISOString(),
      agent: "executor",
      phase: "result",
      type: "executor.failed",
      title: "Executor result",
      summary: "failed summary",
      status: "failed",
      step: 2,
      taskRunId,
      meta: {
        executor_status: "failed",
        artifact_count: 2,
      },
    }),
  ].join("\n"), "utf8");

  const response = __testables.buildJobResponse(record) as {
    artifact_count: number;
    latest_step: { latest_executor_status: string | null };
  };

  assert.equal(response.artifact_count, 2);
  assert.equal(response.latest_step.latest_executor_status, "failed");

  rmSync(jobDir, { recursive: true, force: true });
});

test("buildJobResponse exposes follow target when a job has been resumed", () => {
  const record = buildRecord([
    {
      id: "task_resumed_source",
      title: "Resumed source",
      description: "source",
      status: "blocked",
      assignee: "worker",
      dependsOn: [],
      verified: false,
      output: "interrupted",
      artifacts: [],
      attempts: 1,
    },
  ]);
  record.job.id = "job_resumed_source";
  record.job.status = "blocked";
  record.control = {
    recoveredAt: new Date().toISOString(),
    recoveryReason: "service_restart",
    resumedToJobId: "job_resumed_target",
  };

  const response = __testables.buildJobResponse(record) as {
    follow?: { type?: string; job_id?: string; stream_url?: string };
    actions?: Array<{ id?: string; label?: string; href?: string }>;
  };

  assert.equal(response.follow?.type, "resumed_job");
  assert.equal(response.follow?.job_id, "job_resumed_target");
  assert.equal(response.follow?.stream_url, "/v1/jobs/job_resumed_target/stream");
  assert.equal(response.actions?.some((action) => action.id === "open_resumed_timeline"), true);
});

test("buildJobEvents and snapshot expose structured auto-resume failure state", () => {
  const record = buildRecord([
    {
      id: "task_resume_failed",
      title: "Resume failed source",
      description: "source",
      status: "blocked",
      assignee: "worker",
      dependsOn: [],
      verified: false,
      output: "interrupted",
      artifacts: [],
      attempts: 1,
    },
  ]);
  record.job.id = "job_resume_failed_source";
  record.job.status = "blocked";
  record.control = {
    recoveredAt: new Date().toISOString(),
    recoveryReason: "service_restart",
    autoResumeAttemptedAt: new Date().toISOString(),
    autoResumeFailedAt: new Date().toISOString(),
    autoResumeFailureMessage: "planner unavailable",
  };

  const events = __testables.buildJobEvents(record);
  const recoveryEvent = events.find((event) => event.type === "job.recovered");
  assert.equal(recoveryEvent?.summary.includes("Automatic resume failed"), true);
  assert.equal(recoveryEvent?.meta.auto_resume_failure_message, "planner unavailable");

  const response = __testables.buildJobResponse(record) as {
    control?: { autoResumeFailedAt?: string; autoResumeFailureMessage?: string };
    actions?: Array<{ id?: string; label?: string; href?: string; method?: string }>;
  };
  assert.equal(typeof response.control?.autoResumeFailedAt, "string");
  assert.equal(response.control?.autoResumeFailureMessage, "planner unavailable");
  assert.equal(response.actions?.some((action) => action.id === "resume_now" && action.method === "POST"), true);
});

test("timeline html renders CTA actions and queued recovery details", () => {
  const html = renderTimelineHtml(
    "job_cta_test",
    [],
    "CTA test",
    "blocked",
    undefined,
    {
      actions: [
        {
          id: "resume_now",
          label: "Resume Now",
          kind: "api",
          href: "/v1/jobs/job_cta_test/resume",
          method: "POST",
          emphasis: "primary",
        },
        {
          id: "open_resumed_timeline",
          label: "Open Resumed Timeline",
          kind: "link",
          href: "/v1/jobs/job_new/timeline",
          emphasis: "secondary",
        },
      ],
      recovery: {
        auto_resume_status: "queued",
        auto_resume_queue_position: 2,
        auto_resume_batch_size: 5,
        auto_resume_concurrency: 3,
      },
    },
  );

  assert.equal(html.includes("Automatic Resume Queued"), true);
  assert.equal(html.includes("Resume Now"), true);
  assert.equal(html.includes("data-api-action=\"/v1/jobs/job_cta_test/resume\""), true);
  assert.equal(html.includes("Open Resumed Timeline"), true);
  assert.equal(html.includes("2 of 5"), true);
  assert.equal(html.includes("service concurrency is 3"), true);
});

test("timeline html renders workflow summary details in the header", () => {
  const html = renderTimelineHtml(
    "job_workflow_1",
    [],
    "Test workflow summary",
    "awaiting_approval",
    {
      intent_route: {
        kind: "coding",
        reason: "matched engineering language",
        source: "heuristic",
      },
      candidate_skills: [{
        skillId: "find.code_symbol",
        score: 0.98,
        reasons: ["Repository symbol lookup is likely needed before editing."],
        source: "rule",
      }],
      skill_reflection: {
        id: "refl_1",
        skillId: "find.code_symbol",
        reflectionKind: "discovery",
        reason: "Code Symbol Discovery succeeded with verified evidence and exposed a reusable scenario worth capturing.",
        recommendedAction: "append_appendix",
        evidence: {
          verificationStatus: "verified",
          failedCheckNames: [],
          missingRequirements: [],
          eventIds: ["evt_1"],
          artifactIds: ["art_1"],
          silentBypassSignal: false,
        },
      },
      skill_evolution: {
        proposal_count: 2,
        latest_proposal_id: "proposal_1",
        latest_status: "validation_failed",
        latest_patch_summary: "find.code_symbol: skill_defect -> patch_body",
      },
      current_task: {
        id: "task_waiting",
        title: "Approval task",
        status: "awaiting_approval",
      },
      awaiting_approval_task: {
        title: "Approval task",
        status: "awaiting_approval",
      },
      task_counts: {
        pending: 1,
        in_progress: 0,
        awaiting_approval: 1,
        completed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
      },
    },
  );

  assert.equal(html.includes("Current: Approval task (awaiting_approval)"), true);
  assert.equal(html.includes("Approval: Approval task"), true);
  assert.equal(html.includes("Tasks: 1 completed, 1 awaiting approval, 0 in progress, 1 pending"), true);
  assert.equal(html.includes("Route: Coding"), true);
  assert.equal(html.includes("Route reason: matched engineering language"), true);
  assert.equal(html.includes("Skill candidates: find.code_symbol (0.98)"), true);
  assert.equal(html.includes("Skill reflection: discovery -&gt; append_appendix"), true);
  assert.equal(html.includes("Skill evolution: validation_failed - find.code_symbol: skill_defect -&gt; patch_body"), true);
});

test("timeline html renders skill reflection event metadata and silent bypass signal", () => {
  const html = renderTimelineHtml(
    "job_reflection_1",
    [{
      id: "evt_reflection_1",
      jobId: "job_reflection_1",
      seq: 1,
      time: new Date().toISOString(),
      agent: "system",
      phase: "result",
      type: "system.skill_reflection_recorded",
      title: "Skill reflection recorded",
      summary: "Workspace File Discovery appears to have been selected without enough concrete execution evidence.",
      status: "blocked",
      meta: {
        skill_id: "find.workspace_files",
        reflection_id: "refl_1",
        reflection_kind: "execution_lapse",
        recommended_action: "append_appendix",
        silent_bypass_signal: true,
      },
    }],
    "Reflection timeline",
    "failed",
    {
      skill_reflection: {
        id: "refl_1",
        skillId: "find.workspace_files",
        reflectionKind: "execution_lapse",
        reason: "Workspace File Discovery appears to have been selected without enough concrete execution evidence.",
        recommendedAction: "append_appendix",
        evidence: {
          verificationStatus: null,
          failedCheckNames: [],
          missingRequirements: [],
          eventIds: ["evt_reflection_1"],
          artifactIds: [],
          silentBypassSignal: true,
        },
      },
    },
  );

  assert.equal(html.includes("Skill reflection: execution_lapse -&gt; append_appendix"), true);
  assert.equal(html.includes("Reflection signal: silent skill bypass detected."), true);
  assert.equal(html.includes("skill reflection"), true);
  assert.equal(html.includes('data-event-type="system.skill_reflection_recorded"'), true);
  assert.equal(html.includes('data-reflection-kind="execution_lapse"'), true);
  assert.equal(html.includes('data-recommended-action="append_appendix"'), true);
  assert.equal(html.includes('data-silent-bypass-signal="true"'), true);
  assert.equal(html.includes("silent bypass"), true);
});

test("timeline html renders automation ceiling block tags", () => {
  const html = renderTimelineHtml(
    "job_auto_block_1",
    [{
      id: "evt_auto_block_1",
      jobId: "job_auto_block_1",
      seq: 1,
      time: new Date().toISOString(),
      agent: "system",
      phase: "result",
      type: "system.skill_evolution_automation_blocked",
      title: "Skill evolution automation blocked",
      summary: "Automatic skill evolution stopped before acceptance because the medium-risk automation ceiling does not allow auto_accept.",
      status: "blocked",
      meta: {
        skill_id: "find.code_symbol",
        reflection_id: "refl_auto_1",
        proposal_id: "proposal_auto_1",
        risk_tier: "medium",
        blocked_stage: "auto_accept",
        automation_ceiling: "auto_validate",
      },
    }],
    "Automation block timeline",
    "blocked",
  );

  assert.equal(html.includes("medium risk"), true);
  assert.equal(html.includes("auto_accept"), true);
  assert.equal(html.includes("ceiling auto_validate"), true);
});

test("timeline html renders failure summary details in the header and event tags", () => {
  const html = renderTimelineHtml(
    "job_failure_1",
    [{
      id: "evt_1",
      jobId: "job_failure_1",
      seq: 1,
      time: new Date().toISOString(),
      agent: "system",
      phase: "result",
      type: "system.verification_failed",
      title: "Verification reported issues",
      summary: "Verification reported issues because artifact output is missing.",
      status: "blocked",
      meta: {
        failure_category: "verification_failure",
      },
    }],
    "Failure summary test",
    "blocked",
  );

  assert.equal(html.includes("Issues: 1 total"), true);
  assert.equal(html.includes("Verification failure: 1"), true);
  assert.equal(html.includes("Latest issue: Verification issue"), true);
  assert.equal(html.includes('title="verification_failure">Verification failure</span>'), true);
});

test("timeline html renders runtime analysis summaries", () => {
  const html = renderTimelineHtml(
    "job_analysis_1",
    [
      {
        id: "evt_1",
        jobId: "job_analysis_1",
        seq: 1,
        time: new Date().toISOString(),
        agent: "tool",
        phase: "start",
        type: "tool.start",
        title: "Tool started",
        summary: "web_search started.",
        status: "running",
        meta: { tool: "web_search" },
      },
      {
        id: "evt_2",
        jobId: "job_analysis_1",
        seq: 2,
        time: new Date().toISOString(),
        agent: "verifier",
        phase: "result",
        type: "system.verification_failed",
        title: "Verification reported issues",
        summary: "Verification reported issues because artifact output is missing.",
        status: "blocked",
        meta: {
          tool: "read_file",
          failure_category: "verification_failure",
        },
      },
      {
        id: "evt_3",
        jobId: "job_analysis_1",
        seq: 3,
        time: new Date().toISOString(),
        agent: "verifier",
        phase: "result",
        type: "system.verification_check_insufficient",
        title: "Verification check insufficient",
        summary: "artifact_presence: Tool calls were made but no artifacts were produced.",
        status: "blocked",
        taskRunId: "t2",
        meta: {
          verification_check_name: "artifact_presence",
          verification_check_status: "insufficient",
          verification_status: "insufficient",
          failure_category: "verification_failure",
          related_artifact_ids: ["artifact_report_1"],
        },
      },
      {
        id: "evt_4",
        jobId: "job_analysis_1",
        seq: 4,
        time: new Date().toISOString(),
        agent: "system",
        phase: "result",
        type: "artifact.created",
        title: "Artifact created",
        summary: "Artifact saved to runtime/command-results/report.md.",
        status: "success",
        taskRunId: "t2",
        meta: {
          artifact_id: "artifact_report_1",
          artifact_type: "file",
          path: "runtime/command-results/report.md",
          content_preview: "# Report\n\nCollected evidence:\n- item 1\n- item 2",
          related_task_run_id: "t2",
        },
      },
      {
        id: "evt_5",
        jobId: "job_analysis_1",
        seq: 5,
        time: new Date().toISOString(),
        agent: "system",
        phase: "decision",
        type: "system.skill_install_attempted",
        title: "Skill install attempted",
        summary: "Attempting to install find.code_symbol.",
        status: "running",
        meta: {
          skill_id: "find.code_symbol",
          skill_install_status: "install_required",
          install_reason: "Skill installation requires skills.auto_install=true.",
          install_source: "builtin",
          install_location: "skills/find.code_symbol",
        },
      },
      {
        id: "evt_6",
        jobId: "job_analysis_1",
        seq: 6,
        time: new Date().toISOString(),
        agent: "system",
        phase: "retry",
        type: "system.skill_install_blocked",
        title: "Skill install blocked",
        summary: "Install blocked for find.code_symbol. Skill installation requires skills.auto_install=true.",
        status: "blocked",
        meta: {
          skill_id: "find.code_symbol",
          skill_install_status: "blocked",
          install_reason: "Skill installation requires skills.auto_install=true.",
          install_source: "builtin",
          install_location: "skills/find.code_symbol",
          failure_category: "policy_blocked",
        },
      },
    ],
    "Runtime analysis test",
    "blocked",
    {
      dag: {
        workflow_count: 1,
        edge_count: 0,
        workflows: [
          {
            workflow_id: "wf_analysis",
            status: "active",
            task_count: 2,
            completed_count: 1,
            tasks: [
              {
                id: "t1",
                task_id: "t1",
                title: "Collect evidence",
                status: "completed",
                assignee: "worker",
                depends_on: [],
                verified: false,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t2",
                task_id: "t2",
                title: "Verify artifact",
                status: "completed",
                assignee: "verifier",
                depends_on: ["t1"],
                verified: true,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
            ],
          },
        ],
      },
      replan_history: [],
    },
  );

  assert.equal(html.includes("Workflow Analysis"), true);
  assert.equal(html.includes("Runtime Analysis"), true);
  assert.equal(html.includes("Verification: 0 passed, 1 failed"), true);
  assert.equal(html.includes("Artifact output"), true);
  assert.equal(html.includes("Artifacts created"), true);
  assert.equal(html.includes("report.md"), true);
  assert.equal(html.includes("Verification failed"), true);
  assert.equal(html.includes("Verification checks"), true);
  assert.equal(html.includes("artifact_presence"), true);
  assert.equal(html.includes("Tool usage distribution"), true);
  assert.equal(html.includes("web_search"), true);
  assert.equal(html.includes("Failure types"), true);
  assert.equal(html.includes("Blockers"), true);
  assert.equal(html.includes('id="detail-pane"'), true);
  assert.equal(html.includes('id="detail-content"'), true);
  assert.equal(html.includes("Select a task, artifact, or verification check to inspect its details."), true);
  assert.equal(html.includes("selectionKind"), true);
  assert.equal(html.includes("selectionValue"), true);
  assert.equal(html.includes("verification_failure"), true);
  assert.equal(html.includes('data-analysis-filter="verifier"'), true);
  assert.equal(html.includes('data-analysis-filter="verification_check"'), true);
  assert.equal(html.includes('data-analysis-filter="artifact"'), true);
  assert.equal(html.includes('data-analysis-filter="artifact_group"'), true);
  assert.equal(html.includes('data-analysis-filter="skill_install"'), true);
  assert.equal(html.includes('data-analysis-filter="skill_install_group"'), true);
  assert.equal(html.includes('data-analysis-value="artifact_report_1"'), true);
  assert.equal(html.includes('data-analysis-filter="tool"'), true);
  assert.equal(html.includes('data-analysis-filter="failure_category"'), true);
  assert.equal(html.includes('data-event-type="system.verification_failed"'), true);
  assert.equal(html.includes('data-event-type="system.verification_check_insufficient"'), true);
  assert.equal(html.includes('data-verification-check-name="artifact_presence"'), true);
  assert.equal(html.includes('data-verification-check-status="insufficient"'), true);
  assert.equal(html.includes('data-related-artifact-ids="artifact_report_1"'), true);
  assert.equal(html.includes('data-event-type="artifact.created"'), true);
  assert.equal(html.includes('data-artifact-id="artifact_report_1"'), true);
  assert.equal(html.includes('data-task-run-id="t2"'), true);
  assert.equal(html.includes('data-related-task-run-id="t2"'), true);
  assert.equal(html.includes('data-task-status="completed"'), true);
  assert.equal(html.includes('data-attempts="1"'), true);
  assert.equal(html.includes('data-artifact-path="runtime/command-results/report.md"'), true);
  assert.equal(html.includes('data-event-tool="web_search"'), true);
  assert.equal(html.includes('data-failure-category="verification_failure"'), true);
  assert.equal(html.includes('data-event-id="evt_5"'), true);
  assert.equal(html.includes('data-skill-install-status="install_required"'), true);
  assert.equal(html.includes('data-skill-install-group="skill_install"'), true);
  assert.equal(html.includes('data-assignee="verifier"'), true);
  assert.equal(html.includes('data-verified="true"'), true);
  assert.equal(html.includes('data-clear-analysis-filter'), true);
  assert.equal(html.includes("Show all events"), true);
  assert.equal(html.includes("is-analysis-match"), true);
  assert.equal(html.includes('&quot;content_preview&quot;: &quot;# Report\\n\\nCollected evidence:\\n- item 1\\n- item 2&quot;'), true);
  assert.equal(html.includes("Related Artifacts"), true);
  assert.equal(html.includes("Install Timeline"), true);
  assert.equal(html.includes("Raw Metadata"), true);
});

test("timeline html renders dependency graph lanes with SVG edges", () => {
  const html = renderTimelineHtml(
    "job_graph_1",
    [],
    "Graph workflow",
    "running",
    {
      task_counts: {
        pending: 0,
        in_progress: 1,
        awaiting_approval: 0,
        completed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
      },
      dag: {
        workflow_count: 1,
        edge_count: 2,
        workflows: [
          {
            workflow_id: "wf_graph",
            status: "active",
            task_count: 3,
            completed_count: 1,
            tasks: [
              {
                id: "t1",
                task_id: "t1",
                title: "Collect evidence",
                status: "completed",
                assignee: "worker",
                depends_on: [],
                verified: true,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t2",
                task_id: "t2",
                title: "Verify evidence",
                status: "completed",
                assignee: "verifier",
                depends_on: ["t1"],
                verified: true,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t3",
                task_id: "t3",
                title: "Write report",
                status: "in_progress",
                assignee: "worker",
                depends_on: ["t2"],
                verified: false,
                attempts: 1,
                superseded: false,
                superseded_by: null,
              },
            ],
          },
        ],
      },
      replan_history: [],
    },
  );

  assert.equal(html.includes("workflow-graph"), true);
  assert.equal(html.includes("graph-svg"), true);
  assert.equal(html.includes("graph-edge"), true);
  assert.equal(html.includes("Stage 1"), true);
  assert.equal(html.includes("Stage 2"), true);
  assert.equal(html.includes('data-workflow-id="wf_graph"'), true);
  assert.equal(html.includes('data-task-id="t3"'), true);
  assert.equal(html.includes('data-from="t1"'), true);
  assert.equal(html.includes('data-to="t2"'), true);
  assert.equal(html.includes("renderEdgeDetail"), true);
  assert.equal(html.includes("kind: 'edge'"), true);
  assert.equal(html.includes("graphEdges.forEach"), true);
  assert.equal(html.includes("Dependency"), true);
  assert.equal(html.includes("is-current-task"), true);
  assert.equal(html.includes("initializeWorkflowInteractions"), true);
});

test("timeline html renders replan history focus hooks", () => {
  const html = renderTimelineHtml(
    "job_graph_2",
    [],
    "Graph workflow with replan",
    "running",
    {
      current_task: {
        id: "t2",
        title: "Replacement task",
        status: "in_progress",
      },
      dag: {
        workflow_count: 2,
        edge_count: 1,
        workflows: [
          {
            workflow_id: "wf_old",
            status: "superseded",
            superseded_by: "wf_new",
            task_count: 2,
            completed_count: 0,
            tasks: [
              {
                id: "t1",
                task_id: "t1",
                title: "Old task",
                status: "failed",
                assignee: "worker",
                depends_on: [],
                verified: false,
                attempts: 1,
                superseded: true,
                superseded_by: "wf_new",
              },
              {
                id: "t_removed",
                task_id: "t_removed",
                title: "Removed task",
                status: "pending",
                assignee: "worker",
                depends_on: ["t1"],
                verified: false,
                attempts: 0,
                superseded: true,
                superseded_by: "wf_new",
              },
            ],
          },
          {
            workflow_id: "wf_new",
            status: "active",
            task_count: 2,
            completed_count: 0,
            tasks: [
              {
                id: "t2",
                task_id: "t2",
                title: "Replacement task",
                status: "in_progress",
                assignee: "worker",
                depends_on: [],
                verified: false,
                attempts: 0,
                superseded: false,
                superseded_by: null,
              },
              {
                id: "t_added",
                task_id: "t_added",
                title: "Added task",
                status: "pending",
                assignee: "worker",
                depends_on: ["t2"],
                verified: false,
                attempts: 0,
                superseded: false,
                superseded_by: null,
              },
            ],
          },
        ],
      },
      replan_history: [
        {
          index: 1,
          superseded_workflow_id: "wf_old",
          replacement_workflow_id: "wf_new",
          failed_task_id: "t1",
        },
      ],
    },
  );

  assert.equal(html.includes('data-superseded-workflow-id="wf_old"'), true);
  assert.equal(html.includes('data-replacement-workflow-id="wf_new"'), true);
  assert.equal(html.includes('class="workflow-lane superseded" data-workflow-id="wf_old"'), true);
  assert.equal(html.includes('data-clear-workflow-focus'), true);
  assert.equal(html.includes('Show all lanes'), true);
  assert.equal(html.includes('clearWorkflowFocus'), true);
  assert.equal(html.includes('applyWorkflowFocus'), true);
  assert.equal(html.includes("workflowFocus"), true);
  assert.equal(html.includes("history.replaceState"), true);
  assert.equal(html.includes('history-item.is-focused'), true);
  assert.equal(html.includes('data-focus-state'), true);
  assert.equal(html.includes('data-focus-hint'), true);
  assert.equal(html.includes('Focused: superseded lane'), true);
  assert.equal(html.includes('Focused: replacement lane'), true);
  assert.equal(html.includes('Click again to switch to replacement lane'), true);
  assert.equal(html.includes("Replan before/after diff"), true);
  assert.equal(html.includes("added: t_added"), true);
  assert.equal(html.includes("removed: t_removed"), true);
  assert.equal(html.includes("Open the diff below to compare before/after task shape."), true);
});

test("timeline UI state keeps task selection while clearing analysis filter", () => {
  const state = reduceTimelineUiState(
    {
      workflowFocus: null,
      analysisFilter: { kind: "tool", value: "web_search" },
      selection: { kind: "task", taskId: "t2" },
    },
    { type: "clear_analysis_filter" },
  );

  assert.deepEqual(state.analysisFilter, null);
  assert.deepEqual(state.selection, { kind: "task", taskId: "t2" });
});

test("timeline UI state syncs artifact selection into artifact filter", () => {
  const state = reduceTimelineUiState(
    {
      workflowFocus: null,
      analysisFilter: null,
      selection: { kind: "task", taskId: "t1" },
    },
    { type: "select_artifact", artifactId: "artifact_report_1" },
  );

  assert.deepEqual(state.analysisFilter, { kind: "artifact", value: "artifact_report_1" });
  assert.deepEqual(state.selection, { kind: "artifact", artifactId: "artifact_report_1" });
});

test("timeline UI state applies verification filter and selection together", () => {
  const state = reduceTimelineUiState(
    {
      workflowFocus: null,
      analysisFilter: null,
      selection: null,
    },
    { type: "apply_analysis_filter", kind: "verification_check", value: "artifact_presence:insufficient" },
  );

  assert.deepEqual(state.analysisFilter, { kind: "verification_check", value: "artifact_presence:insufficient" });
  assert.deepEqual(state.selection, { kind: "verification_check", checkKey: "artifact_presence:insufficient" });
});

test("timeline UI state keeps skill install selection and URL round-trip", () => {
  const baseUrl = "https://example.test/v1/jobs/job_1/timeline";
  const state = reduceTimelineUiState(
    {
      workflowFocus: null,
      analysisFilter: null,
      selection: null,
    },
    { type: "select_skill_install", eventId: "evt_install_1" },
  );

  assert.deepEqual(state.selection, { kind: "skill_install", eventId: "evt_install_1" });

  const url = writeTimelineUiStateToUrl(baseUrl, state);
  assert.equal(url.includes("selectionKind=skill_install"), true);
  assert.equal(url.includes("selectionValue=evt_install_1"), true);
  assert.deepEqual(readTimelineUiStateFromUrl(url), state);
});

test("timeline UI state keeps edge selection in URL round-trip", () => {
  const baseUrl = "https://example.test/v1/jobs/job_1/timeline";
  const state = reduceTimelineUiState(
    {
      workflowFocus: null,
      analysisFilter: null,
      selection: null,
    },
    { type: "select_edge", fromTaskId: "t1", toTaskId: "t2", workflowId: "wf_graph" },
  );

  const url = writeTimelineUiStateToUrl(baseUrl, state);
  assert.equal(url.includes("selectionKind=edge"), true);
  assert.equal(url.includes("selectionValue=t1-%3Et2-%3Ewf_graph"), true);
  assert.deepEqual(readTimelineUiStateFromUrl(url), state);
});

test("timeline UI state round-trips URL state for history restoration", () => {
  const baseUrl = "https://example.test/v1/jobs/job_1/timeline";
  const taskState = reduceTimelineUiState(
    {
      workflowFocus: null,
      analysisFilter: null,
      selection: null,
    },
    { type: "select_task", taskId: "t2" },
  );
  const artifactState = reduceTimelineUiState(taskState, { type: "select_artifact", artifactId: "artifact_report_1" });
  const focusedState = reduceTimelineUiState(artifactState, { type: "apply_workflow_focus", workflowId: "wf_analysis" });

  const taskUrl = writeTimelineUiStateToUrl(baseUrl, taskState);
  const artifactUrl = writeTimelineUiStateToUrl(baseUrl, artifactState);
  const focusedUrl = writeTimelineUiStateToUrl(baseUrl, focusedState);

  assert.deepEqual(readTimelineUiStateFromUrl(taskUrl), taskState);
  assert.deepEqual(readTimelineUiStateFromUrl(artifactUrl), artifactState);
  assert.deepEqual(readTimelineUiStateFromUrl(focusedUrl), focusedState);
});

test("workflow UI normalizes replanned and superseded events", () => {
  const replanned = normalizeWorkflowEvent({
    type: "workflow.plan.replanned",
    step: 2,
    data: {
      workflow_id: "wf_old",
      replacement_workflow_id: "wf_new",
      task_id: "t1",
      replan_count: 1,
    },
  }, "job_1", 1);
  const superseded = normalizeWorkflowEvent({
    type: "workflow.task.superseded",
    step: 2,
    data: {
      task_id: "t1",
      title: "Old task",
      role: "worker",
      replacement_workflow_id: "wf_new",
    },
  }, "job_1", 2);

  assert.equal(replanned.type, "planner.workflow_plan_replanned");
  assert.equal(replanned.summary.includes("wf_old"), true);
  assert.equal(superseded.type, "workflow.task.superseded");
  assert.equal(superseded.summary.includes("wf_new"), true);
});

test("workflow UI classifies replan rejections and verification failures", () => {
  const replanRejected = normalizeWorkflowEvent({
    type: "workflow.replan.rejected",
    step: 2,
    data: {
      workflow_id: "wf_old",
      replacement_workflow_id: "wf_new",
      task_id: "t1",
      issues: ["replacement workflow schema validation failed"],
    },
  }, "job_1", 3);
  const verificationFailed = normalizeWorkflowEvent({
    type: "system.verification_failed",
    step: 3,
    data: {
      verification_status: "failed",
      verifier_count: 2,
      summary: "Verification reported issues because artifact output is missing.",
    },
  }, "job_1", 4);

  assert.equal(replanRejected.type, "planner.workflow_replan_rejected");
  assert.equal(replanRejected.meta.failure_category, "validation_failure");
  assert.equal(verificationFailed.meta.failure_category, "verification_failure");
});

test("workflow UI normalizes verification check events", () => {
  const check = normalizeWorkflowEvent({
    type: "system.verification_check_insufficient",
    step: 3,
    data: {
      task_id: "t_verify",
      title: "Verify artifact",
      kind: "verify",
      role: "verifier",
      verification_check_name: "artifact_presence",
      verification_check_status: "insufficient",
      verification_status: "insufficient",
      verification_source: "task_run",
      passed: false,
      detail: "Tool calls were made but no artifacts were produced.",
    },
  }, "job_1", 5);

  assert.equal(check.agent, "verifier");
  assert.equal(check.status, "blocked");
  assert.equal(check.taskRunId, "t_verify");
  assert.equal(check.meta.verification_check_name, "artifact_presence");
  assert.equal(check.meta.failure_category, "verification_failure");
});

test("workflow UI prefers normalized planner and executor contract fields", () => {
  const planner = normalizeWorkflowEvent({
    type: "workflow.planner.decision",
    step: 1,
    data: {
      status: "final",
      reasoning_summary: "internal reasoning",
      next_step: "next step",
      decision_text: "Final consumer-facing answer",
    },
  }, "job_1", 1);
  const executor = normalizeWorkflowEvent({
    type: "workflow.executor.result",
    step: 1,
    data: {
      status: "success",
      summary: "Decision summary",
      display_summary: "Display summary",
    },
  }, "job_1", 2);

  assert.equal(planner.summary, "Final consumer-facing answer");
  assert.equal(executor.summary, "Display summary");
});
