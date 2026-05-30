import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig, materializeRuntimeModelSelection } from "./config.js";
import { compressJsonOutput, compressToolOutput } from "./compress.js";
import { createRunLogger } from "./logger.js";
import { buildHealthyExecutorRuntimeConfig, NoHealthyExecutorError, type ModelHealthResult } from "./model-health.js";
import { PlannerUnavailableError, runOrchestrator, runTask, detectTaskType, getRoutePolicy } from "./orchestrator.js";
import { loadTaskRoutingConfig } from "./task-routing.js";
import { runChatCompletionDetailed, type ChatMessage } from "./providers/openai-compatible.js";
import { TOOL_DEFINITIONS, configureSearchTools } from "./tools.js";
import type { ApprovalRequest, Artifact, CandidateSkillSummary, ExecutorOutput, IntentRouteMetadata, Job, OrchestratorConfig, OrchestratorEvent, OrchestratorEventCallback, Plan, RoutePolicy, SelectedSkillSummary, Task, TaskRun, VerificationCheck } from "./types.js";
import type {
  SkillEvolutionAutomationBlockSummary,
  SkillEvolutionDecisionRecord,
  SkillEvolutionProposal,
  SkillProposalStatus,
  SkillReflectionRecord,
} from "./skill-evolution-types.js";
import { buildRuntimeProfile } from "./runtime/profile.js";
import { runTeam, type TeamAgent } from "./team.js";
import { buildDashboardData, exportDashboardJson, exportDashboardHtml } from "./dashboard.js";
import { Tracer } from "./trace.js";
import { createModelVerifier, DEFAULT_VERIFIERS, runVerifiers, verificationPassed as verificationResultPassed, type VerificationContext } from "./verification.js";
import { ARTIFACTS_ROOT, RUNTIME_ROOT, WORKSPACE_ROOT, ensureRuntimeDirectories } from "./paths.js";
import { listStoredJobs, persistApprovalRequest, persistJobRecord, readJobRecord, resolveApprovalRequest, updateJobControlState, updateStoredJobRecord, type StoredJobRecord } from "./job-store.js";
import { cancelActiveJobSession, getActiveJobSession, registerActiveJobSession, resolvePendingApproval, setApprovalResolver, unregisterActiveJobSession } from "./job-runtime.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "./workflow-contract.js";
import { createUiEvent, normalizeWorkflowEvent, type InternalWorkflowEvent, type WorkflowUiEvent } from "./workflow-ui-events.js";
import { appendEvent, getEvents, subscribe, getNextSeq, loadEventsFromDisk } from "./job-event-bus.js";
import { renderTimelineHtml } from "./timeline.js";
import { renderJobsDashboardHtml } from "./jobs-dashboard.js";
import { renderGoalsDashboardHtml, type GoalDashboardItem } from "./goals-dashboard.js";
import { renderGoalTimelineHtml } from "./goal-timeline.js";
import { buildWorkflowGraph } from "./workflow-graph.js";
import { describeJobState, mapJobStatusToLifecycleType, mapJobStatusToUiStatus, mapTaskRunStatusToUiStatus } from "./status-semantics.js";
import { classifyFailure, getFailureCategoryLabel, listFailureCategories } from "./failure-classification.js";
import { getExecutorDisplaySummary, getPlannerDecisionText, summarizeVerification } from "./output-contract.js";
import { detectIntentRoute } from "./intent-router.js";
import { dispatchTaskIntentRoute, shouldDispatchToTeam } from "./intent-dispatch.js";
import { appendGoalEvent, buildGoalRecord, listGoals, persistGoal, readGoal, readGoalEvents, summarizeGoals } from "./goal-store.js";
import { resumeGoal, reviewGoal, retryGoalTask, runNextGoalTask } from "./goal-runtime.js";
import type { CreateGoalInput, GoalRecord, GoalTaskInput, GoalTaskMode } from "./goal-types.js";
import { insertLargeCheckTasks, planGoalTasks } from "./goal-planner.js";
import { buildGoalResponse } from "./goal-contract.js";
import { getSkillManifest, listAvailableSkills, listBuiltinSkills, listInstalledSkills } from "./skill-registry.js";
import { getInstalledSkillRecord, installSkillById } from "./skill-installer.js";
import { buildSkillVerificationSummary } from "./skill-verification.js";
import { buildSkillOutcomeSummary } from "./skill-outcome.js";
import { buildSkillReflectionRecord } from "./skill-reflection.js";
import { auditSkillEvolutionProposal } from "./skill-auditor.js";
import { validateSkillEvolutionProposal, validateSkillEvolutionProposalWithRuntimeReplay } from "./skill-deployment-validator.js";
import { generateSkillEvolutionProposal } from "./skill-evolver.js";
import {
  applyAcceptedSkillProposal,
  getSkillEvolutionProposalCandidateRoot,
  getSkillEvolutionProposalRollbackRoot,
  listSkillEvolutionProposals,
  persistSkillEvolutionDecisionRecord,
  listSkillReflectionRecords,
  persistSkillAuditReport,
  persistSkillDeploymentValidationReport,
  persistSkillEvolutionProposal,
  persistSkillReflectionRecord,
  readSkillAuditReport,
  readSkillDeploymentValidationReport,
  readSkillEvolutionDecisionRecord,
  readSkillEvolutionProposal,
  readSkillReflectionRecord,
  updateSkillEvolutionProposal,
} from "./skill-evolution-store.js";

const OPENAI_MODEL_ID = "dual-agent-orchestrator";
const DEFAULT_API_KEY = "dual-agent-local";
const PLANNER_FAILURE_THRESHOLD = 3;
const PLANNER_COOLDOWN_MS = 60_000;
const DEFAULT_AUTO_RESUME_CONCURRENCY = 3;
const MAX_TOOL_RESULT_CHARS = 2000;
const MAX_TOOL_MODE_ROUNDS = 4;
const MAX_TOOL_CONTEXT_CHARS = 1200;
let configOverrideForTests: OrchestratorConfig | null = null;

function getRuntimeConfig(): OrchestratorConfig {
  return configOverrideForTests ?? loadConfig();
}

type PlannerCircuitState = {
  consecutiveFailures: number;
  openUntil: number;
  lastFailureAt: number;
  lastFailureMessage: string;
};

const plannerCircuit: PlannerCircuitState = {
  consecutiveFailures: 0,
  openUntil: 0,
  lastFailureAt: 0,
  lastFailureMessage: "",
};

class ServiceUnavailableError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "ServiceUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface OpenAIMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  include_workflow_events?: boolean;
  include_progress_updates?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  stream_options?: { include_usage?: boolean };
}

interface CreateJobRequest {
  goal?: string;
  mode?: "task" | "team";
  model_route?: string;
  policy?: {
    allow_network?: boolean;
    allow_shell?: boolean;
    approval_mode?: string;
    async?: boolean;
  };
}

interface CreateGoalRequest {
  goal?: string;
  insert_large_checks?: boolean;
  tasks?: Array<{
    title?: string;
    description?: string;
    mode?: "task" | "team";
  }>;
}

interface ResponseInputItem {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface ResponsesRequest {
  model?: string;
  input?: string | ResponseInputItem[];
  instructions?: string;
  stream?: boolean;
  include_workflow_events?: boolean;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  stream?: boolean;
  include_workflow_events?: boolean;
  tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

interface ExposedModel {
  id: string;
  object: "model";
  owned_by: string;
  planner_model?: string;
  executor_model?: string;
  planner_base_url?: string;
  planner_api_key?: string;
  executor_base_url?: string;
  executor_api_key?: string;
  description?: string;
}

type HealthResponse = {
  status: string;
  planner: Record<string, unknown>;
  executor: Record<string, unknown>;
  runtime: Record<string, unknown>;
  skills?: Record<string, unknown>;
  skill_evolution?: Record<string, unknown>;
  models: string[];
};

function inferSkillInstallStatus(
  skillId: string | undefined,
  skillAction: SelectedSkillSummary["skill_action"] | undefined,
): SelectedSkillSummary["skill_install_status"] | undefined {
  if (skillAction === "use_installed") {
    return "installed";
  }
  if (skillAction === "install_then_use") {
    return "install_required";
  }
  if (skillAction === "skip_skill") {
    return "skipped";
  }
  if (skillId) {
    return listBuiltinSkills().some((skill) => skill.id === skillId) ? "installed" : "unavailable";
  }
  return undefined;
}

function resolveSelectedSkillSummary(
  record: StoredJobRecord,
  events?: WorkflowUiEvent[],
): SelectedSkillSummary | null {
  const direct = record.job.selectedSkill ?? record.plan.selectedSkill;
  if (direct?.skill_id || direct?.skill_action || direct?.skill_reason || direct?.skill_install_status) {
    return {
      ...direct,
      skill_install_status: direct.skill_install_status ?? inferSkillInstallStatus(direct.skill_id, direct.skill_action),
    };
  }

  const plannerEvent = [...(events ?? [])]
    .reverse()
    .find((event) => event.type === "planner.decision" || event.type === "workflow.planner.decision");
  const meta = plannerEvent?.meta ?? {};
  const skillId = typeof meta.selected_skill === "string" && meta.selected_skill.trim().length > 0
    ? meta.selected_skill.trim()
    : typeof meta.skill_id === "string" && meta.skill_id.trim().length > 0
      ? meta.skill_id.trim()
      : undefined;
  const skillAction = meta.skill_action === "use_installed"
    || meta.skill_action === "install_then_use"
    || meta.skill_action === "skip_skill"
    ? meta.skill_action
    : undefined;
  const skillReason = typeof meta.skill_reason === "string" && meta.skill_reason.trim().length > 0
    ? meta.skill_reason.trim()
    : undefined;
  const skillInstallStatus = typeof meta.skill_install_status === "string" && meta.skill_install_status.trim().length > 0
    ? meta.skill_install_status.trim() as SelectedSkillSummary["skill_install_status"]
    : inferSkillInstallStatus(skillId, skillAction);

  if (!skillId && !skillAction && !skillReason && !skillInstallStatus) {
    return null;
  }

  return {
    skill_id: skillId,
    skill_action: skillAction,
    skill_reason: skillReason,
    skill_install_status: skillInstallStatus,
  };
}

function isCandidateSkillSummary(value: unknown): value is CandidateSkillSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.skillId === "string"
    && typeof entry.score === "number"
    && Array.isArray(entry.reasons)
    && (entry.source === "rule" || entry.source === "planner");
}

function resolveCandidateSkillsSummary(
  record: StoredJobRecord,
  events?: WorkflowUiEvent[],
): CandidateSkillSummary[] {
  const direct = record.job.candidateSkills ?? record.plan.candidateSkills;
  if (Array.isArray(direct) && direct.every(isCandidateSkillSummary)) {
    return [...direct];
  }

  const skillEvent = [...(events ?? [])]
    .reverse()
    .find((event) => event.type === "system.skill_selected");
  const raw = skillEvent?.meta?.candidate_skills;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isCandidateSkillSummary);
}

function resolveSkillVerificationSummary(record: StoredJobRecord): Record<string, unknown> | null {
  const skillVerifyTaskRun = [...record.taskRuns].reverse().find((taskRun) => taskRun.id.endsWith("__skill_verify"));
  if (!skillVerifyTaskRun) {
    return null;
  }
  const skillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
  return buildSkillVerificationSummary(skillVerifyTaskRun, skillId ?? null);
}

function resolveSkillEvolutionSummary(record: StoredJobRecord): Record<string, unknown> | null {
  const selectedSkillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
  if (!selectedSkillId) {
    return null;
  }

  const candidateDir = getRuntimeConfig().skillEvolution.candidateDir;
  const reflectionIds = new Set(
    listSkillReflectionRecords(selectedSkillId, candidateDir)
      .filter((reflection) => reflection.jobId === record.job.id)
      .map((reflection) => reflection.id),
  );
  if (reflectionIds.size === 0) {
    return null;
  }
  const proposals = listSkillEvolutionProposals(candidateDir)
    .filter((proposal) => proposal.skillId === selectedSkillId && reflectionIds.has(proposal.sourceReflectionId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  if (proposals.length === 0) {
    return null;
  }

  const latest = proposals[0]!;
  const latestRecord = buildSkillEvolutionProposalControlPlaneRecord(latest, getRuntimeConfig());
  return {
    proposal_count: proposals.length,
    latest_proposal_id: latest.id,
    latest_status: latest.status,
    latest_patch_summary: latest.patchSummary,
    latest_change_summary: latest.controlPlaneSummary?.changeHeadline ?? latest.diffSummary?.changedFiles.map((file) => file.summary).join(" ") ?? null,
    latest_rationale_summary: latest.controlPlaneSummary?.rationaleHeadline ?? latest.rationaleSummary?.reason ?? null,
    latest_changed_files: latest.controlPlaneSummary?.changedFiles ?? latest.targetFiles,
    latest_created_at: latest.createdAt,
    latest_decided_at: latest.decidedAt ?? null,
    latest_validation_summary: latestRecord.validation_summary,
    latest_ops_summary: latestRecord.ops_summary,
    statuses: proposals.reduce<Record<string, number>>((acc, proposal) => {
      acc[proposal.status] = (acc[proposal.status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function assertHealthyExecutorSelection(
  healthSelection: Awaited<ReturnType<typeof buildHealthyExecutorRuntimeConfig>>,
): void {
  if (healthSelection.healthyExecutorIds.length > 0) {
    return;
  }
  throw new NoHealthyExecutorError(healthSelection.results);
}

function summarizeExecutorHealth(results: readonly ModelHealthResult[]): {
  total: number;
  healthy: number;
  unhealthy: number;
  disabled: number;
} {
  return {
    total: results.length,
    healthy: results.filter((result) => result.status === "healthy").length,
    unhealthy: results.filter((result) => result.status === "unhealthy").length,
    disabled: results.filter((result) => result.status === "disabled").length,
  };
}

interface TaskExecutionPayload {
  content: string;
  logPath: string;
  resolvedModel: string;
  job: Job;
  plan: Plan;
  taskRuns: TaskRun[];
  artifacts: Artifact[];
  intentRoute?: IntentRouteMetadata;
}

interface TaskExecutionContext {
  jobId: string;
  planId: string;
  taskRunId: string;
  signal: AbortSignal;
  emitEvent?: OrchestratorEventCallback;
}

interface FixedTaskIds {
  jobId: string;
  planId: string;
  taskRunId: string;
}

interface JobExecutionOptions {
  requirePlannerCircuit?: boolean;
  fixedIds?: FixedTaskIds;
  approvalMode?: string;
}

let injectedTaskExecutor: ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null = null;
let injectedTeamExecutor: ((userGoal: string, model: string | undefined, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null = null;

function setTaskExecutorForTests(executor: ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null): void {
  injectedTaskExecutor = executor;
}

function setTeamExecutorForTests(executor: ((userGoal: string, model: string | undefined, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null): void {
  injectedTeamExecutor = executor;
}

function parseTeamAgentsEnv(value: string | undefined): TeamAgent[] {
  const raw = value?.trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof item.name === "string")
          .map((item) => ({ name: item.name as string, role: typeof item.role === "string" ? item.role : undefined }))
      : [];
  } catch {
    return [];
  }
}

function teamAgentsFromRegistry(config: OrchestratorConfig): TeamAgent[] {
  return Object.values(config.agents ?? {}).map((agent) => ({
    name: agent.id,
    role: agent.role,
  }));
}

function resolveRegisteredRoleAgent(config: OrchestratorConfig | undefined, roleName: string): { id: string; role: string; model: string } | undefined {
  if (!config?.agents) {
    return undefined;
  }
  const normalizedRole = roleName.toLowerCase();
  const agent = Object.values(config.agents).find((candidate) => {
    const id = candidate.id.toLowerCase();
    const role = candidate.role.toLowerCase();
    return id === normalizedRole || role === normalizedRole || role.includes(normalizedRole);
  });
  return agent ? { id: agent.id, role: agent.role, model: agent.model.model } : undefined;
}

function resolveTeamAgents(config: OrchestratorConfig, envValue = process.env.TEAM_AGENTS): TeamAgent[] {
  const envAgents = parseTeamAgentsEnv(envValue);
  if (envAgents.length > 0) {
    return envAgents;
  }
  const registeredAgents = teamAgentsFromRegistry(config);
  if (registeredAgents.length > 0) {
    return registeredAgents;
  }
  return [{ name: "planner", role: "planning and coordination" }, { name: "executor", role: "task execution" }];
}

function persistWorkflowPayload(payload: Pick<TaskExecutionPayload, "job" | "plan" | "taskRuns" | "artifacts">): string {
  ensureRuntimeDirectories();
  return persistJobRecord({
    job: payload.job,
    plan: payload.plan,
    taskRuns: payload.taskRuns,
    artifacts: payload.artifacts,
    workflowGraph: payload.job.workflowGraph,
  });
}

function persistSkillReflectionForRecord(record: StoredJobRecord, config = loadConfig()): void {
  if (!config.skillEvolution.enabled || !config.skillEvolution.autoReflect) {
    return;
  }
  const events = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
  const selectedSkill = resolveSelectedSkillSummary(record, events);
  const skillVerification = resolveSkillVerificationSummary(record);
  const skillOutcome = buildSkillOutcomeSummary(record, events, selectedSkill, skillVerification);
  const skillReflection = buildSkillReflectionRecord(skillOutcome, {
    record,
    events,
  });
  if (!skillReflection) {
    return;
  }
  persistSkillReflectionRecord(skillReflection, config.skillEvolution.candidateDir);
}

function shouldAutoAcceptSkillEvolution(
  validation: ReturnType<typeof validateSkillEvolutionProposal>,
  config: OrchestratorConfig,
): boolean {
  return config.skillEvolution.autoAccept
    && validation.passed
    && validation.decision.autoAcceptReady;
}

type SkillEvolutionAutomationStage = "auto_reflect" | "auto_propose" | "auto_audit" | "auto_validate" | "auto_accept";

const SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER: Record<SkillEvolutionAutomationStage, number> = {
  auto_reflect: 1,
  auto_propose: 2,
  auto_audit: 3,
  auto_validate: 4,
  auto_accept: 5,
};
const SKILL_EVOLUTION_DYNAMIC_RISK_WINDOW_HOURS = 24;

function isSkillEvolutionAutomationStage(value: unknown): value is SkillEvolutionAutomationStage {
  return value === "auto_reflect"
    || value === "auto_propose"
    || value === "auto_audit"
    || value === "auto_validate"
    || value === "auto_accept";
}

function resolveSkillAutomationRiskTier(
  manifest: ReturnType<typeof getSkillManifest> | null,
  config: OrchestratorConfig,
): "low" | "medium" | "high" {
  const intents = new Set(manifest?.intents ?? []);
  if (intents.has("coding") || intents.has("file_ops")) {
    return "high";
  }
  return config.skillEvolution.riskTiering.defaultTier;
}

function isAutomationStageAllowedForTier(
  tier: "low" | "medium" | "high",
  stage: SkillEvolutionAutomationStage,
  config: OrchestratorConfig,
): boolean {
  if (!config.skillEvolution.riskTiering.enabled) {
    return true;
  }
  const ceiling = config.skillEvolution.riskTiering.automationCeilings[tier];
  return SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[stage] <= SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[ceiling];
}

function isAutomationStageAllowedForCeiling(
  ceiling: SkillEvolutionAutomationStage,
  stage: SkillEvolutionAutomationStage,
): boolean {
  return SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[stage] <= SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[ceiling];
}

function buildAutomationCeilingBlockMeta(
  skillId: string,
  tier: "low" | "medium" | "high",
  blockedStage: SkillEvolutionAutomationStage,
  config: OrchestratorConfig,
  context?: {
    reflectionId?: string;
    proposalId?: string;
  },
): Record<string, unknown> {
  return {
    skill_id: skillId,
    reflection_id: context?.reflectionId,
    proposal_id: context?.proposalId,
    risk_tier: tier,
    blocked_stage: blockedStage,
    automation_ceiling: config.skillEvolution.riskTiering.automationCeilings[tier],
  };
}

function buildDynamicAutomationCeilingBlockMeta(
  skillId: string,
  blockedStage: SkillEvolutionAutomationStage,
  dynamicRisk: Record<string, unknown>,
  context?: {
    reflectionId?: string;
    proposalId?: string;
  },
): Record<string, unknown> {
  const ceiling = isSkillEvolutionAutomationStage(dynamicRisk.automation_ceiling)
    ? dynamicRisk.automation_ceiling
    : "auto_validate";
  return {
    skill_id: skillId,
    reflection_id: context?.reflectionId,
    proposal_id: context?.proposalId,
    risk_tier: typeof dynamicRisk.tier === "string" ? dynamicRisk.tier : "medium",
    blocked_stage: blockedStage,
    automation_ceiling: ceiling,
    dynamic_risk: true,
    dynamic_risk_reasons: Array.isArray(dynamicRisk.reasons) ? dynamicRisk.reasons : [],
  };
}

type SkillEvolutionProposalControlPlaneRecord = SkillEvolutionProposal & {
  automation_block: SkillEvolutionAutomationBlockSummary | null;
  validation_summary: Record<string, unknown> | null;
  dynamic_risk: Record<string, unknown>;
  eligibility: Record<string, unknown>;
  ops_summary: Record<string, unknown>;
  rollback_guide: Record<string, unknown> | null;
};

const SKILL_EVOLUTION_QUEUE_STATUSES = new Set<SkillProposalStatus>([
  "draft",
  "auditing",
  "audit_failed",
  "validated",
  "validation_failed",
]);

function classifySkillEvolutionAgeBucket(createdAt: string, now = Date.now()): "under_1h" | "over_1h" | "over_24h" {
  const createdAtMs = Date.parse(createdAt);
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : 0;
  if (ageMs >= 24 * 60 * 60 * 1000) {
    return "over_24h";
  }
  if (ageMs >= 60 * 60 * 1000) {
    return "over_1h";
  }
  return "under_1h";
}

function resolveSkillEvolutionQueueState(status: SkillProposalStatus): "proposal_queue" | "accepted_history" | "rejected_history" {
  if (status === "accepted") {
    return "accepted_history";
  }
  if (status === "rejected") {
    return "rejected_history";
  }
  return "proposal_queue";
}

function resolveSkillEvolutionFunnelStage(status: SkillProposalStatus): string {
  switch (status) {
    case "draft":
      return "proposal_created";
    case "auditing":
      return "audit_running";
    case "audit_failed":
      return "audit_failed";
    case "validated":
      return "validation_passed";
    case "validation_failed":
      return "validation_failed";
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
  }
}

function buildSkillEvolutionProposalOpsSummary(
  proposal: SkillEvolutionProposal,
  validationSummary: Record<string, unknown> | null,
  automationBlock: SkillEvolutionAutomationBlockSummary | null,
  rollbackGuide: Record<string, unknown> | null,
  dynamicRisk: Record<string, unknown>,
  eligibility: Record<string, unknown>,
  now = Date.now(),
): Record<string, unknown> {
  const createdAtMs = Date.parse(proposal.createdAt);
  const ageSeconds = Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((now - createdAtMs) / 1000)) : 0;
  const queueState = resolveSkillEvolutionQueueState(proposal.status);
  const validationReady = validationSummary && validationSummary.auto_accept_ready === true;
  const blockedStage = automationBlock?.blockedStage ?? null;
  const dynamicCeiling = typeof dynamicRisk.automation_ceiling === "string" ? dynamicRisk.automation_ceiling : null;
  const eligible = eligibility.eligible === true;
  const reasons = Array.isArray(eligibility.reasons) ? eligibility.reasons : [];
  return {
    queue_state: queueState,
    funnel_stage: resolveSkillEvolutionFunnelStage(proposal.status),
    age_seconds: ageSeconds,
    age_bucket: classifySkillEvolutionAgeBucket(proposal.createdAt, now),
    actionable: queueState === "proposal_queue" && proposal.status !== "auditing",
    blocked_stage: blockedStage,
    auto_accept_ready: validationReady,
    auto_accept_eligible: eligible,
    eligibility_reasons: reasons,
    dynamic_risk_tier: dynamicRisk.tier ?? "low",
    dynamic_risk_reasons: Array.isArray(dynamicRisk.reasons) ? dynamicRisk.reasons : [],
    dynamic_risk_cooldown_active: dynamicRisk.cooldown_active === true,
    dynamic_risk_cooldown_until: dynamicRisk.cooldown_until ?? null,
    effective_automation_ceiling: dynamicCeiling,
    stuck_state: resolveSkillEvolutionStuckState(proposal, validationSummary, automationBlock, dynamicRisk, now),
    rollback_available: rollbackGuide && rollbackGuide.rollback_available === true,
  };
}

function resolveSkillEvolutionStuckState(
  proposal: SkillEvolutionProposal,
  validationSummary: Record<string, unknown> | null,
  automationBlock: SkillEvolutionAutomationBlockSummary | null,
  dynamicRisk: Record<string, unknown>,
  now = Date.now(),
): Record<string, unknown> {
  const ageBucket = classifySkillEvolutionAgeBucket(proposal.createdAt, now);
  const reasons: string[] = [];
  if (automationBlock) {
    reasons.push(`automation blocked at ${automationBlock.blockedStage}`);
  }
  if (proposal.status === "audit_failed") {
    reasons.push("audit failed");
  }
  if (proposal.status === "validation_failed") {
    reasons.push("validation failed");
  }
  if (validationSummary && validationSummary.auto_accept_ready !== true && proposal.status === "validated") {
    reasons.push("validated but not auto-accept eligible");
  }
  if (dynamicRisk.tier === "high") {
    reasons.push("dynamic risk is high");
  }
  if (ageBucket !== "under_1h" && SKILL_EVOLUTION_QUEUE_STATUSES.has(proposal.status)) {
    reasons.push(`proposal age bucket is ${ageBucket}`);
  }
  return {
    stuck: reasons.length > 0,
    stage: reasons[0] ?? null,
    reasons,
    age_bucket: ageBucket,
  };
}

function readAutomationBlockForProposal(
  proposal: SkillEvolutionProposal,
  config: OrchestratorConfig,
): SkillEvolutionAutomationBlockSummary | null {
  const reflection = readSkillReflectionRecord(proposal.skillId, proposal.sourceReflectionId, config.skillEvolution.candidateDir);
  if (!reflection) {
    return null;
  }
  const events = loadEventsFromDisk(reflection.jobId);
  const matched = [...events].reverse().find((event) => {
    if (event.type !== "system.skill_evolution_automation_blocked" || !isObjectRecord(event.meta)) {
      return false;
    }
    if (event.meta.skill_id !== proposal.skillId) {
      return false;
    }
    if (typeof event.meta.proposal_id === "string" && event.meta.proposal_id !== proposal.id) {
      return false;
    }
    if (typeof event.meta.reflection_id === "string" && event.meta.reflection_id !== proposal.sourceReflectionId) {
      return false;
    }
    return event.time >= proposal.createdAt;
  });
  if (!matched || !isObjectRecord(matched.meta)) {
    return null;
  }
  const riskTier = matched.meta.risk_tier;
  const blockedStage = matched.meta.blocked_stage;
  const automationCeiling = matched.meta.automation_ceiling;
  if ((riskTier !== "low" && riskTier !== "medium" && riskTier !== "high")
    || (blockedStage !== "auto_reflect"
      && blockedStage !== "auto_propose"
      && blockedStage !== "auto_audit"
      && blockedStage !== "auto_validate"
      && blockedStage !== "auto_accept")
    || (automationCeiling !== "auto_reflect"
      && automationCeiling !== "auto_propose"
      && automationCeiling !== "auto_audit"
      && automationCeiling !== "auto_validate"
      && automationCeiling !== "auto_accept")) {
    return null;
  }
  return {
    reason: "automation_ceiling",
    eventType: "system.skill_evolution_automation_blocked",
    jobId: reflection.jobId,
    eventSeq: matched.seq,
    eventTime: matched.time,
    summary: matched.summary,
    riskTier,
    blockedStage,
    automationCeiling,
  };
}

function buildSkillEvolutionDynamicRiskSummary(
  proposal: SkillEvolutionProposal,
  validationSummary: Record<string, unknown> | null,
  config: OrchestratorConfig,
  proposalHistory?: SkillEvolutionProposal[],
): Record<string, unknown> {
  const now = Date.now();
  const windowMs = SKILL_EVOLUTION_DYNAMIC_RISK_WINDOW_HOURS * 60 * 60 * 1000;
  const skillProposals = (proposalHistory ?? listSkillEvolutionProposals(config.skillEvolution.candidateDir))
    .filter((item) => item.skillId === proposal.skillId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, 10);
  const auditReports = skillProposals
    .map((item) => readSkillAuditReport(item.id, config.skillEvolution.candidateDir))
    .filter((report): report is NonNullable<typeof report> => report !== null);
  const validationReports = skillProposals
    .map((item) => readSkillDeploymentValidationReport(item.id, config.skillEvolution.candidateDir))
    .filter((report): report is NonNullable<typeof report> => report !== null);
  const isRecent = (createdAt: string): boolean => {
    const createdAtMs = Date.parse(createdAt);
    return Number.isFinite(createdAtMs) && now - createdAtMs <= windowMs;
  };
  const auditFailureSignals = [
    ...auditReports.filter((report) => !report.passed && isRecent(report.createdAt)).map((report) => report.createdAt),
    ...skillProposals.filter((item) => item.status === "audit_failed" && isRecent(item.createdAt)).map((item) => item.createdAt),
  ];
  const validationFailureSignals = [
    ...validationReports.filter((report) => !report.passed && isRecent(report.createdAt)).map((report) => report.createdAt),
    ...skillProposals.filter((item) => item.status === "validation_failed" && isRecent(item.createdAt)).map((item) => item.createdAt),
  ];
  const replayInstabilitySignals = validationReports.filter((report) => isRecent(report.createdAt) && (report.stability?.autoAcceptBlocked === true
    || report.stability?.replayInstabilityDetected === true
    || report.replay?.sameInputComparison?.readiness !== "ready"
    || report.replay?.runtimeBoundary?.trueRuntimeReplayReady !== true)).map((report) => report.createdAt);
  const auditFailureCount = auditFailureSignals.length;
  const validationFailureCount = validationFailureSignals.length;
  const replayInstabilityCount = replayInstabilitySignals.length;
  const signalTimes = [...auditFailureSignals, ...validationFailureSignals, ...replayInstabilitySignals]
    .map((createdAt) => Date.parse(createdAt))
    .filter((value) => Number.isFinite(value));
  const newestSignalMs = signalTimes.length > 0 ? Math.max(...signalTimes) : null;
  const cooldownUntilMs = newestSignalMs === null ? null : newestSignalMs + windowMs;
  const cooldownActive = cooldownUntilMs !== null && cooldownUntilMs > now;
  const newestSignalAt = newestSignalMs === null ? null : new Date(newestSignalMs).toISOString();
  const cooldownUntil = cooldownUntilMs === null ? null : new Date(cooldownUntilMs).toISOString();
  const currentAutoAcceptReady = validationSummary?.auto_accept_ready === true;
  const currentReadiness = typeof validationSummary?.same_input_readiness === "string"
    ? validationSummary.same_input_readiness
    : null;
  const reasons: string[] = [];
  if (auditFailureCount > 0) {
    reasons.push(`${auditFailureCount} recent audit failure signal(s)`);
  }
  if (validationFailureCount > 0) {
    reasons.push(`${validationFailureCount} recent validation failure signal(s)`);
  }
  if (replayInstabilityCount > 0) {
    reasons.push(`${replayInstabilityCount} recent replay readiness/stability signal(s)`);
  }
  if (validationSummary && !currentAutoAcceptReady) {
    reasons.push("current proposal is not auto-accept ready");
  }
  if (currentReadiness && currentReadiness !== "ready") {
    reasons.push(`current same-input readiness is ${currentReadiness}`);
  }
  if (cooldownActive && cooldownUntil) {
    reasons.push(`dynamic risk cooldown active until ${cooldownUntil}`);
  }

  const tier: "low" | "medium" | "high" = validationFailureCount > 0 || replayInstabilityCount >= 2
    ? "high"
    : auditFailureCount > 0 || replayInstabilityCount > 0
      ? "medium"
      : "low";
  const automationCeiling: SkillEvolutionAutomationStage = validationFailureCount > 0 || replayInstabilityCount >= 2
    ? "auto_audit"
    : auditFailureCount > 0
      ? "auto_propose"
      : replayInstabilityCount > 0
        ? "auto_validate"
        : config.skillEvolution.riskTiering.automationCeilings.low;
  return {
    tier,
    source: "recent_skill_evolution_history",
    automation_ceiling: automationCeiling,
    auto_accept_blocked: tier !== "low" || !currentAutoAcceptReady,
    audit_failure_count: auditFailureCount,
    validation_failure_count: validationFailureCount,
    replay_instability_count: replayInstabilityCount,
    sampled_proposal_count: skillProposals.length,
    window_hours: SKILL_EVOLUTION_DYNAMIC_RISK_WINDOW_HOURS,
    newest_signal_at: newestSignalAt,
    cooldown_until: cooldownUntil,
    cooldown_active: cooldownActive,
    reasons: reasons.length > 0 ? reasons : ["no recent dynamic risk signals"],
  };
}

function buildSkillEvolutionEligibilitySummary(
  proposal: SkillEvolutionProposal,
  validationSummary: Record<string, unknown> | null,
  automationBlock: SkillEvolutionAutomationBlockSummary | null,
  dynamicRisk: Record<string, unknown>,
): Record<string, unknown> {
  const reasons: string[] = [];
  if (proposal.status !== "validated") {
    reasons.push(`proposal status is ${proposal.status}`);
  }
  if (!validationSummary) {
    reasons.push("validation summary is unavailable");
  } else {
    if (validationSummary.passed !== true) {
      reasons.push("validation has not passed");
    }
    if (validationSummary.auto_accept_ready !== true) {
      reasons.push("validation is not auto-accept ready");
    }
    const readiness = typeof validationSummary.same_input_readiness === "string"
      ? validationSummary.same_input_readiness
      : null;
    if (readiness && readiness !== "ready") {
      reasons.push(`same-input readiness is ${readiness}`);
    }
  }
  if (automationBlock) {
    reasons.push(`automation ceiling blocked ${automationBlock.blockedStage}`);
  }
  if (dynamicRisk.auto_accept_blocked === true) {
    reasons.push("dynamic risk blocks auto-accept");
  }
  const eligible = reasons.length === 0;
  return {
    eligible,
    action: eligible ? "auto_accept" : "manual_review",
    reasons: eligible ? ["auto-accept eligibility checks passed"] : reasons,
  };
}

function buildSkillEvolutionProposalControlPlaneRecord(
  proposal: SkillEvolutionProposal,
  config: OrchestratorConfig,
  proposalHistory?: SkillEvolutionProposal[],
): SkillEvolutionProposalControlPlaneRecord {
  const validation = readSkillDeploymentValidationReport(proposal.id, config.skillEvolution.candidateDir);
  const validationSummary = validation ? buildSkillEvolutionValidationSummary(validation) : null;
  const automationBlock = readAutomationBlockForProposal(proposal, config);
  const dynamicRisk = buildSkillEvolutionDynamicRiskSummary(proposal, validationSummary, config, proposalHistory);
  const eligibility = buildSkillEvolutionEligibilitySummary(proposal, validationSummary, automationBlock, dynamicRisk);
  const acceptedDecision = proposal.status === "accepted"
    ? readSkillEvolutionDecisionRecord(proposal.id, "accepted", config.skillEvolution.candidateDir)
    : null;
  const rollbackGuide = proposal.status === "accepted"
    ? buildSkillEvolutionRollbackGuide(proposal, acceptedDecision, config)
    : null;
  return {
    ...proposal,
    automation_block: automationBlock,
    validation_summary: validationSummary,
    dynamic_risk: dynamicRisk,
    eligibility,
    ops_summary: buildSkillEvolutionProposalOpsSummary(proposal, validationSummary, automationBlock, rollbackGuide, dynamicRisk, eligibility),
    rollback_guide: rollbackGuide,
  };
}

function buildSkillEvolutionOpsItem(
  record: SkillEvolutionProposalControlPlaneRecord,
  config: OrchestratorConfig,
): Record<string, unknown> {
  return {
    id: record.id,
    skill_id: record.skillId,
    source_reflection_id: record.sourceReflectionId,
    status: record.status,
    created_at: record.createdAt,
    decided_at: record.decidedAt ?? null,
    patch_summary: record.patchSummary,
    change_summary: record.controlPlaneSummary?.changeHeadline ?? null,
    rationale_summary: record.controlPlaneSummary?.rationaleHeadline ?? null,
    changed_files: record.controlPlaneSummary?.changedFiles ?? record.targetFiles,
    target_files: record.targetFiles,
    audit_report_path: record.auditReportPath ?? null,
    validation_report_path: record.validationReportPath ?? null,
    validation_summary: record.validation_summary,
    automation_block: record.automation_block,
    dynamic_risk: record.dynamic_risk,
    eligibility: record.eligibility,
    ops_summary: record.ops_summary,
    proposal_url: `/v1/skill-evolution/proposals/${encodeURIComponent(record.id)}`,
    audit_url: `/v1/skill-evolution/proposals/${encodeURIComponent(record.id)}/audit`,
    validate_url: `/v1/skill-evolution/proposals/${encodeURIComponent(record.id)}/validate`,
    accept_url: `/v1/skill-evolution/proposals/${encodeURIComponent(record.id)}/accept`,
    reject_url: `/v1/skill-evolution/proposals/${encodeURIComponent(record.id)}/reject`,
    candidate_path: getSkillEvolutionProposalCandidateRoot(record.id, config.skillEvolution.candidateDir),
  };
}

function buildSkillEvolutionRollbackGuide(
  record: SkillEvolutionProposal,
  decision: SkillEvolutionDecisionRecord | null,
  config: OrchestratorConfig,
): Record<string, unknown> {
  const rollbackPath = getSkillEvolutionProposalRollbackRoot(record.id, config.skillEvolution.candidateDir);
  return {
    proposal_id: record.id,
    skill_id: record.skillId,
    accepted_at: decision?.createdAt ?? record.decidedAt ?? null,
    reason: decision?.reason ?? null,
    rollback_path: rollbackPath,
    rollback_available: existsSync(rollbackPath),
    changed_files: record.controlPlaneSummary?.changedFiles ?? record.targetFiles,
    guide: [
      "Inspect changed_files and rollback_path before restoring.",
      "Restore the needed file(s) from rollback_path back to the live skill path.",
      "Re-run the affected skill workflow and validation before accepting another proposal.",
    ],
  };
}

function buildSkillEvolutionOpsSummary(config: OrchestratorConfig): Record<string, unknown> {
  const proposals = listSkillEvolutionProposals(config.skillEvolution.candidateDir);
  const records = proposals
    .map((proposal) => buildSkillEvolutionProposalControlPlaneRecord(proposal, config, proposals));
  const proposalQueue = records
    .filter((record) => SKILL_EVOLUTION_QUEUE_STATUSES.has(record.status))
    .map((record) => buildSkillEvolutionOpsItem(record, config));
  const acceptedRecords = records.filter((record) => record.status === "accepted");
  const acceptedHistory = acceptedRecords.map((record) => {
    const decision = readSkillEvolutionDecisionRecord(record.id, "accepted", config.skillEvolution.candidateDir);
    return {
      ...buildSkillEvolutionOpsItem(record, config),
      decision: decision ? {
        decision: decision.decision,
        reason: decision.reason ?? null,
        created_at: decision.createdAt,
      } : null,
      rollback: buildSkillEvolutionRollbackGuide(record, decision, config),
    };
  });
  const statusCounts = records.reduce<Record<string, number>>((acc, record) => {
    acc[record.status] = (acc[record.status] ?? 0) + 1;
    return acc;
  }, {});
  const now = Date.now();
  const agingBuckets = proposalQueue.reduce<Record<string, number>>((acc, item) => {
    const bucket = classifySkillEvolutionAgeBucket(typeof item.created_at === "string" ? item.created_at : "", now);
    acc[bucket] = (acc[bucket] ?? 0) + 1;
    return acc;
  }, { under_1h: 0, over_1h: 0, over_24h: 0 });
  const dynamicRiskCounts = records.reduce<Record<string, number>>((acc, record) => {
    const tier = typeof record.dynamic_risk.tier === "string" ? record.dynamic_risk.tier : "unknown";
    acc[tier] = (acc[tier] ?? 0) + 1;
    return acc;
  }, { low: 0, medium: 0, high: 0 });
  const eligibilityCounts = records.reduce<Record<string, number>>((acc, record) => {
    const key = record.eligibility.eligible === true ? "eligible" : "blocked";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, { eligible: 0, blocked: 0 });
  const stuckCount = records.filter((record) => {
    const stuckState = record.ops_summary.stuck_state;
    return isObjectRecord(stuckState) && stuckState.stuck === true;
  }).length;
  return {
    object: "skill_evolution_ops",
    generated_at: new Date().toISOString(),
    summary: {
      total_proposals: records.length,
      queue_count: proposalQueue.length,
      accepted_count: acceptedHistory.length,
      rejected_count: statusCounts.rejected ?? 0,
      audit_failed_count: statusCounts.audit_failed ?? 0,
      validation_failed_count: statusCounts.validation_failed ?? 0,
      rollback_available_count: acceptedHistory.filter((item) => {
        const rollback = item.rollback;
        return isObjectRecord(rollback) && rollback.rollback_available === true;
      }).length,
      statuses: statusCounts,
      funnel: {
        proposal_created: statusCounts.draft ?? 0,
        audit_running: statusCounts.auditing ?? 0,
        audit_failed: statusCounts.audit_failed ?? 0,
        validation_passed: statusCounts.validated ?? 0,
        validation_failed: statusCounts.validation_failed ?? 0,
        accepted: statusCounts.accepted ?? 0,
        rejected: statusCounts.rejected ?? 0,
      },
      aging_buckets: agingBuckets,
      dynamic_risk: dynamicRiskCounts,
      eligibility: eligibilityCounts,
      stuck_count: stuckCount,
    },
    proposal_queue: proposalQueue,
    accepted_history: acceptedHistory,
    rollback_guides: acceptedHistory.map((item) => item.rollback),
  };
}

function summarizeReplayJob(replayJob: {
  status?: string;
  verificationStatus?: string;
  events?: Array<{
    type?: string;
    status?: string;
    summary?: string;
  }>;
} | null | undefined): Record<string, unknown> | null {
  if (!replayJob) {
    return null;
  }
  const events = Array.isArray(replayJob.events) ? replayJob.events : [];
  const terminal = events.length > 0 ? events[events.length - 1] : null;
  return {
    status: replayJob.status ?? null,
    verification_status: replayJob.verificationStatus ?? null,
    event_count: events.length,
    terminal_event_type: terminal?.type ?? null,
    terminal_event_status: terminal?.status ?? null,
    terminal_summary: terminal?.summary ?? null,
  };
}

function buildSkillEvolutionValidationSummary(validation: {
  passed: boolean;
  risk?: {
    tier?: string;
  };
  decision?: {
    reasonCode?: string;
    autoAcceptReady?: boolean;
  };
  replay?: {
    runtimeBoundary?: {
      source?: string;
      contract?: string;
      candidateRuntimeConfigPrepared?: boolean;
      trueRuntimeReplayReady?: boolean;
      autoAcceptEligible?: boolean;
    };
    provenance?: {
      isolated?: boolean;
    };
    sameInputComparison?: {
      readiness?: string;
    };
    baseline?: {
      replayJob?: {
        status?: string;
        verificationStatus?: string;
        events?: Array<{
          type?: string;
          status?: string;
          summary?: string;
        }>;
      };
    };
    candidate?: {
      replayJob?: {
        status?: string;
        verificationStatus?: string;
        events?: Array<{
          type?: string;
          status?: string;
          summary?: string;
        }>;
      };
    };
  };
}): Record<string, unknown> {
  const baselineReplay = summarizeReplayJob(validation.replay?.baseline?.replayJob);
  const candidateReplay = summarizeReplayJob(validation.replay?.candidate?.replayJob);
  const candidateTerminalType = candidateReplay && typeof candidateReplay.terminal_event_type === "string"
    ? candidateReplay.terminal_event_type
    : null;
  const candidateEventCount = candidateReplay && typeof candidateReplay.event_count === "number"
    ? candidateReplay.event_count
    : 0;
  const replayHeadline = validation.replay?.provenance?.isolated
    ? `Isolated replay ${validation.passed ? "passed" : "ended blocked"} with ${candidateEventCount} candidate event(s) and terminal state ${candidateTerminalType ?? "unknown"}.`
    : "Isolated replay has not executed for this validation result.";
  return {
    passed: validation.passed,
    risk_tier: validation.risk?.tier ?? null,
    reason_code: validation.decision?.reasonCode ?? null,
    auto_accept_ready: validation.decision?.autoAcceptReady ?? false,
    runtime_boundary: validation.replay?.runtimeBoundary ?? null,
    isolated_replay: validation.replay?.provenance?.isolated ?? false,
    same_input_readiness: validation.replay?.sameInputComparison?.readiness ?? null,
    replay_headline: replayHeadline,
    baseline_replay: baselineReplay,
    candidate_replay: candidateReplay,
  };
}

async function runAutomaticSkillEvolutionForRecord(record: StoredJobRecord, config = loadConfig()): Promise<void> {
  if (!config.skillEvolution.enabled || !config.skillEvolution.autoReflect) {
    return;
  }
  const reflection = buildSkillReflectionFromRecord(record);
  if (!reflection) {
    return;
  }
  const manifest = getSkillManifest(reflection.skillId, config);
  const riskTier = resolveSkillAutomationRiskTier(manifest, config);

  persistSkillReflectionRecord(reflection, config.skillEvolution.candidateDir);
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: reflection.createdAt,
    type: "system.skill_reflection_recorded",
    title: "Skill reflection recorded",
    summary: reflection.reason,
    status: reflection.reflectionKind === "skill_defect" || reflection.reflectionKind === "execution_lapse" ? "blocked" : "success",
    meta: {
      skill_id: reflection.skillId,
      reflection_id: reflection.id,
      reflection_kind: reflection.reflectionKind,
      recommended_action: reflection.recommendedAction,
      verification_status: reflection.evidence.verificationStatus ?? null,
      failed_check_names: reflection.evidence.failedCheckNames,
      missing_requirements: reflection.evidence.missingRequirements,
      related_event_ids: reflection.evidence.eventIds,
      related_artifact_ids: reflection.evidence.artifactIds,
      silent_bypass_signal: reflection.evidence.silentBypassSignal ?? false,
    },
  }));

  if (!config.skillEvolution.autoPropose || !isAutomationStageAllowedForTier(riskTier, "auto_propose", config)) {
    if (config.skillEvolution.autoPropose && config.skillEvolution.riskTiering.enabled) {
      appendEvent(createLifecycleEvent({
        jobId: reflection.jobId,
        seq: getNextSeq(reflection.jobId),
        time: new Date().toISOString(),
        type: "system.skill_evolution_automation_blocked",
        title: "Skill evolution automation blocked",
        summary: `Automatic skill evolution stopped before proposal because the ${riskTier}-risk automation ceiling does not allow auto_propose.`,
        status: "blocked",
        meta: buildAutomationCeilingBlockMeta(reflection.skillId, riskTier, "auto_propose", config, {
          reflectionId: reflection.id,
        }),
      }));
    }
    return;
  }

  const proposal = buildSkillEvolutionProposal(reflection, config.skillEvolution.candidateDir, config);
  persistSkillEvolutionProposal(proposal, config.skillEvolution.candidateDir);
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: proposal.createdAt,
    type: "system.skill_evolution_proposed",
    title: "Skill evolution proposed",
    summary: proposal.patchSummary,
    status: "running",
    meta: {
      skill_id: proposal.skillId,
      reflection_id: proposal.sourceReflectionId,
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      patch_summary: proposal.patchSummary,
      change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
      rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
      changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
    },
  }));

  const proposalDynamicRisk = buildSkillEvolutionDynamicRiskSummary(proposal, null, config);
  const proposalDynamicCeiling = isSkillEvolutionAutomationStage(proposalDynamicRisk.automation_ceiling)
    ? proposalDynamicRisk.automation_ceiling
    : "auto_validate";
  if (config.skillEvolution.autoAudit
    && config.skillEvolution.riskTiering.enabled
    && !isAutomationStageAllowedForCeiling(proposalDynamicCeiling, "auto_audit")) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: "system.skill_evolution_automation_blocked",
      title: "Skill evolution automation blocked",
      summary: `Automatic skill evolution stopped before audit because dynamic risk lowered the automation ceiling to ${proposalDynamicCeiling}.`,
      status: "blocked",
      meta: buildDynamicAutomationCeilingBlockMeta(reflection.skillId, "auto_audit", proposalDynamicRisk, {
        reflectionId: reflection.id,
        proposalId: proposal.id,
      }),
    }));
    return;
  }

  if (!config.skillEvolution.autoAudit || !isAutomationStageAllowedForTier(riskTier, "auto_audit", config)) {
    if (config.skillEvolution.autoAudit && config.skillEvolution.riskTiering.enabled) {
      appendEvent(createLifecycleEvent({
        jobId: reflection.jobId,
        seq: getNextSeq(reflection.jobId),
        time: new Date().toISOString(),
        type: "system.skill_evolution_automation_blocked",
        title: "Skill evolution automation blocked",
        summary: `Automatic skill evolution stopped before audit because the ${riskTier}-risk automation ceiling does not allow auto_audit.`,
        status: "blocked",
        meta: buildAutomationCeilingBlockMeta(reflection.skillId, riskTier, "auto_audit", config, {
          reflectionId: reflection.id,
          proposalId: proposal.id,
        }),
      }));
    }
    return;
  }

  const audit = auditSkillEvolutionProposal({
    proposal,
    reflection,
    manifest,
  });
  const auditPath = persistSkillAuditReport(audit, config.skillEvolution.candidateDir);
  const auditedProposal = updateSkillEvolutionProposal(proposal.id, (current) => ({
    ...current,
    status: audit.passed ? "validated" : "audit_failed",
    auditReportPath: auditPath,
  }), config.skillEvolution.candidateDir);
  if (!auditedProposal) {
    return;
  }
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: new Date().toISOString(),
    type: audit.passed ? "system.skill_evolution_audit_passed" : "system.skill_evolution_audit_failed",
    title: audit.passed ? "Skill evolution audit passed" : "Skill evolution audit failed",
    summary: audit.summary,
    status: audit.passed ? "success" : "blocked",
    meta: {
      skill_id: auditedProposal.skillId,
      reflection_id: auditedProposal.sourceReflectionId,
      proposal_id: auditedProposal.id,
      proposal_status: auditedProposal.status,
      audit_report_path: auditPath,
    },
  }));

  const auditDynamicRisk = buildSkillEvolutionDynamicRiskSummary(auditedProposal, null, config);
  const auditDynamicCeiling = isSkillEvolutionAutomationStage(auditDynamicRisk.automation_ceiling)
    ? auditDynamicRisk.automation_ceiling
    : "auto_validate";
  if (audit.passed
    && config.skillEvolution.autoValidate
    && config.skillEvolution.riskTiering.enabled
    && !isAutomationStageAllowedForCeiling(auditDynamicCeiling, "auto_validate")) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: "system.skill_evolution_automation_blocked",
      title: "Skill evolution automation blocked",
      summary: `Automatic skill evolution stopped before validation because dynamic risk lowered the automation ceiling to ${auditDynamicCeiling}.`,
      status: "blocked",
      meta: buildDynamicAutomationCeilingBlockMeta(reflection.skillId, "auto_validate", auditDynamicRisk, {
        reflectionId: reflection.id,
        proposalId: auditedProposal.id,
      }),
    }));
    return;
  }

  if (!audit.passed || !config.skillEvolution.autoValidate || !isAutomationStageAllowedForTier(riskTier, "auto_validate", config)) {
    if (audit.passed && config.skillEvolution.autoValidate && config.skillEvolution.riskTiering.enabled
      && !isAutomationStageAllowedForTier(riskTier, "auto_validate", config)) {
      appendEvent(createLifecycleEvent({
        jobId: reflection.jobId,
        seq: getNextSeq(reflection.jobId),
        time: new Date().toISOString(),
        type: "system.skill_evolution_automation_blocked",
        title: "Skill evolution automation blocked",
        summary: `Automatic skill evolution stopped before validation because the ${riskTier}-risk automation ceiling does not allow auto_validate.`,
        status: "blocked",
        meta: buildAutomationCeilingBlockMeta(reflection.skillId, riskTier, "auto_validate", config, {
          reflectionId: reflection.id,
          proposalId: auditedProposal.id,
        }),
      }));
    }
    return;
  }

  const baselineRecord = readJobRecord(reflection.jobId);
  const validation = config.skillEvolution.runtimeReplayInAutoPipeline
    ? await validateSkillEvolutionProposalWithRuntimeReplay({
      proposal: auditedProposal,
      reflection,
      baselineRecord,
      config,
    })
    : validateSkillEvolutionProposal({
      proposal: auditedProposal,
      reflection,
      baselineRecord,
      config,
    });
  const validationPath = persistSkillDeploymentValidationReport(validation, config.skillEvolution.candidateDir);
  const validatedProposal = updateSkillEvolutionProposal(auditedProposal.id, (current) => ({
    ...current,
    status: validation.passed ? "validated" : "validation_failed",
    validationReportPath: validationPath,
  }), config.skillEvolution.candidateDir);
  if (!validatedProposal) {
    return;
  }
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: new Date().toISOString(),
    type: validation.passed ? "system.skill_evolution_validation_passed" : "system.skill_evolution_validation_failed",
    title: validation.passed ? "Skill evolution validation passed" : "Skill evolution validation failed",
    summary: validation.summary,
    status: validation.passed ? "success" : "blocked",
    meta: {
      skill_id: validatedProposal.skillId,
      reflection_id: validatedProposal.sourceReflectionId,
      proposal_id: validatedProposal.id,
      proposal_status: validatedProposal.status,
      validation_report_path: validationPath,
    },
  }));
  const validationSummary = buildSkillEvolutionValidationSummary(validation);
  const dynamicRisk = buildSkillEvolutionDynamicRiskSummary(validatedProposal, validationSummary, config);
  const dynamicCeiling = isSkillEvolutionAutomationStage(dynamicRisk.automation_ceiling)
    ? dynamicRisk.automation_ceiling
    : "auto_validate";
  if (config.skillEvolution.autoAccept
    && config.skillEvolution.riskTiering.enabled
    && !isAutomationStageAllowedForCeiling(dynamicCeiling, "auto_accept")) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: "system.skill_evolution_automation_blocked",
      title: "Skill evolution automation blocked",
      summary: `Automatic skill evolution stopped before acceptance because dynamic risk lowered the automation ceiling to ${dynamicCeiling}.`,
      status: "blocked",
      meta: buildDynamicAutomationCeilingBlockMeta(reflection.skillId, "auto_accept", dynamicRisk, {
        reflectionId: reflection.id,
        proposalId: validatedProposal.id,
      }),
    }));
    return;
  }
  if (!shouldAutoAcceptSkillEvolution(validation, config) || !isAutomationStageAllowedForTier(riskTier, "auto_accept", config)) {
    if (shouldAutoAcceptSkillEvolution(validation, config) && config.skillEvolution.riskTiering.enabled
      && !isAutomationStageAllowedForTier(riskTier, "auto_accept", config)) {
      appendEvent(createLifecycleEvent({
        jobId: reflection.jobId,
        seq: getNextSeq(reflection.jobId),
        time: new Date().toISOString(),
        type: "system.skill_evolution_automation_blocked",
        title: "Skill evolution automation blocked",
        summary: `Automatic skill evolution stopped before acceptance because the ${riskTier}-risk automation ceiling does not allow auto_accept.`,
        status: "blocked",
        meta: buildAutomationCeilingBlockMeta(reflection.skillId, riskTier, "auto_accept", config, {
          reflectionId: reflection.id,
          proposalId: validatedProposal.id,
        }),
      }));
    }
    return;
  }

  try {
    applyAcceptedSkillProposal(validatedProposal, config.skillEvolution.candidateDir);
  } catch {
    return;
  }
  const decisionRecord: SkillEvolutionDecisionRecord = {
    proposalId: validatedProposal.id,
    skillId: validatedProposal.skillId,
    decision: "accepted",
    reason: "Automatically accepted after passing audit and validation.",
    createdAt: new Date().toISOString(),
  };
  persistSkillEvolutionDecisionRecord(decisionRecord, config.skillEvolution.candidateDir);
  const acceptedProposal = updateSkillEvolutionProposal(validatedProposal.id, (current) => ({
    ...current,
    status: "accepted",
    decidedAt: decisionRecord.createdAt,
  }), config.skillEvolution.candidateDir);
  if (!acceptedProposal) {
    return;
  }
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: decisionRecord.createdAt,
    type: "system.skill_evolution_accepted",
    title: "Skill evolution accepted",
    summary: acceptedProposal.controlPlaneSummary?.changeHeadline
      ? `${acceptedProposal.controlPlaneSummary.changeHeadline}. ${decisionRecord.reason}`
      : acceptedProposal.patchSummary,
    status: "success",
    meta: {
      skill_id: acceptedProposal.skillId,
      reflection_id: acceptedProposal.sourceReflectionId,
      proposal_id: acceptedProposal.id,
      proposal_status: acceptedProposal.status,
      patch_summary: acceptedProposal.patchSummary,
      change_summary: acceptedProposal.controlPlaneSummary?.changeHeadline ?? null,
      rationale_summary: acceptedProposal.controlPlaneSummary?.rationaleHeadline ?? null,
      changed_files: acceptedProposal.controlPlaneSummary?.changedFiles ?? acceptedProposal.targetFiles,
      decision_reason: decisionRecord.reason,
    },
  }));
}

async function verifyWorkflowPayload(
  payload: TaskExecutionPayload,
  input: {
    jobId: string;
    goal: string;
    config?: OrchestratorConfig;
    emitLifecycle: (
      type: string,
      title: string,
      summary: string,
      status: WorkflowUiEvent["status"],
      meta?: Record<string, unknown>,
      phase?: WorkflowUiEvent["phase"],
    ) => void;
    emitVerificationCheck?: (check: VerificationCheck, verificationStatus: string, meta?: Record<string, unknown>) => void;
  },
): Promise<Job> {
  const executorHistory = payload.taskRuns.flatMap((taskRun) => taskRun.executorHistory ?? []);
  const verificationContext: VerificationContext = {
    jobId: input.jobId,
    goal: input.goal,
    executorHistory,
    artifacts: payload.artifacts,
    taskRuns: payload.taskRuns,
    workspaceRoot: WORKSPACE_ROOT,
    runtimeRoot: RUNTIME_ROOT,
  };
  const verifierAgent = resolveRegisteredRoleAgent(input.config, "verifier");
  const verifierConfig = input.config?.agents?.[verifierAgent?.id ?? ""];
  const activeVerifiers = verifierConfig
    ? [...DEFAULT_VERIFIERS, createModelVerifier(verifierConfig.model)]
    : undefined;
  const verificationResult = await runVerifiers(verificationContext, activeVerifiers);
  const allPassed = verificationResultPassed(verificationResult);
  const verifiedJob = allPassed
    ? { ...payload.job, verificationResult }
    : { ...payload.job, verified: false, verificationResult };
  const verifierMeta = verifierAgent
    ? {
        verifier_agent_id: verifierAgent.id,
        verifier_agent_role: verifierAgent.role,
        verifier_model: verifierAgent.model,
      }
    : {};
  if (!allPassed) {
    input.emitLifecycle("system.verification_failed", "Verification reported issues", summarizeVerification(verificationResult), "blocked", {
      verifier_count: verificationResult.checks.length,
      verification_status: verificationResult.status,
      ...verifierMeta,
    });
  } else {
    input.emitLifecycle("system.verification_passed", "Verification passed", summarizeVerification(verificationResult), "success", {
      verifier_count: verificationResult.checks.length,
      verification_status: verificationResult.status,
      ...verifierMeta,
    });
  }
  for (const check of verificationResult.checks) {
    const meta = {
      verifier_count: verificationResult.checks.length,
      verification_status: verificationResult.status,
      verification_check_name: check.name,
      verification_check_status: check.status ?? (check.passed ? "passed" : "failed"),
      verification_source: "job",
      related_artifact_ids: check.relatedArtifactIds ?? [],
      passed: check.passed,
      detail: check.detail,
      ...verifierMeta,
    };
    if (input.emitVerificationCheck) {
      input.emitVerificationCheck(check, verificationResult.status, meta);
    } else {
      input.emitLifecycle(mapVerificationCheckType(check), check.passed ? "Verification check passed" : "Verification check reported issues", check.detail, mapVerificationCheckStatus(check), meta);
    }
  }
  return verifiedJob;
}

function createTeamApprovalGate(jobId: string): (tasks: readonly Task[]) => Promise<boolean> {
  return async (tasks) => {
    const taskIds = tasks.map((task) => task.id);
    const approvalRequest: ApprovalRequest = {
      id: `appr_${randomUUID().slice(0, 8)}`,
      jobId,
      taskIds,
      reason: `Approve team task execution for: ${tasks.map((task) => task.title).join(", ")}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    persistApprovalRequest(jobId, approvalRequest);

    return await new Promise<boolean>((resolve) => {
      const registered = setApprovalResolver(jobId, (decision) => {
        resolve(decision === "approved");
      });
      if (!registered) {
        resolve(false);
      }
    });
  };
}

function persistTeamApprovalSnapshot(jobId: string, event: OrchestratorEvent): void {
  if (event.type !== "workflow.task.awaiting_approval") {
    return;
  }
  const taskId = typeof event.data.task_id === "string" ? event.data.task_id : "";
  if (!taskId) {
    return;
  }
  const title = typeof event.data.title === "string" && event.data.title.trim()
    ? event.data.title.trim()
    : "Team task awaiting approval";
  const assignee = typeof event.data.assignee === "string"
    ? event.data.assignee
    : typeof event.data.role === "string"
      ? event.data.role
      : undefined;
  const dependsOn = Array.isArray(event.data.depends_on)
    ? event.data.depends_on.filter((item): item is string => typeof item === "string")
    : [];

  updateStoredJobRecord(jobId, (record) => {
    const awaitingTask = createTaskRunRecord({
      id: taskId,
      title,
      description: `Waiting for approval before running team task "${title}".`,
      status: "awaiting_approval",
      assignee,
      dependsOn,
      verified: false,
      output: "Waiting for approval.",
      attempts: 0,
      artifacts: [],
    });
    const taskRuns = record.taskRuns.some((taskRun) => taskRun.id === taskId)
      ? record.taskRuns.map((taskRun) => taskRun.id === taskId ? awaitingTask : taskRun)
      : [...record.taskRuns.filter((taskRun) => taskRun.id !== record.plan.taskRunIds[0]), awaitingTask];
    const taskRunIds = Array.from(new Set(taskRuns.map((taskRun) => taskRun.id)));
    const plan = {
      ...record.plan,
      taskRunIds,
    };
    const job = {
      ...record.job,
      status: "awaiting_approval" as const,
      verified: false,
      output: "Waiting for approval.",
      plan,
      taskRuns,
      workflowGraph: buildWorkflowGraph(plan.id, taskRuns, plan.summary),
    };
    return {
      ...record,
      savedAt: new Date().toISOString(),
      job,
      plan,
      taskRuns,
      workflowGraph: job.workflowGraph,
    };
  });
}

function updateActiveTaskJobSnapshot(jobId: string, taskRunId: string, event: WorkflowUiEvent): void {
  updateStoredJobRecord(jobId, (record) => {
    if (record.job.mode !== "task") {
      return record;
    }

    const currentTaskRun = record.taskRuns.find((taskRun) => taskRun.id === taskRunId)
      ?? createTaskRunRecord({
        id: taskRunId,
        title: "Primary Task",
        description: record.job.goal,
        status: "pending",
        verified: false,
        output: "",
        attempts: 0,
        artifacts: [],
      });

    const isTerminalJobEvent = event.type === "job.completed"
      || event.type === "job.failed"
      || event.type === "job.cancelled";

    const nextTaskRun = {
      ...currentTaskRun,
      status: event.type === "job.completed"
        ? "completed" as const
        : event.type === "job.failed"
          ? "failed" as const
          : event.type === "job.cancelled"
            ? "blocked" as const
            : event.type === "system.verification_failed"
              ? "blocked" as const
              : event.type === "executor.result" || event.type === "executor.partial_success"
                ? "in_progress" as const
                : event.type === "planner.start" || event.type === "planner.decision" || event.type === "executor.start"
                  ? "in_progress" as const
                  : currentTaskRun.status,
      output: !isTerminalJobEvent && typeof event.summary === "string" && event.summary.trim().length > 0
        ? event.summary
        : currentTaskRun.output,
      verified: typeof event.meta?.verified === "boolean"
        ? event.meta.verified
        : currentTaskRun.verified,
      attempts: event.step ? Math.max(currentTaskRun.attempts, event.step) : currentTaskRun.attempts,
    };

    if (event.type === "workflow.executor.result" || event.type === "executor.result" || event.type === "executor.partial_success") {
      const artifactCount = typeof event.meta?.artifact_count === "number" ? event.meta.artifact_count : undefined;
      void artifactCount;
    }

    const taskRuns = record.taskRuns.some((taskRun) => taskRun.id === taskRunId)
      ? record.taskRuns.map((taskRun) => taskRun.id === taskRunId ? nextTaskRun : taskRun)
      : [nextTaskRun];

    const latestTaskRun = taskRuns.find((taskRun) => taskRun.id === taskRunId) ?? nextTaskRun;
    const nextJobStatus = event.type === "job.completed"
      ? "completed" as const
      : event.type === "job.failed"
        ? "failed" as const
        : event.type === "job.cancelled"
          ? "cancelled" as const
          : event.type === "system.verification_failed"
            ? "blocked" as const
            : "running" as const;

    const job = {
      ...record.job,
      status: nextJobStatus,
      verified: typeof event.meta?.verified === "boolean" ? event.meta.verified : record.job.verified,
      output: nextJobStatus === "running"
        ? latestTaskRun.output || record.job.output
        : record.job.output,
      taskRuns,
    };

    return {
      ...record,
      savedAt: event.time,
      job,
      taskRuns,
    };
  });
}

function getServerApiKey(): string {
  return process.env.DUAL_AGENT_API_KEY?.trim() || process.env.API_KEY?.trim() || DEFAULT_API_KEY;
}

function getDefaultExposedModel(config: OrchestratorConfig): ExposedModel {
  return {
    id: OPENAI_MODEL_ID,
    object: "model",
    owned_by: "dual-agent-orchestrator",
    planner_model: config.planner.model,
    executor_model: config.executor.model,
    description: "Default dual-agent planner/executor route.",
  };
}

function getExposedModels(config: OrchestratorConfig): ExposedModel[] {
  const raw = process.env.DUAL_AGENT_MODELS?.trim();
  if (!raw) {
    return [getDefaultExposedModel(config)];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [getDefaultExposedModel(config)];
    }

    const models = parsed.flatMap((item): ExposedModel[] => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      if (!id) {
        return [];
      }

      return [{
        id,
        object: "model",
        owned_by: typeof candidate.owned_by === "string" && candidate.owned_by.trim()
          ? candidate.owned_by
          : "dual-agent-orchestrator",
        planner_model: typeof candidate.planner_model === "string" ? candidate.planner_model : undefined,
        executor_model: typeof candidate.executor_model === "string" ? candidate.executor_model : undefined,
        planner_base_url: typeof candidate.planner_base_url === "string" ? candidate.planner_base_url : undefined,
        planner_api_key: typeof candidate.planner_api_key === "string" ? candidate.planner_api_key : undefined,
        executor_base_url: typeof candidate.executor_base_url === "string" ? candidate.executor_base_url : undefined,
        executor_api_key: typeof candidate.executor_api_key === "string" ? candidate.executor_api_key : undefined,
        description: typeof candidate.description === "string" ? candidate.description : undefined,
      }];
    });

    return models.length > 0 ? models : [getDefaultExposedModel(config)];
  } catch {
    return [getDefaultExposedModel(config)];
  }
}

function resolveRequestedModel(config: OrchestratorConfig, requestedModel: string | undefined): { exposed: ExposedModel; resolvedConfig: OrchestratorConfig } {
  const exposedModels = getExposedModels(config);
  const exposed = exposedModels.find((item) => item.id === requestedModel) || exposedModels[0];
  const resolvedPlanner = {
    ...config.planner,
    model: exposed.planner_model || config.planner.model,
    baseUrl: exposed.planner_base_url || config.planner.baseUrl,
    apiKey: exposed.planner_api_key || config.planner.apiKey,
  };
  const resolvedExecutor = {
    ...config.executor,
    model: exposed.executor_model || config.executor.model,
    baseUrl: exposed.executor_base_url || config.executor.baseUrl,
    apiKey: exposed.executor_api_key || config.executor.apiKey,
  };

  return {
    exposed,
    resolvedConfig: materializeRuntimeModelSelection({
      ...config,
      planner: {
        ...resolvedPlanner,
      },
      executor: {
        ...resolvedExecutor,
      },
      modelRegistry: {
        ...config.modelRegistry,
        "planner.default": {
          ...(config.modelRegistry["planner.default"] ?? {
            id: "planner.default",
            role: "planner",
            enabled: true,
            model: resolvedPlanner,
          }),
          model: resolvedPlanner,
        },
        "executor.default": {
          ...(config.modelRegistry["executor.default"] ?? {
            id: "executor.default",
            role: "executor",
            enabled: true,
            model: resolvedExecutor,
          }),
          model: resolvedExecutor,
        },
      },
      policy: { ...config.policy },
    }),
  };
}

function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (responseAlreadyStarted(res)) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function responseAlreadyStarted(res: ServerResponse): boolean {
  const state = res as ServerResponse & { headersSent?: boolean; writableEnded?: boolean };
  return state.headersSent === true || state.writableEnded === true;
}

function jsonErrorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  classification?: {
    status?: string;
    error?: string;
    summary?: string;
  },
  extras?: Record<string, unknown>,
): void {
  jsonResponse(res, statusCode, {
    error: {
      message,
      type,
      failure_category: classifyFailure({
        type,
        status: classification?.status,
        error: classification?.error ?? message,
        summary: classification?.summary ?? message,
      }),
      ...(extras ?? {}),
    },
  });
}

function parseNonNegativeIntegerParam(
  value: string | null | undefined,
  name: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (value === null || value === undefined || value === "") {
    return { ok: true, value: undefined };
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `${name} must be a non-negative integer.` };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, message: `${name} must be a non-negative integer.` };
  }
  return { ok: true, value: parsed };
}

type JobEventQuery = {
  type?: string;
  status?: string;
  agent?: string;
  phase?: string;
  taskRunId?: string;
};

function readJobEventQuery(url: URL): JobEventQuery {
  const read = (name: string): string | undefined => {
    const value = url.searchParams.get(name)?.trim();
    return value ? value : undefined;
  };
  return {
    type: read("type"),
    status: read("status"),
    agent: read("agent"),
    phase: read("phase"),
    taskRunId: read("task_run_id") ?? read("taskRunId"),
  };
}

function eventMatchesQuery(event: WorkflowUiEvent, query: JobEventQuery): boolean {
  return (!query.type || event.type === query.type)
    && (!query.status || event.status === query.status)
    && (!query.agent || event.agent === query.agent)
    && (!query.phase || event.phase === query.phase)
    && (!query.taskRunId || event.taskRunId === query.taskRunId);
}

function parseStringSetParam(url: URL, name: string): Set<string> {
  const values = url.searchParams.getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return new Set(values);
}

function filterJobEvents(
  events: WorkflowUiEvent[],
  filters: {
    types?: Set<string>;
    statuses?: Set<string>;
    agents?: Set<string>;
    phases?: Set<string>;
    taskRunIds?: Set<string>;
    seq?: number;
    sinceSeq?: number;
  },
): WorkflowUiEvent[] {
  return events.filter((event) => {
    if (Number.isFinite(filters.sinceSeq) && event.seq <= (filters.sinceSeq as number)) {
      return false;
    }
    if (Number.isFinite(filters.seq) && event.seq !== filters.seq) {
      return false;
    }
    if (filters.types && filters.types.size > 0 && !filters.types.has(event.type)) {
      return false;
    }
    if (filters.statuses && filters.statuses.size > 0 && !filters.statuses.has(event.status)) {
      return false;
    }
    if (filters.agents && filters.agents.size > 0 && !filters.agents.has(event.agent)) {
      return false;
    }
    if (filters.phases && filters.phases.size > 0 && !filters.phases.has(event.phase)) {
      return false;
    }
    if (filters.taskRunIds && filters.taskRunIds.size > 0 && (!event.taskRunId || !filters.taskRunIds.has(event.taskRunId))) {
      return false;
    }
    return true;
  });
}

function secondsUntilCircuitHalfOpen(): number {
  return Math.max(1, Math.ceil((plannerCircuit.openUntil - Date.now()) / 1000));
}

function isPlannerCircuitOpen(): boolean {
  return plannerCircuit.openUntil > Date.now();
}

function assertPlannerCircuitClosed(): void {
  if (isPlannerCircuitOpen()) {
    throw new ServiceUnavailableError(
      "Planner is temporarily unavailable after repeated upstream failures.",
      secondsUntilCircuitHalfOpen()
    );
  }
}

function markPlannerSuccess(): void {
  plannerCircuit.consecutiveFailures = 0;
  plannerCircuit.openUntil = 0;
  plannerCircuit.lastFailureAt = 0;
  plannerCircuit.lastFailureMessage = "";
}

function markPlannerFailure(message: string): ServiceUnavailableError {
  plannerCircuit.consecutiveFailures += 1;
  plannerCircuit.lastFailureAt = Date.now();
  plannerCircuit.lastFailureMessage = message;

  if (plannerCircuit.consecutiveFailures >= PLANNER_FAILURE_THRESHOLD) {
    plannerCircuit.openUntil = Date.now() + PLANNER_COOLDOWN_MS;
  }

  return new ServiceUnavailableError(
    plannerCircuit.openUntil > Date.now()
      ? "Planner is temporarily unavailable after repeated upstream failures."
      : "Planner request failed. Please retry shortly.",
    plannerCircuit.openUntil > Date.now() ? secondsUntilCircuitHalfOpen() : 5
  );
}

function serviceUnavailableResponse(res: ServerResponse, message: string, retryAfterSeconds: number): void {
  if (responseAlreadyStarted(res)) {
    return;
  }
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.end(JSON.stringify({
    error: {
      message,
      type: "service_unavailable",
      failure_category: classifyFailure({
        type: "service_unavailable",
        status: "failed",
        error: message,
        summary: message,
      }),
      retry_after: retryAfterSeconds,
    },
  }));
}

function getHeaderValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? "";
  }
  return raw ?? "";
}

function isTruthyFlag(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function shouldIncludeWorkflowEvents(req: IncomingMessage, requested?: boolean): boolean {
  if (requested === true) {
    return true;
  }
  return isTruthyFlag(getHeaderValue(req, "x-dual-agent-workflow-events"))
    || isTruthyFlag(getHeaderValue(req, "x-workflow-events"));
}

function shouldMirrorProgressToContent(requested?: boolean): boolean {
  return requested !== false;
}

function isAuthorized(req: IncomingMessage): boolean {
  const expectedKey = getServerApiKey();
  const authHeader = getHeaderValue(req, "authorization");
  const xApiKey = getHeaderValue(req, "x-api-key");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  return bearer === expectedKey || xApiKey.trim() === expectedKey;
}

function unauthorizedResponse(res: ServerResponse): void {
  jsonResponse(res, 401, {
    error: {
      message: "Unauthorized. Provide Authorization: Bearer <api_key> or X-API-Key.",
      type: "authentication_error",
    },
  });
}

function getMessageText(message: OpenAIMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

function getAnthropicContentText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

function extractWorkingDirectoryHint(text: string): string {
  if (!text) {
    return "";
  }

  const patterns = [
    /\bcwd\s*[:=]\s*([^\r\n]+)/i,
    /\bworking directory\s*[:=]\s*([^\r\n]+)/i,
    /<cwd>\s*([^<]+)\s*<\/cwd>/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

function truncateToolResultContent(content: string): string {
  const normalized = content.trim();
  if (normalized.length <= MAX_TOOL_RESULT_CHARS) {
    return normalized;
  }

  const headLength = 1500;
  const tailLength = 300;
  const omitted = normalized.length - headLength - tailLength;
  const head = normalized.slice(0, headLength);
  const tail = normalized.slice(-tailLength);
  return `${head}\n... [truncated ${omitted} chars] ...\n${tail}`;
}

export function summarizeToolResultContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_TOOL_CONTEXT_CHARS) {
    return normalized;
  }
  return normalized.startsWith("{") || normalized.startsWith("[")
    ? compressJsonOutput(normalized, MAX_TOOL_CONTEXT_CHARS)
    : compressToolOutput(normalized, MAX_TOOL_CONTEXT_CHARS);
}

function normalizeChatMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.map((message) => ({
    role: message.role || "user",
    content: getMessageText(message),
  }));
}

function normalizeResponsesInput(input: string | ResponseInputItem[] | undefined, instructions?: string): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions.trim() });
  }
  if (typeof input === "string" && input.trim()) {
    messages.push({ role: "user", content: input.trim() });
    return messages;
  }
  if (Array.isArray(input)) {
    return messages.concat(input.map((item) => ({
      role: item.role || "user",
      content: typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .filter((part) => part && part.type === "text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
              .join("\n")
              .trim()
          : "",
    })));
  }
  return messages;
}

function normalizeAnthropicMessages(messages: AnthropicMessage[] | undefined, system?: string | AnthropicContentBlock[]): OpenAIMessage[] {
  const normalized: OpenAIMessage[] = [];
  const systemText = getAnthropicContentText(system);
  if (systemText) {
    normalized.push({ role: "system", content: systemText });
  }
  if (Array.isArray(messages)) {
    normalized.push(...messages.map((message) => ({
      role: message.role || "user",
      content: getAnthropicContentText(message.content),
    })));
  }
  return normalized;
}

function normalizeAnthropicToolMessages(messages: AnthropicMessage[] | undefined, system?: string | AnthropicContentBlock[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  const systemText = getAnthropicContentText(system);
  if (systemText) {
    normalized.push({ role: "system", content: systemText });
  }

  for (const message of messages || []) {
    const role = message.role || "user";
    const content = message.content;

    if (typeof content === "string") {
      normalized.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    if (role === "assistant") {
      const textParts = content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();

      const toolCalls = content
        .filter((part) => part?.type === "tool_use" && typeof part.name === "string")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input || {}),
          },
        }));

      normalized.push({
        role: "assistant",
        content: textParts,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    const toolResults = content.filter((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
    if (toolResults.length > 0) {
      for (const part of toolResults) {
        normalized.push({
          role: "tool",
          tool_call_id: part.tool_use_id,
          content: summarizeToolResultContent(typeof part.content === "string"
            ? part.content
            : typeof part.text === "string"
              ? part.text
              : JSON.stringify(part.content ?? "")),
        });
      }
      continue;
    }

    normalized.push({
      role,
      content: content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim(),
    });
  }

  return normalized;
}

function safeParseToolInput(argumentsText: string | undefined): Record<string, unknown> {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isSuccessfulNativeToolResult(content: string): boolean {
  return /"ok"\s*:\s*true/i.test(content) || /"summary"\s*:\s*"Wrote file/i.test(content) || /"summary"\s*:\s*"Read file/i.test(content);
}

function extractLatestOpenAIWriteToolCompletion(messages: OpenAIMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "tool" || previousMessage?.role !== "assistant" || !Array.isArray(previousMessage.tool_calls)) return false;
  const matchedTool = previousMessage.tool_calls.find((call) => call?.id === lastMessage.tool_call_id);
  if (matchedTool?.function?.name !== "write_file") return false;
  return isSuccessfulNativeToolResult(getMessageText(lastMessage));
}

function extractLatestAnthropicWriteToolCompletion(messages: AnthropicMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "user" || previousMessage?.role !== "assistant") return false;
  if (!Array.isArray(lastMessage.content) || !Array.isArray(previousMessage.content)) return false;
  const latestToolResult = [...lastMessage.content].reverse().find((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
  if (!latestToolResult) return false;
  const matchedToolUse = previousMessage.content.find((part) => part?.type === "tool_use" && part.id === latestToolResult.tool_use_id);
  if (matchedToolUse?.name !== "write_file") return false;
  const content = typeof latestToolResult.content === "string"
    ? latestToolResult.content
    : typeof latestToolResult.text === "string"
      ? latestToolResult.text
      : JSON.stringify(latestToolResult.content ?? "");
  return isSuccessfulNativeToolResult(content);
}

function extractLatestOpenAIResearchReadCompletion(messages: OpenAIMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "tool" || previousMessage?.role !== "assistant" || !Array.isArray(previousMessage.tool_calls)) return false;
  const matchedTool = previousMessage.tool_calls.find((call) => call?.id === lastMessage.tool_call_id);
  if (matchedTool?.function?.name !== "read_file") return false;
  return isSuccessfulNativeToolResult(getMessageText(lastMessage));
}

function extractLatestAnthropicResearchReadCompletion(messages: AnthropicMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "user" || previousMessage?.role !== "assistant") return false;
  if (!Array.isArray(lastMessage.content) || !Array.isArray(previousMessage.content)) return false;
  const latestToolResult = [...lastMessage.content].reverse().find((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
  if (!latestToolResult) return false;
  const matchedToolUse = previousMessage.content.find((part) => part?.type === "tool_use" && part.id === latestToolResult.tool_use_id);
  if (matchedToolUse?.name !== "read_file") return false;
  const content = typeof latestToolResult.content === "string"
    ? latestToolResult.content
    : typeof latestToolResult.text === "string"
      ? latestToolResult.text
      : JSON.stringify(latestToolResult.content ?? "");
  return isSuccessfulNativeToolResult(content);
}

function countToolModeRounds(messages: ChatMessage[]): number {
  return messages.filter((message) => message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0).length;
}

export function shouldForceTextResponseForToolMessage(message: ChatMessage | undefined): boolean {
  if (!message || message.role !== "tool") {
    return false;
  }
  const content = typeof message.content === "string" ? message.content : "";
  return content.includes("command-results")
    || content.includes("[...") 
    || content.includes("truncated")
    || content.length > MAX_TOOL_CONTEXT_CHARS;
}

function buildUserGoal(messages: OpenAIMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const systemContext = messages
    .filter((message) => message.role === "system")
    .map((message) => getMessageText(message))
    .filter(Boolean)
    .join("\n");
  const cwdHint = extractWorkingDirectoryHint(systemContext);

  if (lastUserMessage) {
    const goal = getMessageText(lastUserMessage);
    return cwdHint && !goal.includes(cwdHint)
      ? `${goal}\n\nCurrent working directory: ${cwdHint}`
      : goal;
  }

  return messages
    .map((message) => getMessageText(message))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isClaudeControlMessage(goal: string): boolean {
  const trimmed = goal.trim();
  return trimmed === "/init"
    || trimmed.startsWith("/init ")
    || /<command-name>\s*\/init\s*<\/command-name>/i.test(trimmed)
    || /<command-message>\s*init\s*<\/command-message>/i.test(trimmed)
    || /^\[SUGGESTION MODE:/i.test(trimmed);
}

function hasAnthropicToolHistory(messages: AnthropicMessage[] | undefined): boolean {
  for (const message of messages || []) {
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    if (content.some((part) => part?.type === "tool_use" || part?.type === "tool_result")) {
      return true;
    }
  }
  return false;
}

function buildClaudeControlResponse(goal: string): TaskExecutionPayload | null {
  const trimmed = goal.trim();
  if (!isClaudeControlMessage(trimmed)) {
    return null;
  }

  const isInitCommand = trimmed === "/init"
    || trimmed.startsWith("/init ")
    || /<command-name>\s*\/init\s*<\/command-name>/i.test(trimmed)
    || /<command-message>\s*init\s*<\/command-message>/i.test(trimmed);
  const output = isInitCommand
    ? "Dual Agent Orchestrator is ready. Existing CLAUDE.md is present, and I can inspect the repo, diagnose issues, make code changes, and run validation in this workspace."
    : "";
  const taskRun = createTaskRunRecord({
    id: "taskrun_control",
    title: "Claude control message",
    description: trimmed,
    status: "completed",
    verified: true,
    output,
    attempts: 0,
    artifacts: [],
  });
  const plan = createPlanRecord({
    id: "plan_control",
    goal: trimmed,
    mode: "task",
    taskRunIds: [taskRun.id],
    summary: "Short-circuited Claude control message.",
  });
  const job = createJobRecord({
    id: "job_control",
    goal: trimmed,
    mode: "task",
    status: "completed",
    verified: true,
    output,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  });

  return {
    content: output,
    logPath: "",
    resolvedModel: "control",
    job,
    plan,
    taskRuns: [taskRun],
    artifacts: [],
  };
}

function splitContentForStreaming(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  if (content.includes("\n")) {
    const lineChunks = content.match(/[^\r\n]+(?:\r?\n)*/g) ?? [];
    const meaningfulChunks = lineChunks.filter((chunk) => chunk.trim().length > 0);
    if (meaningfulChunks.length > 0) {
      return meaningfulChunks;
    }
  }

  const normalized = content.trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.map((word, index) => index === words.length - 1 ? word : `${word} `);
  }

  return [normalized];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let raw = "";
    let totalBytes = 0;
    const decoder = new TextDecoder();
    req.on("data", (chunk) => {
      const str = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      totalBytes += Buffer.byteLength(str);
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds maximum size of 10MB."));
        return;
      }
      raw += str;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(new Error("Invalid JSON in request body."));
      }
    });
    req.on("error", reject);
  });
}

function buildModelsResponse(config = loadConfig()): unknown {
  return {
    object: "list",
    data: getExposedModels(config).map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: model.owned_by,
      metadata: {
        planner_model: model.planner_model || config.planner.model,
        executor_model: model.executor_model || config.executor.model,
        executor_candidates: config.modelRouting.executorCandidates,
        description: model.description || "",
      },
    })),
  };
}

function buildHealthResponse(
  config = loadConfig(),
  executorHealthResults?: ModelHealthResult[],
): HealthResponse {
  const circuitOpen = isPlannerCircuitOpen();
  const executorHealthSummary = summarizeExecutorHealth(executorHealthResults ?? []);
  const probedHealthyCandidates = executorHealthResults
    ?.filter((result) => result.status === "healthy")
    .map((result) => result.modelId) ?? [];
  const recentIntentRoutes = summarizeRecentIntentRoutes();
  const availableSkills = listAvailableSkills(config);
  const builtinSkills = listBuiltinSkills(config);
  const installedSkills = listInstalledSkills(config);
  const goalsSummary = summarizeGoals();
  const skillEvolutionProposals = listSkillEvolutionProposals(config.skillEvolution.candidateDir);
  const lastProposalAt = skillEvolutionProposals
    .map((proposal) => proposal.createdAt)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  return {
    status: circuitOpen ? "degraded" : "ok",
    planner: {
      model: config.planner.model,
      base_url: config.planner.baseUrl,
      circuit_open: circuitOpen,
      consecutive_failures: plannerCircuit.consecutiveFailures,
      retry_after: circuitOpen ? secondsUntilCircuitHalfOpen() : 0,
      last_failure_at: plannerCircuit.lastFailureAt || null,
      last_failure_message: plannerCircuit.lastFailureMessage || null,
    },
    executor: {
      model: config.executor.model,
      base_url: config.executor.baseUrl,
      configured_candidates: config.modelRouting.executorCandidates,
      active_probe: {
        mode: "explicit_probe",
        description: "Active probe health for /health and doctor-style diagnostics. This is not the runtime lazy selection cache used during real task execution.",
        healthy_candidates: probedHealthyCandidates,
        health_summary: executorHealthSummary,
        health_checks: executorHealthResults?.map((result) => ({
          model_id: result.modelId,
          status: result.status,
          summary: result.summary,
        })) ?? [],
      },
      runtime_lazy_selection: {
        mode: "lazy_search_warmup",
        description: "Runtime lazy selection is established during the first real search/fetch executor step and is not persisted in /health responses.",
        available: false,
        selected_candidates: [],
      },
    },
    runtime: {
      auto_resume_concurrency: config.policy.autoResumeConcurrency,
      intent_routing: {
        enabled: true,
        supported_kinds: ["direct_answer", "research", "goal", "coding"],
        planner_fallback_enabled: true,
        recent_jobs: recentIntentRoutes,
      },
      goal_mode: {
        enabled: true,
        auto_insert_large_checks: config.goalMode.autoInsertLargeChecks,
        large_check_interval: config.goalMode.largeCheckInterval,
        large_check_mode: config.goalMode.largeCheckMode,
        total_goals: goalsSummary.total,
        running_goals: goalsSummary.running,
        blocked_goals: goalsSummary.blocked,
        waiting_review_goals: goalsSummary.waitingReview,
        by_status: goalsSummary.byStatus,
      },
    },
    skills: {
      enabled: config.skills.enabled,
      auto_install: config.skills.autoInstall,
      builtin_dir: config.skills.builtinDir,
      install_dir: config.skills.installDir,
      allow_sources: config.skills.allowSources,
      available_count: availableSkills.length,
      builtin_count: builtinSkills.length,
      explicit_install_count: installedSkills.filter((skill) => Boolean(getInstalledSkillRecord(config, skill.id))).length,
      installed_count: installedSkills.length,
      installed: installedSkills.map((skill) => {
        const manifest = availableSkills.find((entry) => entry.id === skill.id);
        return {
          skill_id: skill.id,
          title: manifest?.title ?? skill.id,
          install_status: skill.enabled ? "installed" : "disabled",
          source: skill.source,
          intents: manifest?.intents ?? [],
          location: skill.location,
          explicit_install: Boolean(getInstalledSkillRecord(config, skill.id)),
        };
      }),
    },
    skill_evolution: {
      enabled: config.skillEvolution.enabled,
      auto_reflect: config.skillEvolution.autoReflect,
      auto_propose: config.skillEvolution.autoPropose,
      auto_audit: config.skillEvolution.autoAudit,
      auto_validate: config.skillEvolution.autoValidate,
      auto_accept: config.skillEvolution.autoAccept,
      runtime_replay_in_auto_pipeline: config.skillEvolution.runtimeReplayInAutoPipeline,
      candidate_dir: config.skillEvolution.candidateDir,
      risk_tiering: {
        enabled: config.skillEvolution.riskTiering.enabled,
        default_tier: config.skillEvolution.riskTiering.defaultTier,
        automation_ceilings: config.skillEvolution.riskTiering.automationCeilings,
      },
      proposal_count: skillEvolutionProposals.length,
      audit_failed_count: skillEvolutionProposals.filter((proposal) => proposal.status === "audit_failed").length,
      validation_failed_count: skillEvolutionProposals.filter((proposal) => proposal.status === "validation_failed").length,
      accepted_count: skillEvolutionProposals.filter((proposal) => proposal.status === "accepted").length,
      last_proposal_at: lastProposalAt,
    },
    models: getExposedModels(config).map((model) => model.id),
  };
}

function buildSkillListResponse(config = loadConfig()): Record<string, unknown> {
  const available = listAvailableSkills(config);
  return {
    object: "list",
    data: available.map((skill) => {
      const installedRecord = getInstalledSkillRecord(config, skill.id);
      const runtimeInstalled = listInstalledSkills(config).find((entry) => entry.id === skill.id);
      return {
        skill_id: skill.id,
        version: skill.version,
        title: skill.title,
        description: skill.description,
        intents: skill.intents,
        source: skill.install.source,
        install_status: installedRecord
          ? "installed"
          : runtimeInstalled
            ? "builtin_available"
            : "available",
        auto_install_eligible: config.skills.enabled
          && config.skills.autoInstall
          && config.skills.allowSources.includes(skill.install.source),
        explicit_install: Boolean(installedRecord),
        location: runtimeInstalled?.location ?? skill.install.location,
      };
    }),
  };
}

async function handleListSkills(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  jsonResponse(res, 200, buildSkillListResponse(config));
}

async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ skill_id?: string }>(req);
  const skillId = typeof body.skill_id === "string" ? body.skill_id.trim() : "";
  if (!skillId) {
    throw new Error("`skill_id` must be a non-empty string.");
  }
  const config = getRuntimeConfig();
  const result = installSkillById(config, skillId);
  const statusCode = result.status === "installed" || result.status === "already_installed"
    ? 200
    : result.status === "blocked" || result.status === "unavailable"
      ? 409
      : 400;
  jsonResponse(res, statusCode, {
    skill_id: result.skillId,
    status: result.status,
    reason: result.reason,
    source: result.source ?? null,
    location: result.location ?? result.record?.location ?? null,
    record: result.record ?? null,
  });
}

function buildSkillReflectionsResponse(skillId: string, candidateDir: string, limit?: number): Record<string, unknown> {
  const records = listSkillReflectionRecords(skillId, candidateDir);
  const data = Number.isFinite(limit) && (limit as number) >= 0
    ? records.slice(0, limit as number)
    : records;
  return {
    object: "list",
    skill_id: skillId,
    count: data.length,
    data,
  };
}

async function handleListSkillReflections(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  const config = getRuntimeConfig();
  if (!getSkillManifest(skillId, config)) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill not found: ${skillId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  jsonResponse(res, 200, buildSkillReflectionsResponse(skillId, config.skillEvolution.candidateDir, limit));
}

function buildSkillReflectionFromRecord(record: StoredJobRecord): ReturnType<typeof buildSkillReflectionRecord> {
  const events = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
  const selectedSkill = resolveSelectedSkillSummary(record, events);
  const skillVerification = resolveSkillVerificationSummary(record);
  const skillOutcome = buildSkillOutcomeSummary(record, events, selectedSkill, skillVerification);
  return buildSkillReflectionRecord(skillOutcome, {
    record,
    events,
  });
}

function findLatestSkillJobRecord(skillId: string): StoredJobRecord | null {
  for (const stored of listStoredJobs()) {
    const record = readJobRecord(stored.id);
    if (!record) {
      continue;
    }
    const selectedSkillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
    if (selectedSkillId === skillId) {
      return record;
    }
  }
  return null;
}

function findLatestSkillReflectionRecord(skillId: string, candidateDir: string): SkillReflectionRecord | null {
  return listSkillReflectionRecords(skillId, candidateDir)[0] ?? null;
}

function findReflectionForProposalCreate(
  config: OrchestratorConfig,
  input: { skillId?: string; reflectionId?: string },
): SkillReflectionRecord | null {
  const requestedSkillId = input.skillId?.trim() ?? "";
  const requestedReflectionId = input.reflectionId?.trim() ?? "";
  if (requestedSkillId && requestedReflectionId) {
    return readSkillReflectionRecord(requestedSkillId, requestedReflectionId, config.skillEvolution.candidateDir);
  }
  if (requestedReflectionId) {
    for (const skill of listAvailableSkills(config)) {
      const reflection = readSkillReflectionRecord(skill.id, requestedReflectionId, config.skillEvolution.candidateDir);
      if (reflection) {
        return reflection;
      }
    }
    return null;
  }
  if (requestedSkillId) {
    return findLatestSkillReflectionRecord(requestedSkillId, config.skillEvolution.candidateDir);
  }
  return null;
}

function appendBulletToMarkdownSection(markdown: string, heading: string, bullet: string): string {
  const headingPattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(line.trim()));
  if (headingIndex === -1) {
    return `${markdown.trimEnd()}\n\n## ${heading}\n${bullet}\n`;
  }
  let insertIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      insertIndex = index;
      break;
    }
  }
  lines.splice(insertIndex, 0, bullet);
  const next = lines.join("\n");
  return headingPattern.test(next) ? next : `${next.trimEnd()}\n`;
}

function buildStructuredSkillMarkdown(
  reflection: SkillReflectionRecord,
  existingMarkdown: string | null,
  skillId: string,
): string {
  const title = skillId;
  const coreBullet = reflection.recommendedAction === "patch_verification"
    ? `- Clarify the verification-critical steps for the ${reflection.reflectionKind} scenario: ${reflection.reason}`
    : `- Refine the core procedure for the ${reflection.reflectionKind} scenario: ${reflection.reason}`;
  const appendixBullet = `- Auto-evolve note (${reflection.reflectionKind}): ${reflection.reason}`;

  const template = [
    `# Skill: ${title}`,
    "",
    "## Core Procedure",
    "- Start from the most relevant repository evidence before taking downstream action.",
    "",
    "## Scenario Extensions",
    "- Add scenario-specific guidance here when repeated runs expose a reusable pattern.",
    "",
    "## Appendix",
    "- Capture recurring pitfalls, evidence expectations, and reminders here.",
    "",
  ].join("\n");

  let markdown = existingMarkdown && existingMarkdown.trim().length > 0
    ? existingMarkdown
    : template;
  if (!/^#\s+Skill:/im.test(markdown)) {
    markdown = `# Skill: ${title}\n\n${markdown.trimStart()}`;
  }
  if (!/^##\s+Core Procedure\s*$/im.test(markdown)) {
    markdown = `${markdown.trimEnd()}\n\n## Core Procedure\n- Establish the stable body steps for this skill.\n`;
  }
  if (!/^##\s+Scenario Extensions\s*$/im.test(markdown)) {
    markdown = `${markdown.trimEnd()}\n\n## Scenario Extensions\n- Add scenario-specific extensions here.\n`;
  }
  if (!/^##\s+Appendix\s*$/im.test(markdown)) {
    markdown = `${markdown.trimEnd()}\n\n## Appendix\n- Capture recurring pitfalls and reminders here.\n`;
  }

  if (reflection.recommendedAction !== "append_appendix") {
    markdown = appendBulletToMarkdownSection(markdown, "Core Procedure", coreBullet);
  }
  markdown = appendBulletToMarkdownSection(markdown, "Appendix", appendixBullet);
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function buildSkillEvolutionProposal(
  reflection: SkillReflectionRecord,
  candidateDir: string,
  config: OrchestratorConfig,
): SkillEvolutionProposal {
  return generateSkillEvolutionProposal({
    reflection,
    candidateDir,
    config,
    manifest: getSkillManifest(reflection.skillId, config),
  });
}

async function handleCreateSkillReflection(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  const config = getRuntimeConfig();
  if (!getSkillManifest(skillId, config)) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill not found: ${skillId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const body = await readJsonBody<{ job_id?: string }>(req);
  const requestedJobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  const record = requestedJobId
    ? readJobRecord(requestedJobId)
    : findLatestSkillJobRecord(skillId);

  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: requestedJobId
          ? `Job not found: ${requestedJobId}`
          : `No job history found for skill ${skillId}.`,
        type: "not_found_error",
      },
    });
    return;
  }

  const selectedSkillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
  if (selectedSkillId !== skillId) {
    jsonResponse(res, 409, {
      error: {
        message: `Job ${record.job.id} is associated with skill ${selectedSkillId ?? "unknown"}, not ${skillId}.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const reflection = buildSkillReflectionFromRecord(record);
  if (!reflection) {
    jsonResponse(res, 409, {
      error: {
        message: `Unable to build a reflection for skill ${skillId} from job ${record.job.id}.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const path = persistSkillReflectionRecord(reflection, config.skillEvolution.candidateDir);
  jsonResponse(res, 201, {
    skill_id: skillId,
    job_id: record.job.id,
    reflection,
    path,
  });
}

async function handleCreateSkillProposal(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  const config = getRuntimeConfig();
  if (!getSkillManifest(skillId, config)) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill not found: ${skillId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const body = await readJsonBody<{ reflection_id?: string }>(req);
  const requestedReflectionId = typeof body.reflection_id === "string" ? body.reflection_id.trim() : "";
  const reflection = requestedReflectionId
    ? readSkillReflectionRecord(skillId, requestedReflectionId, config.skillEvolution.candidateDir)
    : findLatestSkillReflectionRecord(skillId, config.skillEvolution.candidateDir);

  if (!reflection) {
    jsonResponse(res, 404, {
      error: {
        message: requestedReflectionId
          ? `Reflection not found: ${requestedReflectionId}`
          : `No reflection history found for skill ${skillId}.`,
        type: "not_found_error",
      },
    });
    return;
  }

  const proposal = buildSkillEvolutionProposal(reflection, config.skillEvolution.candidateDir, config);
  const path = persistSkillEvolutionProposal(proposal, config.skillEvolution.candidateDir);
  const candidatePath = getSkillEvolutionProposalCandidateRoot(proposal.id, config.skillEvolution.candidateDir);
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: proposal.createdAt,
    type: "system.skill_evolution_proposed",
    title: "Skill evolution proposed",
    summary: proposal.patchSummary,
    status: "running",
    meta: {
      skill_id: proposal.skillId,
      reflection_id: proposal.sourceReflectionId,
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      patch_summary: proposal.patchSummary,
      change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
      rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
      changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
    },
  }));
  jsonResponse(res, 201, {
    skill_id: skillId,
    reflection_id: reflection.id,
    proposal,
    path,
    candidate_path: candidatePath,
  });
}

async function handleListSkillEvolutionProposals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const ops = buildSkillEvolutionOpsSummary(config);
  const proposals = listSkillEvolutionProposals(config.skillEvolution.candidateDir);
  jsonResponse(res, 200, {
    object: "list",
    summary: isObjectRecord(ops.summary) ? ops.summary : {},
    data: proposals
      .map((proposal) => buildSkillEvolutionProposalControlPlaneRecord(proposal, config, proposals)),
  });
}

async function handleSkillEvolutionOps(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  jsonResponse(res, 200, buildSkillEvolutionOpsSummary(config));
}

async function handleGetSkillEvolutionProposal(_req: IncomingMessage, res: ServerResponse, proposalId: string): Promise<void> {
  const config = getRuntimeConfig();
  const proposal = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!proposal) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  jsonResponse(res, 200, buildSkillEvolutionProposalControlPlaneRecord(proposal, config));
}

async function handleCreateSkillEvolutionProposal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const body = await readJsonBody<{ skill_id?: string; reflection_id?: string }>(req);
  const reflection = findReflectionForProposalCreate(config, {
    skillId: typeof body.skill_id === "string" ? body.skill_id : undefined,
    reflectionId: typeof body.reflection_id === "string" ? body.reflection_id : undefined,
  });
  if (!reflection) {
    jsonResponse(res, 404, {
      error: {
        message: "No matching reflection found for proposal creation.",
        type: "not_found_error",
      },
    });
    return;
  }

  const proposal = buildSkillEvolutionProposal(reflection, config.skillEvolution.candidateDir, config);
  const path = persistSkillEvolutionProposal(proposal, config.skillEvolution.candidateDir);
  const candidatePath = getSkillEvolutionProposalCandidateRoot(proposal.id, config.skillEvolution.candidateDir);
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: proposal.createdAt,
    type: "system.skill_evolution_proposed",
    title: "Skill evolution proposed",
    summary: proposal.patchSummary,
    status: "running",
    meta: {
      skill_id: proposal.skillId,
      reflection_id: proposal.sourceReflectionId,
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      patch_summary: proposal.patchSummary,
      change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
      rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
      changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
    },
  }));
  jsonResponse(res, 201, {
    skill_id: reflection.skillId,
    reflection_id: reflection.id,
    proposal,
    path,
    candidate_path: candidatePath,
  });
}

async function handleAuditSkillEvolutionProposal(_req: IncomingMessage, res: ServerResponse, proposalId: string): Promise<void> {
  const config = getRuntimeConfig();
  const existing = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!existing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  if (existing.status !== "draft") {
    jsonResponse(res, 409, {
      error: {
        message: `Skill evolution proposal ${proposalId} cannot be audited from status ${existing.status}.`,
        type: "conflict_error",
      },
    });
    return;
  }

  const auditing = updateSkillEvolutionProposal(proposalId, (proposal) => ({
    ...proposal,
    status: "auditing",
  }), config.skillEvolution.candidateDir);

  if (!auditing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const reflection = readSkillReflectionRecord(auditing.skillId, auditing.sourceReflectionId, config.skillEvolution.candidateDir);
  const manifest = getSkillManifest(auditing.skillId, config);
  const audit = auditSkillEvolutionProposal({
    proposal: auditing,
    reflection,
    manifest,
  });
  const path = persistSkillAuditReport(audit, config.skillEvolution.candidateDir);
  const proposal = updateSkillEvolutionProposal(proposalId, (current) => ({
    ...current,
    status: audit.passed ? "validated" : "audit_failed",
    auditReportPath: path,
  }), config.skillEvolution.candidateDir);
  if (reflection && proposal) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: audit.passed ? "system.skill_evolution_audit_passed" : "system.skill_evolution_audit_failed",
      title: audit.passed ? "Skill evolution audit passed" : "Skill evolution audit failed",
      summary: audit.summary,
      status: audit.passed ? "success" : "blocked",
      meta: {
        skill_id: proposal.skillId,
        reflection_id: proposal.sourceReflectionId,
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        audit_report_path: path,
      },
    }));
  }

  jsonResponse(res, 200, {
    proposal,
    audit,
    path,
  });
}

async function handleValidateSkillEvolutionProposal(_req: IncomingMessage, res: ServerResponse, proposalId: string): Promise<void> {
  const config = getRuntimeConfig();
  const existing = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!existing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  if (existing.status !== "validated") {
    jsonResponse(res, 409, {
      error: {
        message: `Skill evolution proposal ${proposalId} cannot be validated from status ${existing.status}.`,
        type: "conflict_error",
      },
    });
    return;
  }

  const reflection = readSkillReflectionRecord(existing.skillId, existing.sourceReflectionId, config.skillEvolution.candidateDir);
  const baselineRecord = reflection?.jobId ? readJobRecord(reflection.jobId) : null;
  const validation = await validateSkillEvolutionProposalWithRuntimeReplay({
    proposal: existing,
    reflection,
    baselineRecord,
    config,
  });
  const path = persistSkillDeploymentValidationReport(validation, config.skillEvolution.candidateDir);
  const proposal = updateSkillEvolutionProposal(proposalId, (current) => ({
    ...current,
    status: validation.passed ? "validated" : "validation_failed",
    validationReportPath: path,
  }), config.skillEvolution.candidateDir);
  if (reflection && proposal) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: validation.passed ? "system.skill_evolution_validation_passed" : "system.skill_evolution_validation_failed",
      title: validation.passed ? "Skill evolution validation passed" : "Skill evolution validation failed",
      summary: validation.summary,
      status: validation.passed ? "success" : "blocked",
      meta: {
        skill_id: proposal.skillId,
        reflection_id: proposal.sourceReflectionId,
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        validation_report_path: path,
      },
    }));
  }

  jsonResponse(res, 200, {
    proposal,
    validation,
    path,
  });
}

async function handleSkillEvolutionDecision(
  req: IncomingMessage,
  res: ServerResponse,
  proposalId: string,
  decision: SkillEvolutionDecisionRecord["decision"],
): Promise<void> {
  const config = getRuntimeConfig();
  const existing = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!existing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const allowedStatuses = decision === "accepted" ? new Set(["validated"]) : new Set(["validated", "validation_failed", "audit_failed", "draft"]);
  if (!allowedStatuses.has(existing.status)) {
    jsonResponse(res, 409, {
      error: {
        message: `Skill evolution proposal ${proposalId} cannot be ${decision} from status ${existing.status}.`,
        type: "conflict_error",
      },
    });
    return;
  }

  const body = await readJsonBody<{ reason?: string }>(req);
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : undefined;
  let acceptResult: { appliedFiles: string[]; rollbackDir: string } | null = null;
  if (decision === "accepted") {
    try {
      acceptResult = applyAcceptedSkillProposal(existing, config.skillEvolution.candidateDir);
    } catch (error) {
      jsonResponse(res, 409, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "conflict_error",
        },
      });
      return;
    }
  }
  const record: SkillEvolutionDecisionRecord = {
    proposalId: existing.id,
    skillId: existing.skillId,
    decision,
    reason,
    createdAt: new Date().toISOString(),
  };
  const path = persistSkillEvolutionDecisionRecord(record, config.skillEvolution.candidateDir);
  const proposal = updateSkillEvolutionProposal(proposalId, (current) => ({
    ...current,
    status: decision,
    decidedAt: record.createdAt,
  }), config.skillEvolution.candidateDir);
  const reflection = readSkillReflectionRecord(existing.skillId, existing.sourceReflectionId, config.skillEvolution.candidateDir);
  if (reflection && proposal) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: record.createdAt,
      type: decision === "accepted" ? "system.skill_evolution_accepted" : "system.skill_evolution_rejected",
      title: decision === "accepted" ? "Skill evolution accepted" : "Skill evolution rejected",
      summary: proposal.controlPlaneSummary?.changeHeadline
        ? `${proposal.controlPlaneSummary.changeHeadline}${reason ? `. ${reason}` : ""}`
        : reason ? `${proposal.patchSummary}. ${reason}` : proposal.patchSummary,
      status: decision === "accepted" ? "success" : "blocked",
      meta: {
        skill_id: proposal.skillId,
        reflection_id: proposal.sourceReflectionId,
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        patch_summary: proposal.patchSummary,
        change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
        rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
        changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
        decision_reason: reason ?? null,
      },
    }));
  }

  jsonResponse(res, 200, {
    proposal,
    decision: record,
    path,
    applied_files: acceptResult?.appliedFiles ?? [],
    rollback_path: decision === "accepted" ? getSkillEvolutionProposalRollbackRoot(existing.id, config.skillEvolution.candidateDir) : null,
  });
}

function buildWorkflowPayload(payload: Pick<TaskExecutionPayload, "job" | "plan" | "taskRuns" | "artifacts">): unknown {
  return {
    intent_route: payload.job.intentRoute ?? payload.plan.intentRoute ?? null,
    job: payload.job,
    plan: payload.plan,
    taskRuns: payload.taskRuns,
    artifacts: payload.artifacts,
  };
}

function summarizeRecentIntentRoutes(limit = 10): Record<string, unknown> {
  const records = listStoredJobs()
    .slice(0, limit)
    .map((stored) => readJobRecord(stored.id))
    .filter((record): record is StoredJobRecord => Boolean(record));
  const byKind: Record<string, number> = {};
  const latest = records.map((record) => {
    const route = record.job.intentRoute ?? record.plan.intentRoute;
    const kind = route?.kind ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    return {
      job_id: record.job.id,
      saved_at: record.savedAt,
      kind,
      source: route?.source ?? null,
      reason: route?.reason ?? null,
      mode: record.job.mode,
      status: record.job.status,
    };
  });
  return {
    sample_size: records.length,
    by_kind: byKind,
    latest,
  };
}

function buildStepList(record: StoredJobRecord): unknown[] {
  const currentTask = getWorkflowCurrentTask(record);
  const awaitingApprovalTask = getWorkflowAwaitingApprovalTask(record);
  return record.taskRuns.map((taskRun) => {
    const executorHistory = taskRun.executorHistory ?? [];
    const latestExecutorOutput = executorHistory.at(-1);
    return {
      id: taskRun.id,
      job_id: record.job.id,
      plan_id: record.plan.id,
      title: taskRun.title,
      description: taskRun.description,
      status: taskRun.status,
      assignee: taskRun.assignee,
      depends_on: taskRun.dependsOn,
      verified: taskRun.verified,
      attempts: taskRun.attempts,
      output: taskRun.output,
      artifacts: taskRun.artifacts,
      executor_history: executorHistory,
      latest_executor_status: latestExecutorOutput?.status ?? null,
      latest_executor_summary: latestExecutorOutput ? getExecutorDisplaySummary(latestExecutorOutput) : null,
      is_current_task: currentTask?.id === taskRun.id,
      is_awaiting_approval_task: awaitingApprovalTask?.id === taskRun.id,
      workflow_position: {
        index: record.taskRuns.findIndex((item) => item.id === taskRun.id) + 1,
        total: record.taskRuns.length,
      },
    };
  });
}

function latestExecutorStatus(record: StoredJobRecord): ExecutorOutput["status"] | null {
  const history = record.taskRuns.flatMap((taskRun) => taskRun.executorHistory ?? []);
  return history.at(-1)?.status ?? null;
}

function createLifecycleEvent(input: {
  jobId: string;
  seq: number;
  time: string;
  type: string;
  title: string;
  summary: string;
  status: WorkflowUiEvent["status"];
  phase?: WorkflowUiEvent["phase"];
  step?: number;
  taskRunId?: string;
  meta?: Record<string, unknown>;
}): WorkflowUiEvent {
  return createUiEvent({
    jobId: input.jobId,
    seq: input.seq,
    time: input.time,
    agent: "system",
    phase: input.phase ?? "result",
    type: input.type,
    title: input.title,
    summary: input.summary,
    status: input.status,
    step: input.step,
    taskRunId: input.taskRunId,
    meta: input.meta ?? {},
  });
}

function intentRouteToMeta(intentRoute: IntentRouteMetadata | undefined): Record<string, unknown> {
  if (!intentRoute) {
    return {};
  }
  return {
    intent_kind: intentRoute.kind,
    intent_reason: intentRoute.reason,
    intent_source: intentRoute.source,
  };
}

function mapVerificationCheckType(check: VerificationCheck): string {
  if (check.passed) {
    return "system.verification_check_passed";
  }
  return check.status === "insufficient"
    ? "system.verification_check_insufficient"
    : "system.verification_check_failed";
}

function mapVerificationCheckStatus(check: VerificationCheck): WorkflowUiEvent["status"] {
  if (check.passed) {
    return "success";
  }
  return check.status === "insufficient" ? "blocked" : "failed";
}

function createVerificationCheckEvent(input: {
  jobId: string;
  seq: number;
  time: string;
  check: VerificationCheck;
  taskRunId?: string;
  source: "task_run" | "job";
  verificationStatus?: string;
}): WorkflowUiEvent {
  const type = mapVerificationCheckType(input.check);
  const status = mapVerificationCheckStatus(input.check);
  const checkStatus = input.check.status ?? (input.check.passed ? "passed" : "failed");
  return createUiEvent({
    jobId: input.jobId,
    seq: input.seq,
    time: input.time,
    taskRunId: input.taskRunId,
    agent: "verifier",
    phase: "result",
    type,
    title: input.check.passed
      ? "Verification check passed"
      : checkStatus === "insufficient"
        ? "Verification check insufficient"
        : "Verification check failed",
    summary: `${input.check.name}: ${input.check.detail}`,
    status,
    meta: attachFailureCategory(type, status, input.check.detail, {
      verification_check_name: input.check.name,
      verification_check_status: checkStatus,
      verification_status: input.verificationStatus ?? null,
      verification_source: input.source,
      related_artifact_ids: input.check.relatedArtifactIds ?? [],
      passed: input.check.passed,
      detail: input.check.detail,
    }),
  });
}

function attachFailureCategory(
  type: string,
  status: WorkflowUiEvent["status"],
  summary: string,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const existingCategory = typeof meta.failure_category === "string" ? meta.failure_category : null;
  const failureCategory = existingCategory ?? classifyFailure({
    type,
    status,
    summary,
    error: typeof meta.error === "string" ? meta.error : undefined,
    verificationStatus: typeof meta.verification_status === "string" ? meta.verification_status : undefined,
    recoveryReason: typeof meta.recovery_reason === "string" ? meta.recovery_reason : undefined,
  });
  if (!failureCategory) {
    return meta;
  }
  return {
    ...meta,
    failure_category: failureCategory,
    failure_category_label: getFailureCategoryLabel(failureCategory),
  };
}

function buildJobEvents(record: StoredJobRecord): WorkflowUiEvent[] {
  const events: WorkflowUiEvent[] = [];
  let seq = 1;
  const push = (event: WorkflowUiEvent) => {
    events.push(event);
    seq += 1;
  };

  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: "job.created",
    title: "Job created",
    summary: "A control-plane job record was created.",
    status: "running",
    meta: {
      mode: record.job.mode,
      goal: record.job.goal,
      plan_id: record.plan.id,
      ...intentRouteToMeta(record.job.intentRoute ?? record.plan.intentRoute),
    },
  }));

  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: "plan.created",
    title: "Plan created",
    summary: record.plan.summary || "A plan was attached to the job.",
    status: "running",
    meta: {
      mode: record.plan.mode,
      task_run_ids: record.plan.taskRunIds,
      ...intentRouteToMeta(record.plan.intentRoute ?? record.job.intentRoute),
    },
  }));

  if (record.job.intentRoute ?? record.plan.intentRoute) {
    const intentRoute = record.job.intentRoute ?? record.plan.intentRoute;
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: "system.intent_routed",
      title: "Intent route selected",
      summary: `Request routed to ${intentRoute?.kind ?? "unknown"}.`,
      status: "running",
      meta: {
        ...intentRouteToMeta(intentRoute),
        mode: record.job.mode,
      },
      phase: "decision",
    }));
  }

  for (const taskRun of record.taskRuns) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: `step.${taskRun.status}`,
      title: "Task step recorded",
      summary: `${taskRun.title} is currently ${taskRun.status}.`,
      status: mapTaskRunStatusToUiStatus(taskRun.status),
      taskRunId: taskRun.id,
      meta: {
        title: taskRun.title,
        verified: taskRun.verified,
        attempts: taskRun.attempts,
        artifact_count: taskRun.artifacts.length,
        failure_category: classifyFailure({
          type: `step.${taskRun.status}`,
          status: taskRun.status,
          summary: taskRun.output,
        }),
      },
    }));

    for (const [index, executorOutput] of (taskRun.executorHistory ?? []).entries()) {
      push(createLifecycleEvent({
        jobId: record.job.id,
        seq,
        time: record.savedAt,
        type: mapExecutorHistoryType(executorOutput.status),
        title: "Executor result recorded",
        summary: getExecutorDisplaySummary(executorOutput),
        status: mapExecutorHistoryStatus(executorOutput.status),
        taskRunId: taskRun.id,
        step: index + 1,
        meta: {
          source: executorOutput.source ?? null,
          error: executorOutput.error ?? null,
          artifact_count: executorOutput.artifacts.length,
          tool_call_count: executorOutput.tool_calls_made.length,
          failure_category: classifyFailure({
            type: mapExecutorHistoryType(executorOutput.status),
            status: executorOutput.status,
            summary: getExecutorDisplaySummary(executorOutput),
            error: executorOutput.error,
            tool: executorOutput.tool_calls_made[0]?.tool,
          }),
        },
      }));
    }

    for (const check of taskRun.verificationResult?.checks ?? []) {
      push(createVerificationCheckEvent({
        jobId: record.job.id,
        seq,
        time: record.savedAt,
        check,
        taskRunId: taskRun.id,
        source: "task_run",
        verificationStatus: taskRun.verificationResult?.status,
      }));
    }
  }

  for (const check of record.job.verificationResult?.checks ?? []) {
    push(createVerificationCheckEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      check,
      source: "job",
      verificationStatus: record.job.verificationResult?.status,
    }));
  }

  for (const artifact of record.artifacts) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: "artifact.created",
      title: "Artifact created",
      summary: artifact.path
        ? `Artifact saved to ${artifact.path}.`
        : `Artifact ${artifact.id} was created.`,
      status: "success",
      taskRunId: artifact.sourceTaskRunId,
      meta: {
        artifact_id: artifact.id,
        artifact_type: artifact.type,
        path: artifact.path ?? null,
        content_preview: artifact.contentPreview ?? null,
        source: artifact.source,
        trust_level: artifact.trustLevel ?? null,
        related_task_run_id: artifact.relatedTaskRunId ?? artifact.sourceTaskRunId ?? null,
        related_step: artifact.relatedStep ?? null,
      },
    }));
  }

  const selectedSkill = resolveSelectedSkillSummary(record, events);
  const skillVerification = resolveSkillVerificationSummary(record);
  const skillOutcome = buildSkillOutcomeSummary(record, events, selectedSkill, skillVerification);
  const skillReflection = buildSkillReflectionRecord(skillOutcome, {
    record,
    events,
  });
  if (skillReflection) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: skillReflection.createdAt,
      type: "system.skill_reflection_recorded",
      title: "Skill reflection recorded",
      summary: skillReflection.reason,
      status: skillReflection.reflectionKind === "skill_defect" || skillReflection.reflectionKind === "execution_lapse"
        ? "blocked"
        : "success",
      meta: {
        skill_id: skillReflection.skillId,
        reflection_id: skillReflection.id,
        reflection_kind: skillReflection.reflectionKind,
        recommended_action: skillReflection.recommendedAction,
        verification_status: skillReflection.evidence.verificationStatus ?? null,
        failed_check_names: skillReflection.evidence.failedCheckNames,
        missing_requirements: skillReflection.evidence.missingRequirements,
        related_event_ids: skillReflection.evidence.eventIds,
        related_artifact_ids: skillReflection.evidence.artifactIds,
        silent_bypass_signal: skillReflection.evidence.silentBypassSignal ?? false,
        failure_category: skillReflection.reflectionKind === "skill_defect"
          ? "verification_failure"
          : skillReflection.reflectionKind === "execution_lapse"
            ? "execution_failure"
            : undefined,
      },
    }));
  }

  if (record.control?.cancelledAt) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.control.cancelledAt,
      type: "job.cancelled",
      title: "Job cancelled",
      summary: "The job was cancelled.",
      status: "blocked",
      meta: {
        cancellation_requested_at: record.control.cancellationRequestedAt ?? null,
        failure_category: classifyFailure({
          type: "job.cancelled",
          status: "blocked",
          summary: "The job was cancelled.",
        }),
      },
    }));
  }

  if (record.control?.retriedAt) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.control.retriedAt,
      type: "job.retried",
      title: "Job retried",
      summary: `A retry job was created: ${record.control.retriedToJobId ?? "unknown"}.`,
      status: "success",
      meta: {
        retried_to_job_id: record.control.retriedToJobId ?? null,
      },
    }));
  }

  if (record.control?.retryOf) {
    push(createLifecycleEvent({
      jobId: record.job.id,
      seq,
      time: record.savedAt,
      type: "job.retry_created",
      title: "Retry job created",
      summary: `This job is a retry of ${record.control.retryOf}.`,
      status: "running",
      meta: {
        retry_of: record.control.retryOf,
      },
    }));
  }

  const recoveryEvent = createRecoveryEvent(record, seq);
  if (recoveryEvent) {
    push(recoveryEvent);
  }

  push(createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.savedAt,
    type: mapJobStatusToLifecycleType(record.job.status),
    title: "Job state recorded",
    summary: describeJobState(record.job.status),
    status: mapJobStatusToUiStatus(record.job.status),
    meta: {
      verified: record.job.verified,
      output_preview: record.job.output.slice(0, 200),
      ...intentRouteToMeta(record.job.intentRoute ?? record.plan.intentRoute),
    },
  }));

  return events;
}

function mapExecutorHistoryStatus(status: ExecutorOutput["status"]): WorkflowUiEvent["status"] {
  switch (status) {
    case "success":
      return "success";
    case "partial_success":
      return "partial_success";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return "running";
  }
}

function mapExecutorHistoryType(status: ExecutorOutput["status"]): string {
  switch (status) {
    case "partial_success":
      return "executor.partial_success";
    case "failed":
      return "executor.failed";
    case "blocked":
      return "executor.blocked";
    case "success":
    default:
      return "executor.result";
  }
}

function getRecoveredTaskRunIds(record: StoredJobRecord): string[] {
  if (!record.control?.recoveredAt) {
    return [];
  }
  return record.taskRuns
    .filter((taskRun) => taskRun.status === "blocked" && /service restart/i.test(taskRun.output))
    .map((taskRun) => taskRun.id);
}

function createRecoveryEvent(record: StoredJobRecord, seq: number): WorkflowUiEvent | null {
  if (!record.control?.recoveredAt || record.control.recoveryReason !== "service_restart") {
    return null;
  }
  const autoResumedToJobId = record.control.resumedToJobId;
  const autoResumeStatus = record.control.autoResumeStatus ?? (autoResumedToJobId ? "succeeded" : record.control.autoResumeFailedAt ? "failed" : "queued");
  const autoResumeFailedAt = record.control.autoResumeFailedAt;
  const autoResumeFailureMessage = record.control.autoResumeFailureMessage;
  const queueText = typeof record.control.autoResumeQueuePosition === "number" && typeof record.control.autoResumeBatchSize === "number"
    ? ` Queue position ${record.control.autoResumeQueuePosition} of ${record.control.autoResumeBatchSize}.`
    : "";
  const summary = autoResumedToJobId
    ? `The previous in-memory run session was lost after a service restart. A resumed job was created automatically: ${autoResumedToJobId}.`
    : autoResumeFailedAt
      ? "The previous in-memory run session was lost after a service restart. Automatic resume failed and manual intervention is required."
      : autoResumeStatus === "running"
        ? "The previous in-memory run session was lost after a service restart. Automatic resume is now running."
        : `The previous in-memory run session was lost after a service restart. Automatic resume is queued.${queueText}`;
  return createLifecycleEvent({
    jobId: record.job.id,
    seq,
    time: record.control.recoveredAt,
    type: "job.recovered",
    title: "Job recovered after restart",
    summary,
    status: "blocked",
      meta: {
        recovery_reason: record.control.recoveryReason,
        recovered_at: record.control.recoveredAt,
        recoverable: !autoResumedToJobId,
        resumed_to_job_id: autoResumedToJobId ?? null,
        auto_resume_status: autoResumeStatus,
        auto_resume_queued_at: record.control.autoResumeQueuedAt ?? null,
        auto_resume_queue_position: record.control.autoResumeQueuePosition ?? null,
        auto_resume_batch_size: record.control.autoResumeBatchSize ?? null,
        auto_resume_attempted_at: record.control.autoResumeAttemptedAt ?? null,
        auto_resume_failed_at: autoResumeFailedAt ?? null,
        auto_resume_failure_message: autoResumeFailureMessage ?? null,
        job_status: record.job.status,
        affected_task_run_ids: getRecoveredTaskRunIds(record),
        failure_category: classifyFailure({
          type: "job.recovered",
          status: "blocked",
          summary,
          recoveryReason: record.control.recoveryReason,
        }),
      },
    });
}

function buildJobRouteSet(jobId: string, routeBasePath = "/v1/jobs"): {
  job_url: string;
  events_url: string;
  stream_url: string;
  timeline_url: string;
} {
  return {
    job_url: `${routeBasePath}/${jobId}`,
    events_url: `${routeBasePath}/${jobId}/events`,
    stream_url: `${routeBasePath}/${jobId}/stream`,
    timeline_url: `${routeBasePath}/${jobId}/timeline`,
  };
}

function buildResumeFollowTarget(
  sourceJobId: string,
  resumedToJobId: string | undefined,
  routeBasePath = "/v1/jobs",
): Record<string, unknown> | null {
  if (!resumedToJobId) {
    return null;
  }
  return {
    type: "resumed_job",
    source_job_id: sourceJobId,
    job_id: resumedToJobId,
    ...buildJobRouteSet(resumedToJobId, routeBasePath),
  };
}

function buildControlActions(record: StoredJobRecord, routeBasePath = "/v1/jobs"): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  const follow = buildResumeFollowTarget(record.job.id, record.control?.resumedToJobId, routeBasePath);
  if (follow) {
    actions.push({
      id: "open_resumed_timeline",
      label: "Open Resumed Timeline",
      kind: "link",
      href: follow.timeline_url,
      emphasis: "primary",
    });
    actions.push({
      id: "open_resumed_job",
      label: "Open Resumed Job",
      kind: "link",
      href: follow.job_url,
      emphasis: "secondary",
    });
  }
  if (record.control?.autoResumeFailedAt) {
    actions.push({
      id: "resume_now",
      label: "Resume Now",
      kind: "api",
      method: "POST",
      href: `${routeBasePath}/${record.job.id}/resume`,
      emphasis: "primary",
    });
    actions.push({
      id: "open_job_events",
      label: "Open Job Events",
      kind: "link",
      href: `${routeBasePath}/${record.job.id}/events`,
      emphasis: "secondary",
    });
  }
  return actions;
}

function isRecoveryLifecycleEvent(type: string): boolean {
  return type === "job.recovered"
    || type === "job.auto_resume_started"
    || type === "job.resumed"
    || type === "job.failed";
}

function getConfiguredAutoResumeConcurrency(): number {
  try {
    return loadConfig().policy.autoResumeConcurrency;
  } catch {
    return DEFAULT_AUTO_RESUME_CONCURRENCY;
  }
}

function buildEventSnapshot(record: StoredJobRecord, events: WorkflowUiEvent[], routeBasePath = "/v1/jobs"): Record<string, unknown> | null {
  if (events.length === 0) {
    return null;
  }

  const latestByAgent = (agent: WorkflowUiEvent["agent"]) => [...events].reverse().find((event) => event.agent === agent) ?? null;
  const latestExecutorEvent = latestByAgent("executor");
  const failureSummary = buildFailureSummary(events);
  const autoResumedToJobId = record.control?.resumedToJobId;
  const follow = buildResumeFollowTarget(record.job.id, autoResumedToJobId, routeBasePath);
  const actions = buildControlActions(record, routeBasePath);
  const autoResumeStatus = record.control?.autoResumeStatus ?? (autoResumedToJobId ? "succeeded" : record.control?.autoResumeFailedAt ? "failed" : null);
  const autoResumeConcurrency = getConfiguredAutoResumeConcurrency();
  const recovery = record.control?.recoveredAt && record.control.recoveryReason
    ? {
        status: "recovered",
        reason: record.control.recoveryReason,
        recovered_at: record.control.recoveredAt,
        recoverable: !autoResumedToJobId,
        resumed_to_job_id: autoResumedToJobId ?? null,
        auto_resume_status: autoResumeStatus,
        auto_resume_concurrency: autoResumeConcurrency,
        auto_resume_queued_at: record.control.autoResumeQueuedAt ?? null,
        auto_resume_queue_position: record.control.autoResumeQueuePosition ?? null,
        auto_resume_batch_size: record.control.autoResumeBatchSize ?? null,
        auto_resume_attempted_at: record.control.autoResumeAttemptedAt ?? null,
        auto_resume_failed_at: record.control.autoResumeFailedAt ?? null,
        auto_resume_failure_message: record.control.autoResumeFailureMessage ?? null,
        affected_task_run_ids: getRecoveredTaskRunIds(record),
      }
    : null;
  return {
    job_id: record.job.id,
    job_status: record.job.status,
    seq: events.at(-1)?.seq ?? 0,
    event_count: events.length,
    replay: {
      next_seq: (events.at(-1)?.seq ?? 0) + 1,
      can_resume_from: Math.max(0, events.at(0)?.seq ?? 0),
    },
    follow,
    actions,
    failure_summary: failureSummary,
    recovery,
    latest_planner: latestByAgent("planner"),
    latest_executor: latestExecutorEvent,
    latest_tool: latestByAgent("tool"),
    latest_system: latestByAgent("system"),
    latest_executor_status: typeof latestExecutorEvent?.meta.executor_status === "string"
      ? latestExecutorEvent.meta.executor_status
      : null,
    live_artifact_count: events
      .filter((event) => event.agent === "executor" && typeof event.meta.artifact_count === "number")
      .reduce((total, event) => total + Number(event.meta.artifact_count ?? 0), 0),
  };
}

function mergeJobEvents(record: StoredJobRecord, persistedEvents: WorkflowUiEvent[]): WorkflowUiEvent[] {
  if (persistedEvents.length === 0) {
    return buildJobEvents(record);
  }
  if (persistedEvents.some((event) => event.type === "job.created")) {
    if (!record.control?.recoveredAt || persistedEvents.some((event) => event.type === "job.recovered")) {
      return persistedEvents;
    }
    const recoveryEvent = createRecoveryEvent(record, Math.max(...persistedEvents.map((event) => event.seq), 0) + 1);
    return recoveryEvent ? [...persistedEvents, recoveryEvent] : persistedEvents;
  }

  const fallbackEvents = buildJobEvents(record);
  const merged = [...fallbackEvents, ...persistedEvents]
    .sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq);
  const deduped: WorkflowUiEvent[] = [];
  const seen = new Set<string>();
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const event = merged[index]!;
    const key = `${event.type}|${event.taskRunId ?? ""}|${event.step ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }

  return deduped
    .reverse()
    .map((event, index) => ({ ...event, seq: index + 1 }));
}

async function recoverInterruptedJobs(
  autoResumeConcurrency = DEFAULT_AUTO_RESUME_CONCURRENCY,
  options?: {
    jobIds?: string[];
  },
): Promise<string[]> {
  const recoveredJobIds: string[] = [];
  const recoveryCandidates: StoredJobRecord[] = [];
  const allowedJobIds = Array.isArray(options?.jobIds)
    ? new Set(options.jobIds.filter((jobId): jobId is string => typeof jobId === "string" && jobId.trim().length > 0))
    : null;
  for (const stored of listStoredJobs()) {
    if (allowedJobIds && !allowedJobIds.has(stored.id)) {
      continue;
    }
    if (stored.status !== "running") {
      continue;
    }

    const updated = updateStoredJobRecord(stored.id, (record) => {
      if (record.job.status !== "running") {
        return record;
      }

      const recoveredAt = new Date().toISOString();
      const queuedAt = recoveredAt;
      return {
        ...record,
        savedAt: recoveredAt,
        job: {
          ...record.job,
          status: "blocked",
          verified: false,
          output: "Execution was interrupted by a service restart. The job is being resumed automatically.",
        },
        taskRuns: record.taskRuns.map((taskRun) => (
          taskRun.status === "completed" || taskRun.status === "failed" || taskRun.status === "blocked" || taskRun.status === "skipped"
            ? taskRun
            : {
                ...taskRun,
                status: taskRun.status === "awaiting_approval" ? "awaiting_approval" : "blocked",
                output: taskRun.output || "Execution was interrupted by a service restart.",
              }
        )),
        control: {
          ...record.control,
          recoveredAt,
          recoveryReason: "service_restart",
          autoResumeStatus: "queued",
          autoResumeQueuedAt: queuedAt,
          autoResumeQueuePosition: recoveredJobIds.length + 1,
        },
      };
    });

    if (!updated || updated.job.status !== "blocked") {
      continue;
    }

    recoveryCandidates.push(updated);
    recoveredJobIds.push(stored.id);
  }

  const batchSize = recoveryCandidates.length;
  for (let index = 0; index < recoveryCandidates.length; index += 1) {
    updateJobControlState(recoveryCandidates[index]!.job.id, {
      autoResumeBatchSize: batchSize,
      autoResumeQueuePosition: index + 1,
    });
    const queuedRecord = readJobRecord(recoveryCandidates[index]!.job.id);
    const queuedRecoveryEvent = queuedRecord ? createRecoveryEvent(queuedRecord, getNextSeq(recoveryCandidates[index]!.job.id)) : null;
    if (queuedRecoveryEvent) {
      appendEvent(queuedRecoveryEvent);
    }
  }

  const workerCount = Math.min(autoResumeConcurrency, recoveryCandidates.length);
  const workers = Array.from({ length: workerCount }, (_, workerIndex) => (async () => {
    for (let index = workerIndex; index < recoveryCandidates.length; index += workerCount) {
      const candidate = recoveryCandidates[index]!;
      const attemptedAt = new Date().toISOString();
      updateJobControlState(candidate.job.id, {
        autoResumeStatus: "running",
        autoResumeAttemptedAt: attemptedAt,
        autoResumeFailedAt: undefined,
        autoResumeFailureMessage: undefined,
      });
      appendEvent(createLifecycleEvent({
        jobId: candidate.job.id,
        seq: getNextSeq(candidate.job.id),
        time: attemptedAt,
        type: "job.auto_resume_started",
        title: "Automatic resume started",
        summary: "The service started automatic resume for this interrupted job.",
        status: "running",
        meta: {
          recovery_reason: "service_restart",
          auto_resume_status: "running",
          auto_resume_queue_position: index + 1,
          auto_resume_batch_size: batchSize,
        },
      }));

      try {
        const resumed = await executeJobByMode(candidate.job.mode, candidate.job.goal, undefined, {
          requirePlannerCircuit: false,
        });
        updateJobControlState(candidate.job.id, {
          resumedAt: new Date().toISOString(),
          resumedToJobId: resumed.job.id,
          autoResumeStatus: "succeeded",
          autoResumeFailedAt: undefined,
          autoResumeFailureMessage: undefined,
        });
        updateJobControlState(resumed.job.id, {
          resumeOf: candidate.job.id,
        });
        appendEvent(createLifecycleEvent({
          jobId: candidate.job.id,
          seq: getNextSeq(candidate.job.id),
          time: new Date().toISOString(),
          type: "job.resumed",
          title: "Job auto-resumed",
          summary: `The service created a resumed job after restart: ${resumed.job.id}.`,
          status: "success",
          meta: {
            resumed_to_job_id: resumed.job.id,
            resumed_automatically: true,
            recovery_reason: "service_restart",
            auto_resume_status: "succeeded",
          },
        }));
      } catch (error) {
        const failureMessage = error instanceof Error ? error.message : String(error);
        updateJobControlState(candidate.job.id, {
          autoResumeStatus: "failed",
          autoResumeFailedAt: new Date().toISOString(),
          autoResumeFailureMessage: failureMessage,
        });
        appendEvent(createLifecycleEvent({
          jobId: candidate.job.id,
          seq: getNextSeq(candidate.job.id),
          time: new Date().toISOString(),
          type: "job.failed",
          title: "Automatic resume failed",
          summary: "The service restarted but could not automatically resume this job.",
          status: "failed",
          meta: attachFailureCategory(
            "job.failed",
            "failed",
            "The service restarted but could not automatically resume this job.",
            {
              error: failureMessage,
              recovery_reason: "service_restart",
              attempted_auto_resume: true,
              auto_resume_status: "failed",
            },
          ),
        }));
      }
    }
  })());

  await Promise.all(workers);
  return recoveredJobIds;
}

function buildJobResponse(record: StoredJobRecord, routeBasePath = "/v1/jobs"): unknown {
  const persistedEvents = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
  const liveSnapshot = buildEventSnapshot(record, persistedEvents, routeBasePath);
  const latestStep = record.taskRuns.at(-1);
  const liveJobStatus = typeof liveSnapshot?.job_status === "string" ? liveSnapshot.job_status : record.job.status;
  const liveArtifactCount = typeof liveSnapshot?.live_artifact_count === "number"
    ? Math.max(record.artifacts.length, liveSnapshot.live_artifact_count)
    : record.artifacts.length;
  const liveExecutorStatus = typeof liveSnapshot?.latest_executor_status === "string"
    ? liveSnapshot.latest_executor_status
    : latestExecutorStatus(record);
  const follow = buildResumeFollowTarget(record.job.id, record.control?.resumedToJobId, routeBasePath);
  const actions = buildControlActions(record, routeBasePath);
  const candidateSkills = resolveCandidateSkillsSummary(record, persistedEvents);
  const workflowSummary = buildWorkflowSummary(record);
  const selectedSkill = resolveSelectedSkillSummary(record, persistedEvents);
  const skillOutcome = buildSkillOutcomeSummary(
    record,
    persistedEvents,
    selectedSkill,
    isObjectRecord(workflowSummary.skill_verification) ? workflowSummary.skill_verification : null,
  );
  const skillReflection = buildSkillReflectionRecord(skillOutcome, {
    record,
    events: persistedEvents,
  });
  return {
    saved_at: record.savedAt,
    intent_route: record.job.intentRoute ?? record.plan.intentRoute ?? null,
    candidate_skills: candidateSkills,
    selected_skill: selectedSkill,
    skill_outcome: skillOutcome,
    skill_reflection: skillReflection,
    job: {
      ...record.job,
      status: liveJobStatus,
      candidateSkills: record.job.candidateSkills ?? candidateSkills,
      selectedSkill: record.job.selectedSkill ?? selectedSkill ?? undefined,
    },
    plan: {
      ...record.plan,
      candidateSkills: record.plan.candidateSkills ?? candidateSkills,
      selectedSkill: record.plan.selectedSkill ?? selectedSkill ?? undefined,
    },
    taskRuns: record.taskRuns,
    artifacts: record.artifacts,
    step_count: record.taskRuns.length,
    artifact_count: liveArtifactCount,
    latest_step: latestStep
      ? {
          id: latestStep.id,
          status: latestStep.status,
          verified: latestStep.verified,
          attempts: latestStep.attempts,
          latest_executor_status: liveExecutorStatus,
        }
      : null,
    workflow_summary: workflowSummary,
    control: record.control ?? {},
    follow,
    actions,
  };
}

function buildJobListItem(record: StoredJobRecord, routeBasePath = "/v1/jobs"): Record<string, unknown> {
  const persistedEvents = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
  const snapshot = buildEventSnapshot(record, persistedEvents, routeBasePath) as {
    recovery?: Record<string, unknown> | null;
  } | null;
  const response = buildJobResponse(record, routeBasePath) as Record<string, unknown>;
  const job = response.job as Record<string, unknown> | undefined;

  return {
    id: record.job.id,
    goal: record.job.goal,
    mode: record.job.mode,
    status: typeof job?.status === "string" ? job.status : record.job.status,
    verified: record.job.verified,
    intent_route: response.intent_route ?? null,
    candidate_skills: response.candidate_skills ?? [],
    selected_skill: response.selected_skill ?? null,
    saved_at: response.saved_at,
    step_count: response.step_count,
    artifact_count: response.artifact_count,
    latest_step: response.latest_step,
    control: response.control,
    follow: response.follow,
    actions: response.actions,
    workflow_summary: response.workflow_summary ?? null,
    ...buildJobRouteSet(record.job.id, routeBasePath),
    recovery: snapshot?.recovery ?? null,
  };
}

function buildListedJobsResponse(routeBasePath = "/v1/jobs"): Array<Record<string, unknown>> {
  return listStoredJobs().flatMap((stored) => {
    const record = readJobRecord(stored.id);
    if (!record) {
      return [{
        id: stored.id,
        goal: stored.goal,
        status: stored.status,
        saved_at: stored.savedAt,
        ...buildJobRouteSet(stored.id, routeBasePath),
      }];
    }
    return [buildJobListItem(record, routeBasePath)];
  });
}

function normalizeJobDashboardFilter(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function getJobRouteKind(record: StoredJobRecord): string {
  return normalizeJobDashboardFilter(record.job.intentRoute?.kind ?? record.plan.intentRoute?.kind ?? "unknown");
}

function buildListedJobsPageResponse(
  routeBasePath = "/jobs",
  options?: {
    page?: number;
    pageSize?: number;
    status?: string | null;
    route?: string | null;
    query?: string | null;
  },
): {
  object: "list";
  data: Array<Record<string, unknown>>;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
    has_prev: boolean;
    has_next: boolean;
  };
  counts: {
    by_status: Record<string, number>;
    by_route: Record<string, number>;
  };
} {
  const pageSize = Math.min(Math.max(options?.pageSize ?? 50, 1), 100);
  const page = Math.max(options?.page ?? 1, 1);
  const statusFilter = normalizeJobDashboardFilter(options?.status);
  const routeFilter = normalizeJobDashboardFilter(options?.route);
  const query = String(options?.query ?? "").trim().toLowerCase();

  type DashboardJobRow = {
    id: string;
    goal: string;
    status: string;
    routeKind: string;
    fallback?: Record<string, unknown>;
    record?: StoredJobRecord;
  };

  const buildFallbackRow = (stored: { id: string; savedAt: string; status: Job["status"]; goal: string }): DashboardJobRow => ({
    id: stored.id,
    goal: stored.goal,
    status: normalizeJobDashboardFilter(stored.status),
    routeKind: "unknown",
    fallback: {
      id: stored.id,
      goal: stored.goal,
      status: stored.status,
      saved_at: stored.savedAt,
      ...buildJobRouteSet(stored.id, routeBasePath),
    },
  });

  const queryRows = listStoredJobs()
    .filter((stored) => {
      if (!query) {
        return true;
      }
      return stored.id.toLowerCase().includes(query) || stored.goal.toLowerCase().includes(query);
    })
    .map(buildFallbackRow);

  const routeScopedRows = routeFilter
    ? queryRows.flatMap<DashboardJobRow>((row) => {
        const record = readJobRecord(row.id);
        if (!record) {
          return routeFilter === "unknown" ? [row] : [];
        }
        const routeKind = getJobRouteKind(record);
        if (routeKind !== routeFilter) {
          return [];
        }
        return [{
          id: record.job.id,
          goal: record.job.goal,
          status: normalizeJobDashboardFilter(record.job.status),
          routeKind,
          record,
        }];
      })
    : queryRows;

  const byStatus = routeScopedRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const statusScopedRows = statusFilter
    ? routeScopedRows.filter((row) => row.status === statusFilter)
    : routeScopedRows;

  const total = statusScopedRows.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRows = statusScopedRows.slice(start, start + pageSize);
  const hydratePageRecords = Boolean(query || routeFilter);
  const pageItems = pageRows.flatMap((row) => {
    if (row.record) {
      return [{
        row: {
          ...row,
          routeKind: getJobRouteKind(row.record),
        },
        item: buildJobListItem(row.record, routeBasePath),
      }];
    }
    const record = hydratePageRecords ? readJobRecord(row.id) : null;
    if (record) {
      return [{
        row: {
          ...row,
          status: normalizeJobDashboardFilter(record.job.status),
          routeKind: getJobRouteKind(record),
        },
        item: buildJobListItem(record, routeBasePath),
      }];
    }
    return [{
      row,
      item: row.fallback ?? {
        id: row.id,
        goal: row.goal,
        status: row.status,
        ...buildJobRouteSet(row.id, routeBasePath),
      },
    }];
  });

  const routeCountRows = routeFilter
    ? statusScopedRows
    : pageItems.map((entry) => entry.row);
  const byRoute = routeCountRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.routeKind] = (acc[row.routeKind] ?? 0) + 1;
    return acc;
  }, {});

  return {
    object: "list",
    data: pageItems.map((entry) => entry.item),
    pagination: {
      page: safePage,
      page_size: pageSize,
      total,
      total_pages: totalPages,
      has_prev: safePage > 1,
      has_next: safePage < totalPages,
    },
    counts: {
      by_status: byStatus,
      by_route: byRoute,
    },
  };
}

function buildWorkflowSummary(record: StoredJobRecord): Record<string, unknown> {
  const counts = {
    pending: 0,
    in_progress: 0,
    awaiting_approval: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };

  for (const taskRun of record.taskRuns) {
    switch (taskRun.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "in_progress":
        counts.in_progress += 1;
        break;
      case "awaiting_approval":
        counts.awaiting_approval += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
    }
  }

  const currentTask = getWorkflowCurrentTask(record);
  const awaitingApprovalTask = getWorkflowAwaitingApprovalTask(record);
  const workflowGraph = record.workflowGraph ?? record.job.workflowGraph ?? buildWorkflowGraph(record.plan.id, record.taskRuns, record.plan.summary);
  const persistedEvents = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
  const candidateSkills = resolveCandidateSkillsSummary(record, persistedEvents);
  const selectedSkill = resolveSelectedSkillSummary(record, persistedEvents);
  const skillVerification = resolveSkillVerificationSummary(record);
  const skillEvolution = resolveSkillEvolutionSummary(record);
  const skillOutcome = buildSkillOutcomeSummary(record, persistedEvents, selectedSkill, skillVerification);
  const skillReflection = buildSkillReflectionRecord(skillOutcome, {
    record,
    events: persistedEvents,
  });

  return {
    workflow_id: record.plan.id,
    intent_route: record.job.intentRoute ?? record.plan.intentRoute ?? null,
    candidate_skills: candidateSkills,
    selected_skill: selectedSkill,
    skill_verification: skillVerification,
    skill_evolution: skillEvolution,
    skill_outcome: skillOutcome,
    skill_reflection: skillReflection,
    task_counts: counts,
    current_task: currentTask
      ? {
          id: currentTask.id,
          title: currentTask.title,
          status: currentTask.status,
          assignee: currentTask.assignee ?? null,
          depends_on: currentTask.dependsOn,
          verified: currentTask.verified,
          attempts: currentTask.attempts,
        }
      : null,
    awaiting_approval_task: awaitingApprovalTask
      ? {
          id: awaitingApprovalTask.id,
          title: awaitingApprovalTask.title,
          status: awaitingApprovalTask.status,
          assignee: awaitingApprovalTask.assignee ?? null,
        }
      : null,
    workflow_graph: workflowGraph,
    dag: workflowGraph,
    replan_history: workflowGraph.replan_history,
  };
}

function buildFailureSummary(events: WorkflowUiEvent[]): {
  total: number;
  by_category: Record<string, number>;
  latest_category: string | null;
  latest_summary: string | null;
} {
  const failures = events
    .filter((event) => isObjectRecord(event.meta) && typeof event.meta.failure_category === "string" && event.meta.failure_category.trim().length > 0)
    .map((event) => ({
      category: event.meta.failure_category as string,
      summary: event.summary,
    }));

  const byCategory: Record<string, number> = {};
  for (const failure of failures) {
    byCategory[failure.category] = (byCategory[failure.category] ?? 0) + 1;
  }

  const latest = failures.at(-1) ?? null;
  return {
    total: failures.length,
    by_category: byCategory,
    latest_category: latest?.category ?? null,
    latest_summary: latest?.summary ?? null,
  };
}

function getWorkflowCurrentTask(record: StoredJobRecord): TaskRun | null {
  return record.taskRuns.find((taskRun) =>
    taskRun.status === "awaiting_approval"
    || taskRun.status === "in_progress"
    || taskRun.status === "pending",
  ) ?? null;
}

function getWorkflowAwaitingApprovalTask(record: StoredJobRecord): TaskRun | null {
  return record.taskRuns.find((taskRun) => taskRun.status === "awaiting_approval") ?? null;
}

function buildWorkflowEvent(type: string, workflow: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    workflow,
    ...extra,
  });
}

function buildChatCompletionResponse(model: string, content: string, workflow?: unknown): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    workflow,
  };
}

function buildToolChatCompletionResponse(model: string, toolCalls: Array<{ id: string; name: string; arguments: string }>): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildChatCompletionChunk(model: string, id: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  });
}

function buildToolChatCompletionChunk(model: string, id: string, toolCall: { id: string; name: string; arguments: string }, finishReason: string | null, toolIndex = 0): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: toolIndex,
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
  });
}

function formatProgressUpdate(event: OrchestratorEvent): string | null {
  switch (event.type) {
    case "workflow.step.start":
      return buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, "正在规划下一步。");
    case "workflow.planner.decision": {
      const summary = getPlannerDecisionText(event.data);
      return summary
        ? buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, humanizePlannerSummary(summary))
        : buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, "正在整理下一步策略。");
    }
    case "workflow.executor.start": {
      const instruction = typeof event.data.instruction === "string" ? event.data.instruction.trim() : "";
      return instruction
        ? buildProgressCard(`步骤 ${event.step ?? 1} · ${inferExecutorPhaseLabel(instruction)}`, humanizeExecutorInstruction(instruction))
        : buildProgressCard(`步骤 ${event.step ?? 1} · 执行中`, "正在处理当前任务。");
    }
    case "workflow.executor.result": {
      const summary = getExecutorDisplaySummary(event.data);
      return summary
        ? buildProgressCard(`步骤 ${event.step ?? 1} · ${inferExecutionSummaryPhaseLabel(summary)}`, humanizeExecutionSummary(summary))
        : null;
    }
    case "workflow.tool.start": {
      const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
      return buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, humanizeToolStart(tool));
    }
    case "workflow.tool.result": {
      const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
      const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
      return summary
        ? buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, humanizeToolSummary(tool, summary))
        : buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, "当前操作已完成。");
    }
    default:
      return null;
  }
}

function buildProgressCard(title: string, summary: string): string {
  return `\n\n[${title}]\n${summary}\n`;
}

function compactProgressText(text: string, maxLength: number): string {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, ": ")
    .trim();

  const firstSentence = normalized.match(/.*?[.!?](\s|$)/)?.[0]?.trim() ?? normalized;
  const preferred = firstSentence.length >= 24 ? firstSentence : normalized;
  return truncateToolResultContent(preferred).slice(0, maxLength).trim();
}

function phaseLabelForTool(tool: string): string {
  switch (tool) {
    case "web_search":
      return "检索中";
    case "url_fetch":
    case "read_file":
      return "取证中";
    case "write_file":
      return "写作中";
    default:
      return "处理中";
  }
}

function inferExecutorPhaseLabel(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  if (/search the web|web searches?|web_search/i.test(normalized)) {
    return "检索中";
  }
  if (/read the artifact|read_file|runtime\/command-results|extract/i.test(normalized)) {
    return "取证中";
  }
  if (/write|report|summary|markdown|final/i.test(normalized)) {
    return "写作中";
  }
  return "执行中";
}

function inferExecutionSummaryPhaseLabel(summary: string): string {
  const normalized = summary.trim();
  if (/Found \d+ results/i.test(normalized)) {
    return "筛选中";
  }
  if (/Fetch failed/i.test(normalized) || /Read file/i.test(normalized)) {
    return "取证中";
  }
  if (/Wrote file/i.test(normalized)) {
    return "写作中";
  }
  if (/Collected \d+ useful artifacts/i.test(normalized)) {
    return "归纳中";
  }
  return "执行中";
}

function humanizePlannerSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (/search|web|benchmark|evidence|comparison/i.test(normalized)) {
    return "正在确定检索重点，并准备补齐关键对比证据。";
  }
  if (/consolidate|summarize|final/i.test(normalized)) {
    return "正在收拢已有信息，准备形成阶段性结论。";
  }
  if (/fetch|read|artifact|extract/i.test(normalized)) {
    return "正在检查现有资料，并决定下一步证据路径。";
  }
  return compactProgressText(normalized, 120);
}

function humanizeExecutorInstruction(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  if (/search the web|web searches?|web_search/i.test(normalized)) {
    return "正在检索支撑资料和基准对比信息。";
  }
  if (/read the artifact|read_file|runtime\/command-results|extract/i.test(normalized)) {
    return "正在读取已收集资料，并提取可用证据。";
  }
  if (/write|report|summary|markdown|final/i.test(normalized)) {
    return "正在整理已有发现，准备输出总结。";
  }
  return compactProgressText(normalized, 120);
}

function humanizeExecutionSummary(summary: string): string {
  const normalized = summary.trim();
  if (/Found \d+ results/i.test(normalized)) {
    const count = normalized.match(/Found (\d+) results/i)?.[1] ?? "多条";
    return `已收集 ${count} 条候选资料，正在筛选高质量证据。`;
  }
  if (/Fetch failed/i.test(normalized)) {
    return "部分页面暂时无法访问，正在调整证据路径。";
  }
  if (/Collected \d+ useful artifacts/i.test(normalized)) {
    const count = normalized.match(/Collected (\d+) useful artifacts/i)?.[1] ?? "多份";
    return `已沉淀 ${count} 份有效资料，准备进入归纳阶段。`;
  }
  if (/Read file/i.test(normalized)) {
    return "已读取一份已保存资料，并提炼关键细节。";
  }
  if (/Search queries returned irrelevant results/i.test(normalized)) {
    return "本轮检索结果相关性不足，正在调整关键词和证据路径。";
  }
  if (/Fetched\s+(\S+)/i.test(normalized)) {
    return "已读取目标页面，正在提取其中的关键信息。";
  }
  if (/Wrote file\s+(.+)/i.test(normalized)) {
    const target = normalized.match(/Wrote file\s+(.+)/i)?.[1]?.trim() ?? "";
    const fileName = target.split(/[\\/]/).pop() || target;
    return target ? `报告已保存到本地文件：${fileName}` : "报告已保存到本地文件。";
  }
  return compactProgressText(normalized, 120);
}

function humanizeToolStart(tool: string): string {
  switch (tool) {
    case "web_search":
      return "正在搜索候选资料来源。";
    case "url_fetch":
      return "正在打开页面，提取更具体的证据。";
    case "read_file":
      return "正在读取已保存的过程资料。";
    default:
      return `正在执行 ${tool}。`;
  }
}

function humanizeToolSummary(tool: string, summary: string): string {
  const normalized = summary.trim();
  if (tool === "web_search") {
    const count = normalized.match(/Found (\d+) results/i)?.[1];
    if (count) {
      return `已找到 ${count} 条候选结果，正在筛选可信来源。`;
    }
    if (/returned no parsed results/i.test(normalized)) {
      return "这次搜索还没有拿到可用结果，正在尝试调整关键词。";
    }
  }

  if (tool === "url_fetch") {
    if (/Fetched\s+(\S+)/i.test(normalized)) {
      const url = normalized.match(/Fetched\s+(\S+)/i)?.[1] ?? "source";
      return `已抓取页面内容：${url}。`;
    }
    if (/Fetch failed/i.test(normalized)) {
      return "目标页面暂时无法读取，正在尝试其他来源。";
    }
  }

  if (tool === "read_file") {
    if (/Read file/i.test(normalized)) {
      return "已载入保存的过程资料，正在深入分析。";
    }
  }

  return compactProgressText(normalized, 120);
}

type ProgressAggregationState = {
  tool: string;
  step?: number;
  startCount: number;
  resultCount: number;
  successCount: number;
  failureCount: number;
  candidateResults: number;
  summaries: string[];
};

function shouldAggregateToolProgress(tool: string): boolean {
  return tool === "web_search" || tool === "url_fetch" || tool === "read_file";
}

function createProgressAggregationState(tool: string, step?: number): ProgressAggregationState {
  return {
    tool,
    step,
    startCount: 0,
    resultCount: 0,
    successCount: 0,
    failureCount: 0,
    candidateResults: 0,
    summaries: [],
  };
}

function buildAggregatedToolStart(tool: string): string {
  switch (tool) {
    case "web_search":
      return buildProgressCard("检索中", "正在扩展检索范围，补充更多候选资料。");
    case "url_fetch":
      return buildProgressCard("取证中", "正在打开候选页面，提取关键证据。");
    case "read_file":
      return buildProgressCard("取证中", "正在读取已保存资料，补充现有证据。");
    default:
      return buildProgressCard(phaseLabelForTool(tool), humanizeToolStart(tool));
  }
}

function buildAggregatedToolResult(state: ProgressAggregationState): string | null {
  if (state.resultCount === 0) {
    return null;
  }

  if (state.tool === "web_search") {
    if (state.resultCount <= 1) {
      const summary = state.summaries.at(-1);
      return summary ? buildProgressCard("检索中", summary) : null;
    }
    const total = state.candidateResults > 0 ? `累计找到 ${state.candidateResults} 条候选结果` : "已补充多轮候选结果";
    return buildProgressCard("检索中", `已完成 ${state.resultCount} 轮搜索，${total}，正在筛选可信来源。`);
  }

  if (state.tool === "url_fetch") {
    if (state.resultCount <= 1) {
      const summary = state.summaries.at(-1);
      return summary ? buildProgressCard("取证中", summary) : null;
    }
    if (state.failureCount > 0 && state.successCount > 0) {
      return buildProgressCard("取证中", `已读取 ${state.successCount} 个页面，另有 ${state.failureCount} 个页面暂时无法访问，正在切换其他来源。`);
    }
    if (state.failureCount > 0) {
      return buildProgressCard("取证中", `连续 ${state.failureCount} 个页面暂时无法读取，正在调整证据来源。`);
    }
    return buildProgressCard("取证中", `已读取 ${state.successCount} 个页面，正在整理其中的关键证据。`);
  }

  if (state.tool === "read_file") {
    if (state.resultCount <= 1) {
      const summary = state.summaries.at(-1);
      return summary ? buildProgressCard("取证中", summary) : null;
    }
    return buildProgressCard("取证中", `已读取 ${state.resultCount} 份过程资料，正在提炼其中的关键信息。`);
  }

  const summary = state.summaries.at(-1);
  return summary ? buildProgressCard(phaseLabelForTool(state.tool), summary) : null;
}

function accumulateToolProgressResult(state: ProgressAggregationState, event: OrchestratorEvent): void {
  const ok = event.data.ok === true;
  const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
  state.resultCount += 1;
  state.successCount += ok ? 1 : 0;
  state.failureCount += ok ? 0 : 1;

  if (summary) {
    state.summaries.push(humanizeToolSummary(state.tool, summary));
    if (state.tool === "web_search") {
      const count = summary.match(/Found (\d+) results/i)?.[1];
      if (count) {
        state.candidateResults += Number(count);
      }
    }
  }
}

function sseWrite(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`);
}

function sseWriteEvent(res: ServerResponse, eventName: string, payload: string, eventId?: number): void {
  if (typeof eventId === "number" && Number.isFinite(eventId)) {
    res.write(`id: ${eventId}\n`);
  }
  res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
}

function normalizeIncomingTools(tools: unknown): typeof TOOL_DEFINITIONS {
  if (!Array.isArray(tools) || tools.length === 0) {
    return TOOL_DEFINITIONS;
  }

  const requestedNames = tools.flatMap((tool) => {
    if (!isObjectRecord(tool)) {
      return [];
    }

    if (typeof tool.name === "string") {
      return [tool.name];
    }

    if (tool.type === "function" && isObjectRecord(tool.function) && typeof tool.function.name === "string") {
      return [tool.function.name];
    }

    return [];
  });

  const filtered = TOOL_DEFINITIONS.filter((tool) => requestedNames.includes(tool.name));
  return filtered.length > 0 ? filtered : TOOL_DEFINITIONS;
}

function normalizeOpenAIToolMessages(messages: OpenAIMessage[]): ChatMessage[] {
  return messages.flatMap<ChatMessage>((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }

    const asRecord = message as Record<string, unknown>;
    const role = typeof asRecord.role === "string" ? asRecord.role : "user";
    const content = getMessageText(message);

    if (role === "tool") {
      return [{
        role: "tool",
        content: truncateToolResultContent(content),
        tool_call_id: typeof asRecord.tool_call_id === "string" ? asRecord.tool_call_id : undefined,
        name: typeof asRecord.name === "string" ? asRecord.name : undefined,
      }];
    }

    const toolCalls = Array.isArray(asRecord.tool_calls)
      ? asRecord.tool_calls.flatMap((call) => {
          if (!isObjectRecord(call)) {
            return [];
          }
          const fn = isObjectRecord(call.function) ? call.function : {};
        return [{
          id: typeof call.id === "string" ? call.id : undefined,
          type: typeof call.type === "string" ? call.type : "function",
          function: {
            name: typeof fn.name === "string" ? fn.name : undefined,
            arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
          },
        }];
      })
      : undefined;

    return [{
      role,
      content,
      tool_calls: toolCalls,
    }];
  });
}

async function executeTaskGoal(
  userGoal: string,
  model: string | undefined,
  requirePlannerCircuit: boolean,
  onEvent?: OrchestratorEventCallback,
  fixedIds?: FixedTaskIds,
  onRegistered?: (jobId: string) => void,
  presetIntentRoute?: IntentRouteMetadata,
): Promise<TaskExecutionPayload> {
  ensureRuntimeDirectories();
  const jobId = fixedIds?.jobId ?? `job_${randomUUID()}`;
  const planId = fixedIds?.planId ?? `plan_${randomUUID()}`;
  const taskRunId = fixedIds?.taskRunId ?? `taskrun_${randomUUID()}`;
  const abortController = new AbortController();
  const emitUiEvent = (event: WorkflowUiEvent) => {
    appendEvent(event);
    updateActiveTaskJobSnapshot(jobId, taskRunId, event);
  };
  const emitLifecycle = (type: string, title: string, summary: string, status: WorkflowUiEvent["status"], meta: Record<string, unknown> = {}, phase: WorkflowUiEvent["phase"] = "result") => {
    emitUiEvent(createLifecycleEvent({
      jobId,
      seq: getNextSeq(jobId),
      time: new Date().toISOString(),
      type,
      title,
      summary,
      status,
      phase,
      taskRunId,
      meta: attachFailureCategory(type, status, summary, meta),
    }));
  };
  const emitVerificationCheck = (check: VerificationCheck, verificationStatus: string, meta: Record<string, unknown> = {}) => {
    emitUiEvent(createVerificationCheckEvent({
      jobId,
      seq: getNextSeq(jobId),
      time: new Date().toISOString(),
      check,
      taskRunId,
      source: "job",
      verificationStatus,
    }));
  };
  const forwardRuntimeEvent: OrchestratorEventCallback = (event) => {
    persistTeamApprovalSnapshot(jobId, event);
    emitUiEvent(normalizeWorkflowEvent(
      { type: event.type, step: event.step, data: event.data } as InternalWorkflowEvent,
      jobId,
      getNextSeq(jobId),
      new Date().toISOString(),
      taskRunId,
    ));
    onEvent?.(event);
  };

  let verificationConfig: OrchestratorConfig | undefined;
  let modelSelection: { exposed: ExposedModel; resolvedConfig: OrchestratorConfig } | undefined;
  let resolvedIntentRoute = presetIntentRoute;
  let logger: ReturnType<typeof createRunLogger> | undefined;

  registerActiveJobSession(jobId, userGoal, abortController);
  onRegistered?.(jobId);
  const pendingTaskRun = createTaskRunRecord({
    id: taskRunId,
    title: "Primary Task",
    description: userGoal,
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const pendingPlan = createPlanRecord({
    id: planId,
    goal: userGoal,
    mode: "task",
    taskRunIds: [taskRunId],
    summary: "Single-task orchestration run.",
    intentRoute: resolvedIntentRoute,
  });
  const pendingJob = createJobRecord({
    id: jobId,
    goal: userGoal,
    mode: "task",
    status: "running",
    verified: false,
    output: "Running...",
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
    intentRoute: resolvedIntentRoute,
  });
  persistWorkflowPayload({
    job: pendingJob,
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
  });
  emitLifecycle("job.created", "Job created", "A new job was created and queued for execution.", "running", {
    mode: pendingJob.mode,
    goal: pendingJob.goal,
    plan_id: pendingPlan.id,
    ...intentRouteToMeta(resolvedIntentRoute),
  }, "start");
  emitLifecycle("job.started", "Job started", "Execution started for the requested goal.", "running", {
    plan_id: pendingPlan.id,
    task_run_id: pendingTaskRun.id,
    ...intentRouteToMeta(resolvedIntentRoute),
  }, "start");

  if (!injectedTaskExecutor) {
    const baseConfig = loadConfig();
    modelSelection = resolveRequestedModel(baseConfig, model);
    verificationConfig = modelSelection.resolvedConfig;
    logger = createRunLogger(userGoal);
    resolvedIntentRoute = presetIntentRoute ?? await detectIntentRoute({
      config: modelSelection.resolvedConfig,
      userGoal,
      logger,
      options: {
        abortSignal: abortController.signal,
        jobId,
        planId,
        taskRunId,
        onEvent: forwardRuntimeEvent,
      },
      allowPlannerFallback: true,
    });
  }

  if (resolvedIntentRoute) {
    updateStoredJobRecord(jobId, (record) => {
      const plan = { ...record.plan, intentRoute: resolvedIntentRoute };
      const job = { ...record.job, intentRoute: resolvedIntentRoute, plan };
      return {
        ...record,
        savedAt: new Date().toISOString(),
        job,
        plan,
      };
    });
    emitLifecycle("system.intent_routed", "Intent route selected", `Request routed to ${resolvedIntentRoute.kind}.`, "running", {
      mode: pendingJob.mode,
      ...intentRouteToMeta(resolvedIntentRoute),
    }, "decision");
  }
  try {
    if (abortController.signal.aborted) {
      throw new Error("Run cancelled before start.");
    }

    let payload: TaskExecutionPayload;
    if (injectedTaskExecutor) {
      payload = await injectedTaskExecutor(userGoal, model, requirePlannerCircuit, {
        jobId,
        planId,
        taskRunId,
        signal: abortController.signal,
        emitEvent: forwardRuntimeEvent,
      });
    } else {
      if (requirePlannerCircuit) {
        assertPlannerCircuitClosed();
      }
      let result;
      try {
        const runOptions = {
          abortSignal: abortController.signal,
          jobId,
          planId,
          taskRunId,
          onEvent: forwardRuntimeEvent,
        };
        result = await dispatchTaskIntentRoute(
          modelSelection!.resolvedConfig,
          userGoal,
          resolvedIntentRoute ?? {
            kind: "research",
            reason: "defaulted task dispatch route",
            source: "heuristic",
          },
          logger,
          undefined,
          runOptions,
        );
        if (requirePlannerCircuit) {
          markPlannerSuccess();
        }
      } catch (error) {
        if (requirePlannerCircuit && error instanceof PlannerUnavailableError) {
          throw markPlannerFailure(error.message);
        }
        throw error;
      }

      payload = {
        content: result.output || "",
        logPath: logger!.logPath,
        resolvedModel: modelSelection!.exposed.id,
        job: {
          ...result.job,
          intentRoute: resolvedIntentRoute,
        },
        plan: {
          ...result.plan,
          intentRoute: resolvedIntentRoute,
        },
        taskRuns: result.taskRuns,
        artifacts: result.artifacts,
        intentRoute: resolvedIntentRoute,
      };
    }

    const verifiedJob = await verifyWorkflowPayload(payload, {
      jobId,
      goal: userGoal,
      config: verificationConfig,
      emitLifecycle,
      emitVerificationCheck,
    });

    const jobRecordPath = persistWorkflowPayload({
      job: verifiedJob,
      plan: payload.plan,
      taskRuns: payload.taskRuns,
      artifacts: payload.artifacts,
    });
    const persistedRecord = readJobRecord(verifiedJob.id);
    if (persistedRecord) {
      await runAutomaticSkillEvolutionForRecord(persistedRecord, verificationConfig ?? loadConfig());
    }
    emitLifecycle(mapJobStatusToLifecycleType(verifiedJob.status), "Job finished", `Job finished with status ${verifiedJob.status}.`, mapJobStatusToUiStatus(verifiedJob.status), {
      verified: verifiedJob.verified,
      output_preview: verifiedJob.output.slice(0, 200),
      log_path: payload.logPath,
      job_record_path: jobRecordPath,
    }, "final");

    console.error(`Run log: ${payload.logPath}`);
    console.error(`Job record: ${jobRecordPath}`);
    return {
      ...payload,
      job: verifiedJob,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const healthMeta = error instanceof NoHealthyExecutorError
      ? {
          failure_category: "environment_failure",
          healthy_executor_ids: [],
          executor_health_results: error.results,
        }
      : {};
    const cancelledRecord = readJobRecord(jobId);
    const wasCancelled = Boolean(cancelledRecord?.control?.cancelledAt);
    updateStoredJobRecord(jobId, (record) => ({
      ...record,
      savedAt: new Date().toISOString(),
      job: {
        ...record.job,
        status: record.control?.cancelledAt ? "cancelled" : "failed",
        verified: false,
        output: message,
      },
      taskRuns: record.taskRuns.map((taskRun) => ({
        ...taskRun,
        status: record.control?.cancelledAt ? "blocked" : "failed",
        output: taskRun.output || message,
      })),
    }));
    emitLifecycle(
      wasCancelled ? "job.cancelled" : "job.failed",
      wasCancelled ? "Job cancelled" : "Job failed",
      truncateToolResultContent(message || (wasCancelled ? "Job cancelled." : "Job failed.")),
      wasCancelled ? "blocked" : "failed",
      { error: message, ...healthMeta },
      "final",
    );
    throw error;
  } finally {
    unregisterActiveJobSession(jobId);
  }
}

async function executeTeamGoal(
  userGoal: string,
  model: string | undefined,
  fixedIds?: FixedTaskIds,
  approvalMode?: string,
  onEvent?: OrchestratorEventCallback,
  onRegistered?: (jobId: string) => void,
  intentRoute: IntentRouteMetadata = {
    kind: "goal",
    reason: "team execution path selected",
    source: "heuristic",
  },
): Promise<TaskExecutionPayload> {
  ensureRuntimeDirectories();
  const jobId = fixedIds?.jobId ?? `job_${randomUUID()}`;
  const planId = fixedIds?.planId ?? `plan_${randomUUID()}`;
  const taskRunId = fixedIds?.taskRunId ?? `taskrun_${randomUUID()}`;
  const abortController = new AbortController();
  const emitUiEvent = (event: WorkflowUiEvent) => {
    appendEvent(event);
    updateActiveTaskJobSnapshot(jobId, taskRunId, event);
  };
  const emitLifecycle = (type: string, title: string, summary: string, status: WorkflowUiEvent["status"], meta: Record<string, unknown> = {}, phase: WorkflowUiEvent["phase"] = "result") => {
    emitUiEvent(createLifecycleEvent({
      jobId,
      seq: getNextSeq(jobId),
      time: new Date().toISOString(),
      type,
      title,
      summary,
      status,
      phase,
      taskRunId,
      meta: attachFailureCategory(type, status, summary, meta),
    }));
  };
  const emitVerificationCheck = (check: VerificationCheck, verificationStatus: string, meta: Record<string, unknown> = {}) => {
    emitUiEvent(createVerificationCheckEvent({
      jobId,
      seq: getNextSeq(jobId),
      time: new Date().toISOString(),
      check,
      taskRunId,
      source: "job",
      verificationStatus,
    }));
  };
  const forwardRuntimeEvent: OrchestratorEventCallback = (event) => {
    emitUiEvent(normalizeWorkflowEvent(
      { type: event.type, step: event.step, data: event.data } as InternalWorkflowEvent,
      jobId,
      getNextSeq(jobId),
      new Date().toISOString(),
      taskRunId,
    ));
    onEvent?.(event);
  };

  registerActiveJobSession(jobId, userGoal, abortController);
  onRegistered?.(jobId);
  const pendingTaskRun = createTaskRunRecord({
    id: taskRunId,
    title: "Team Root Task",
    description: userGoal,
    status: "pending",
    verified: false,
    output: "",
    attempts: 0,
    artifacts: [],
  });
  const pendingPlan = createPlanRecord({
    id: planId,
    goal: userGoal,
    mode: "team",
    taskRunIds: [taskRunId],
    summary: "Team orchestration run.",
    intentRoute,
  });
  const pendingJob = createJobRecord({
    id: jobId,
    goal: userGoal,
    mode: "team",
    status: "running",
    verified: false,
    output: "Running...",
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
    intentRoute,
  });
  persistWorkflowPayload({
    job: pendingJob,
    plan: pendingPlan,
    taskRuns: [pendingTaskRun],
    artifacts: [],
  });
  emitLifecycle("job.created", "Job created", "A new team job was created and queued for execution.", "running", {
    mode: pendingJob.mode,
    goal: pendingJob.goal,
    plan_id: pendingPlan.id,
    ...intentRouteToMeta(intentRoute),
  }, "start");
  emitLifecycle("job.started", "Job started", "Execution started for the requested team goal.", "running", {
    plan_id: pendingPlan.id,
    task_run_id: pendingTaskRun.id,
    ...intentRouteToMeta(intentRoute),
  }, "start");
  emitLifecycle("system.intent_routed", "Intent route selected", `Request routed to ${intentRoute.kind}.`, "running", {
    mode: pendingJob.mode,
    ...intentRouteToMeta(intentRoute),
  }, "decision");

  try {
    let payload: TaskExecutionPayload;
    let verificationConfig: OrchestratorConfig | undefined;
    if (injectedTeamExecutor) {
      payload = await injectedTeamExecutor(userGoal, model, {
        jobId,
        planId,
        taskRunId,
        signal: abortController.signal,
        emitEvent: forwardRuntimeEvent,
      });
    } else {
      const config = loadConfig();
      verificationConfig = config;
      configureSearchTools(config.search);
      const logger = createRunLogger(userGoal);
      const teamAgents = resolveTeamAgents(config);
      const tracer = new Tracer(logger);
      const teamConfig = approvalMode === "always"
        ? { onApproval: createTeamApprovalGate(jobId) }
        : undefined;
      const result = await runTeam(config, userGoal, teamAgents, logger, tracer, teamConfig, undefined, {
        abortSignal: abortController.signal,
        jobId,
        planId,
        taskRunId,
        onEvent: forwardRuntimeEvent,
      });
      payload = {
        content: result.finalAnswer,
        logPath: logger.logPath,
        resolvedModel: OPENAI_MODEL_ID,
        job: {
          ...result.job,
          id: jobId,
          plan: { ...result.plan, id: planId },
          intentRoute,
        },
        plan: { ...result.plan, id: planId, intentRoute },
        taskRuns: result.taskRuns,
        artifacts: result.artifacts,
        intentRoute,
      };
    }

    const verifiedJob = await verifyWorkflowPayload(payload, {
      jobId,
      goal: userGoal,
      config: verificationConfig,
      emitLifecycle,
      emitVerificationCheck,
    });

    const jobRecordPath = persistWorkflowPayload({
      job: verifiedJob,
      plan: payload.plan,
      taskRuns: payload.taskRuns,
      artifacts: payload.artifacts,
    });
    const persistedRecord = readJobRecord(verifiedJob.id);
    if (persistedRecord) {
      await runAutomaticSkillEvolutionForRecord(persistedRecord, verificationConfig ?? loadConfig());
    }
    emitLifecycle(mapJobStatusToLifecycleType(verifiedJob.status), "Job finished", `Job finished with status ${verifiedJob.status}.`, mapJobStatusToUiStatus(verifiedJob.status), {
      verified: verifiedJob.verified,
      output_preview: verifiedJob.output.slice(0, 200),
      log_path: payload.logPath,
      job_record_path: jobRecordPath,
    }, "final");
    return {
      ...payload,
      job: verifiedJob,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const healthMeta = error instanceof NoHealthyExecutorError
      ? {
          failure_category: "environment_failure",
          healthy_executor_ids: [],
          executor_health_results: error.results,
        }
      : {};
    const cancelledRecord = readJobRecord(jobId);
    const wasCancelled = Boolean(cancelledRecord?.control?.cancelledAt);
    updateStoredJobRecord(jobId, (record) => ({
      ...record,
      savedAt: new Date().toISOString(),
      job: {
        ...record.job,
        status: record.control?.cancelledAt ? "cancelled" : "failed",
        verified: false,
        output: message,
      },
      taskRuns: record.taskRuns.map((taskRun) => ({
        ...taskRun,
        status: record.control?.cancelledAt ? "blocked" : "failed",
        output: taskRun.output || message,
      })),
    }));
    emitLifecycle(
      wasCancelled ? "job.cancelled" : "job.failed",
      wasCancelled ? "Job cancelled" : "Job failed",
      truncateToolResultContent(message || (wasCancelled ? "Job cancelled." : "Job failed.")),
      wasCancelled ? "blocked" : "failed",
      { error: message, ...healthMeta },
      "final",
    );
    throw error;
  } finally {
    unregisterActiveJobSession(jobId);
  }
}

async function executeJobByMode(
  mode: Job["mode"],
  goal: string,
  model: string | undefined,
  options?: JobExecutionOptions,
): Promise<TaskExecutionPayload> {
  if (mode === "team") {
    return executeTeamGoal(goal, model, options?.fixedIds, options?.approvalMode);
  }
  return executeTaskGoal(goal, model, options?.requirePlannerCircuit ?? true, undefined, options?.fixedIds);
}

async function executePromptByIntent(
  goal: string,
  model: string | undefined,
  onEvent?: OrchestratorEventCallback,
  onRegistered?: (jobId: string) => void,
): Promise<TaskExecutionPayload> {
  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, model);
  const intentRoute = await detectIntentRoute({
    config: modelSelection.resolvedConfig,
    userGoal: goal,
    allowPlannerFallback: true,
  });
  if (shouldDispatchToTeam(intentRoute)) {
    return executeTeamGoal(goal, model, undefined, undefined, onEvent, onRegistered, intentRoute);
  }
  return executeTaskGoal(goal, model, true, onEvent, undefined, onRegistered, intentRoute);
}

async function runTaskFromRequest(body: ChatCompletionRequest): Promise<TaskExecutionPayload> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(body.messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const controlResponse = buildClaudeControlResponse(userGoal);
  if (controlResponse) {
    return controlResponse;
  }

  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, body.model);
  const intentRoute = await detectIntentRoute({
    config: modelSelection.resolvedConfig,
    userGoal,
    allowPlannerFallback: true,
  });
  if (shouldDispatchToTeam(intentRoute)) {
    return executeTeamGoal(userGoal, body.model, undefined, undefined, undefined, undefined, intentRoute);
  }
  return executeTaskGoal(userGoal, body.model, false, undefined, undefined, undefined, intentRoute);
}

async function runTaskFromMessages(messages: OpenAIMessage[], model: string | undefined, onEvent?: OrchestratorEventCallback): Promise<TaskExecutionPayload> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const controlResponse = buildClaudeControlResponse(userGoal);
  if (controlResponse) {
    return controlResponse;
  }

  return executePromptByIntent(userGoal, model, onEvent);
}

async function runTaskFromMessagesWithRegistration(
  messages: OpenAIMessage[],
  model: string | undefined,
  onEvent?: OrchestratorEventCallback,
  onRegistered?: (jobId: string) => void,
): Promise<TaskExecutionPayload> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("`messages` must be a non-empty array.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const userGoal = buildUserGoal(normalizedMessages);
  if (!userGoal) {
    throw new Error("Unable to derive a user goal from the provided messages.");
  }

  const controlResponse = buildClaudeControlResponse(userGoal);
  if (controlResponse) {
    return controlResponse;
  }

  return executePromptByIntent(userGoal, model, onEvent, onRegistered);
}

function attachRequestAbortCancellation(
  res: ServerResponse,
  lookupJobId: () => string | null,
): () => void {
  let detached = false;
  let settled = false;

  const handleDisconnect = () => {
    if (detached || settled) {
      return;
    }
    const jobId = lookupJobId();
    if (!jobId) {
      return;
    }
    cancelActiveJobSession(jobId, `Client disconnected before response completed for job ${jobId}.`);
  };

  res.on("close", handleDisconnect);

  return () => {
    detached = true;
    settled = true;
  };
}

async function runToolMode(messages: ChatMessage[], model: string | undefined, tools: unknown, requestOverrides?: import("./providers/openai-compatible.js").CompletionOverrides): Promise<{
  resolvedModel: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  content: string;
}> {
  const baseConfig = loadConfig();
  const modelSelection = resolveRequestedModel(baseConfig, model);
  const allowedTools = normalizeIncomingTools(tools);
  const toolRoundCount = countToolModeRounds(messages);
  const lastMessage = messages[messages.length - 1];
  const forceTextResponse = toolRoundCount >= MAX_TOOL_MODE_ROUNDS
    || shouldForceTextResponseForToolMessage(lastMessage);
  const effectiveTools = forceTextResponse ? undefined : allowedTools;

  const response = await runChatCompletionDetailed(modelSelection.resolvedConfig.executor, messages, effectiveTools, undefined, requestOverrides);

  return {
    resolvedModel: modelSelection.exposed.id,
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id || `call_${Date.now()}`,
      name: call.name,
      arguments: call.arguments,
    })),
    content: response.content || "",
  };
}

async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, buildModelsResponse());
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const healthSelection = await buildHealthyExecutorRuntimeConfig(config);
  const payload = buildHealthResponse(healthSelection.config, healthSelection.results);
  if (healthSelection.healthyExecutorIds.length === 0) {
    payload.status = "degraded";
  }
  jsonResponse(res, payload.status === "ok" ? 200 : 503, payload);
}

async function handleListJobs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: buildListedJobsResponse(),
  });
}

function normalizeCreateGoalInput(body: CreateGoalRequest, config: OrchestratorConfig): CreateGoalInput {
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) {
    throw new Error("`goal` must be a non-empty string.");
  }
  const tasks: GoalTaskInput[] | undefined = Array.isArray(body.tasks)
    ? body.tasks.flatMap((task) => {
        const title = typeof task?.title === "string" ? task.title.trim() : "";
        const description = typeof task?.description === "string" ? task.description.trim() : "";
        if (!title && !description) {
          return [];
        }
        const mode: GoalTaskMode = task?.mode === "team" ? "team" : "task";
        return [{
          title: title || description,
          description: description || title,
          mode,
        }];
      })
    : undefined;
  const plannedTasks = tasks && tasks.length > 0
    ? (body.insert_large_checks === true
        ? insertLargeCheckTasks(tasks, {
            interval: config.goalMode.largeCheckInterval,
            mode: config.goalMode.largeCheckMode,
          })
        : tasks)
    : planGoalTasks(goal, {
        autoInsertLargeChecks: config.goalMode.autoInsertLargeChecks,
        largeCheckInterval: config.goalMode.largeCheckInterval,
        largeCheckMode: config.goalMode.largeCheckMode,
      });
  return {
    goal,
    tasks: plannedTasks,
  };
}

async function handleListGoals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: listGoals(),
  });
}

function buildGoalRouteSet(
  goalId: string,
  routeBasePath = "/v1/goals",
): Pick<GoalDashboardItem, "detail_url" | "timeline_url" | "events_url"> {
  return {
    detail_url: `${routeBasePath}/${goalId}`,
    timeline_url: `${routeBasePath}/${goalId}/timeline`,
    events_url: `${routeBasePath}/${goalId}/events`,
  };
}

function buildGoalActions(record: GoalRecord, routeBasePath = "/v1/goals"): GoalDashboardItem["actions"] {
  const actions: GoalDashboardItem["actions"] = [
    { label: "Timeline", href: `${routeBasePath}/${record.id}/timeline`, kind: "link", emphasis: "primary" },
    { label: "Details", href: `${routeBasePath}/${record.id}`, kind: "link" },
  ];
  if (record.status === "waiting_review") {
    actions.push({ label: "Review", href: `${routeBasePath}/${record.id}/review`, kind: "api", method: "POST" });
  } else if (record.tasks.some((task) => task.status === "blocked")) {
    actions.push({ label: "Resume", href: `${routeBasePath}/${record.id}/resume`, kind: "api", method: "POST" });
    actions.push({ label: "Retry", href: `${routeBasePath}/${record.id}/retry`, kind: "api", method: "POST" });
  } else if (record.tasks.some((task) => task.status === "failed")) {
    actions.push({ label: "Retry", href: `${routeBasePath}/${record.id}/retry`, kind: "api", method: "POST" });
  } else if (record.tasks.some((task) => task.status === "pending")) {
    actions.push({ label: "Run Next", href: `${routeBasePath}/${record.id}/run-next`, kind: "api", method: "POST" });
  }
  return actions;
}

function buildGoalListItem(record: GoalRecord, routeBasePath = "/v1/goals"): GoalDashboardItem {
  const currentTask = record.tasks.find((task) => task.id === record.currentTaskId) ?? null;
  return {
    id: record.id,
    goal: record.goal,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    completed_task_count: record.completedTaskCount,
    total_task_count: record.tasks.length,
    current_task: currentTask
      ? {
          id: currentTask.id,
          title: currentTask.title,
          status: currentTask.status,
          mode: currentTask.mode,
        }
      : null,
    final_review_status: record.finalReview.status,
    actions: buildGoalActions(record, routeBasePath),
    ...buildGoalRouteSet(record.id, routeBasePath),
  };
}

function buildListedGoalsResponse(routeBasePath = "/v1/goals"): GoalDashboardItem[] {
  return listGoals().flatMap((stored) => {
    const record = readGoal(stored.id);
    return record ? [buildGoalListItem(record, routeBasePath)] : [];
  });
}

async function handleCreateGoal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<CreateGoalRequest>(req);
  const config = getRuntimeConfig();
  const input = normalizeCreateGoalInput(body, config);
  const record = buildGoalRecord(input);
  persistGoal(record);
  appendGoalEvent(record.id, {
    type: "goal.created",
    title: "Goal created",
    summary: `Created goal ${record.id} with ${record.tasks.length} planned tasks.`,
    status: "success",
    meta: {
      goal_id: record.id,
      task_count: record.tasks.length,
      large_check_count: record.tasks.filter((task) => task.kind === "large_check").length,
      large_check_interval: config.goalMode.largeCheckInterval,
      large_check_mode: config.goalMode.largeCheckMode,
      status: record.status,
    },
  });
  jsonResponse(res, 201, buildGoalResponse(record));
}

async function handleGoalEvents(_req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const record = readGoal(goalId);
  if (!record) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  jsonResponse(res, 200, {
    object: "list",
    goal_id: goalId,
    data: readGoalEvents(goalId),
  });
}

async function handleGetGoal(_req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const record = readGoal(goalId);
  if (!record) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  jsonResponse(res, 200, buildGoalResponse(record));
}

async function handleRunNextGoal(req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const body = await readJsonBody<{ model?: string }>(req);
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  const pendingTask = existing.tasks.find((task) => task.status === "pending");
  appendGoalEvent(goalId, {
    type: "goal.run_next_started",
    title: "Run-next started",
    summary: pendingTask
      ? `Starting goal task ${pendingTask.title}.`
      : "Starting next pending goal task.",
    status: "running",
    meta: {
      goal_id: goalId,
      task_id: pendingTask?.id ?? null,
      task_title: pendingTask?.title ?? null,
      task_kind: pendingTask?.kind ?? null,
    },
  });
  let result;
  try {
    result = await runNextGoalTask(goalId, {
      executeByMode: (mode, goal, model) => executeJobByMode(mode, goal, model),
    }, typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("no pending tasks") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  appendGoalEvent(goalId, {
    type: "goal.run_next_completed",
    title: "Run-next completed",
    summary: `Task ${result.executedTask.title} finished with status ${result.executedTask.status}.`,
    status: result.executedTask.status === "completed" ? "success" : result.executedTask.status === "blocked" ? "blocked" : "failed",
    meta: {
      goal_id: goalId,
      task_id: result.executedTask.id,
      task_title: result.executedTask.title,
      task_kind: result.executedTask.kind,
      task_status: result.executedTask.status,
      job_id: result.execution.job.id,
      goal_status: result.goal.status,
      verified: result.execution.job.verified,
    },
  });
  jsonResponse(res, 200, {
    object: "goal_run",
    goal: result.goal,
    executed_task: result.executedTask,
    execution: {
      job_id: result.execution.job.id,
      status: result.execution.job.status,
      verified: result.execution.job.verified,
      output: result.execution.job.output,
    },
    control: buildGoalResponse(result.goal).control,
    recent_events: readGoalEvents(goalId).slice(-10),
    links: {
      goal: `/v1/goals/${goalId}`,
      events: `/v1/goals/${goalId}/events`,
      job: `/v1/jobs/${result.execution.job.id}`,
    },
  });
}

async function handleRetryGoal(req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const body = await readJsonBody<{ model?: string }>(req);
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  const retryableTask = [...existing.tasks].reverse().find((task) => task.status === "failed" || task.status === "blocked");
  appendGoalEvent(goalId, {
    type: "goal.retry_started",
    title: "Goal retry started",
    summary: retryableTask
      ? `Retrying goal task ${retryableTask.title}.`
      : "Retrying latest failed or blocked goal task.",
    status: "running",
    meta: {
      goal_id: goalId,
      task_id: retryableTask?.id ?? null,
      task_title: retryableTask?.title ?? null,
      task_kind: retryableTask?.kind ?? null,
    },
  });
  try {
    const result = await retryGoalTask(goalId, {
      executeByMode: (mode, goal, model) => executeJobByMode(mode, goal, model),
    }, typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined);
    appendGoalEvent(goalId, {
      type: "goal.retry_completed",
      title: "Goal retry completed",
      summary: `Retried task ${result.executedTask.title} finished with status ${result.executedTask.status}.`,
      status: result.executedTask.status === "completed" ? "success" : result.executedTask.status === "blocked" ? "blocked" : "failed",
      meta: {
        goal_id: goalId,
        task_id: result.executedTask.id,
        task_title: result.executedTask.title,
        task_kind: result.executedTask.kind,
        task_status: result.executedTask.status,
        job_id: result.execution.job.id,
        goal_status: result.goal.status,
        verified: result.execution.job.verified,
      },
    });
    jsonResponse(res, 200, {
      object: "goal_run",
      goal: result.goal,
      executed_task: result.executedTask,
      execution: {
        job_id: result.execution.job.id,
        status: result.execution.job.status,
        verified: result.execution.job.verified,
        output: result.execution.job.output,
      },
      control: buildGoalResponse(result.goal).control,
      recent_events: readGoalEvents(goalId).slice(-10),
      links: {
        goal: `/v1/goals/${goalId}`,
        events: `/v1/goals/${goalId}/events`,
        job: `/v1/jobs/${result.execution.job.id}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("not found") ? 404 : message.includes("no retryable tasks") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : statusCode === 404 ? "not_found_error" : "invalid_request_error", {
      status: "failed",
    });
  }
}

async function handleResumeGoal(_req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  try {
    const record = resumeGoal(goalId);
    const resumedTask = record.tasks.find((task) => task.status === "pending" && task.id === record.currentTaskId);
    appendGoalEvent(goalId, {
      type: "goal.resumed",
      title: "Goal resumed",
      summary: resumedTask
        ? `Resumed blocked task ${resumedTask.title}.`
        : "Goal moved back to ready state.",
      status: "success",
      meta: {
        goal_id: goalId,
        task_id: resumedTask?.id ?? null,
        task_title: resumedTask?.title ?? null,
        task_kind: resumedTask?.kind ?? null,
        goal_status: record.status,
      },
    });
    jsonResponse(res, 200, buildGoalResponse(record));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("no resumable tasks") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : "invalid_request_error", {
      status: "failed",
    });
  }
}

async function handleReviewGoal(req: IncomingMessage, res: ServerResponse, goalId: string): Promise<void> {
  const body = await readJsonBody<{ model?: string }>(req);
  const existing = readGoal(goalId);
  if (!existing) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  appendGoalEvent(goalId, {
    type: "goal.review_started",
    title: "Goal review started",
    summary: "Starting final review for the completed goal tasks.",
    status: "running",
    meta: {
      goal_id: goalId,
      completed_task_count: existing.completedTaskCount,
      total_task_count: existing.tasks.length,
    },
  });
  try {
    const result = await reviewGoal(goalId, {
      executeByMode: (mode, goal, model) => executeJobByMode(mode, goal, model),
    }, typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined);
    appendGoalEvent(goalId, {
      type: "goal.review_completed",
      title: "Goal review completed",
      summary: `Final review finished with status ${result.goal.finalReview.status}.`,
      status: result.goal.finalReview.status === "completed" ? "completed" : result.goal.finalReview.status === "blocked" ? "blocked" : "failed",
      meta: {
        goal_id: goalId,
        job_id: result.execution.job.id,
        review_status: result.goal.finalReview.status,
        goal_status: result.goal.status,
        verified: result.execution.job.verified,
      },
    });
    jsonResponse(res, 200, {
      object: "goal_review",
      goal: result.goal,
      final_review: result.goal.finalReview,
      execution: {
        job_id: result.execution.job.id,
        status: result.execution.job.status,
        verified: result.execution.job.verified,
        output: result.execution.job.output,
      },
      control: buildGoalResponse(result.goal).control,
      recent_events: readGoalEvents(goalId).slice(-10),
      links: {
        goal: `/v1/goals/${goalId}`,
        events: `/v1/goals/${goalId}/events`,
        job: `/v1/jobs/${result.execution.job.id}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("not ready for final review") || message.includes("already completed") ? 409 : 400;
    jsonErrorResponse(res, statusCode, message, statusCode === 409 ? "conflict_error" : "invalid_request_error", {
      status: "failed",
    });
  }
}

async function handleJobsDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const html = renderJobsDashboardHtml([] as Array<{
    id: string;
    goal: string;
    mode?: string;
    status: string;
  }>, {
    dataUrl: "/jobs/data",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleGoalsDashboard(_req: IncomingMessage, res: ServerResponse, routeBasePath = "/v1/goals"): Promise<void> {
  const html = renderGoalsDashboardHtml(buildListedGoalsResponse(routeBasePath), {
    dataUrl: routeBasePath === "/goals" ? "/goals/data" : "/v1/goals/data",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleBrowserListGoals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    object: "list",
    data: buildListedGoalsResponse("/goals"),
  });
}

async function handleGoalTimeline(_req: IncomingMessage, res: ServerResponse, goalId: string, routeBasePath = "/v1/goals"): Promise<void> {
  const record = readGoal(goalId);
  if (!record) {
    jsonErrorResponse(res, 404, `Goal not found: ${goalId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }
  const html = renderGoalTimelineHtml(record, readGoalEvents(goalId), {
    routeBasePath,
    apiBasePath: routeBasePath === "/goals" ? "/v1/goals" : routeBasePath,
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleBrowserListJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const pageResult = parseNonNegativeIntegerParam(url.searchParams.get("page"), "page");
  if (!pageResult.ok) {
    jsonErrorResponse(res, 400, pageResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageSizeResult = parseNonNegativeIntegerParam(url.searchParams.get("page_size"), "page_size");
  if (!pageSizeResult.ok) {
    jsonErrorResponse(res, 400, pageSizeResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  jsonResponse(res, 200, buildListedJobsPageResponse("/jobs", {
    page: Math.max(pageResult.value ?? 1, 1),
    pageSize: Math.min(Math.max(pageSizeResult.value ?? 50, 1), 100),
    status: url.searchParams.get("status"),
    route: url.searchParams.get("route"),
    query: url.searchParams.get("q"),
  }));
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<CreateJobRequest>(req);
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) {
    jsonResponse(res, 400, {
      error: {
        message: "`goal` must be a non-empty string.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  if (body.mode !== undefined && body.mode !== "task" && body.mode !== "team") {
    jsonResponse(res, 400, {
      error: {
        message: "`mode` must be either \"task\" or \"team\".",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const modelRoute = typeof body.model_route === "string" && body.model_route.trim()
    ? body.model_route.trim()
    : undefined;
  const requestedMode = body.mode === "team" ? "team" : "task";
  if (requestedMode === "team" && body.policy?.approval_mode === "always" && body.policy.async !== true) {
    jsonResponse(res, 400, {
      error: {
        message: 'team approval_mode "always" requires policy.async=true so the job can wait for /approve.',
        type: "invalid_request_error",
      },
    });
    return;
  }
  if (body.policy?.async === true) {
    const fixedIds: FixedTaskIds = {
      jobId: `job_${randomUUID()}`,
      planId: `plan_${randomUUID()}`,
      taskRunId: `taskrun_${randomUUID()}`,
    };
    const executionPromise = executeJobByMode(requestedMode, goal, modelRoute, {
      requirePlannerCircuit: true,
      fixedIds,
      approvalMode: body.policy?.approval_mode,
    });
    void executionPromise.catch(() => {
      // Failure state is already persisted inside executeTaskGoal.
    });
    const record = readJobRecord(fixedIds.jobId);

    jsonResponse(res, 202, {
      object: "job",
      job_id: fixedIds.jobId,
      status: record?.job.status ?? "running",
      accepted: true,
      stream_url: `/v1/jobs/${fixedIds.jobId}/stream`,
      events_url: `/v1/jobs/${fixedIds.jobId}/events`,
      timeline_url: `/v1/jobs/${fixedIds.jobId}/timeline`,
      ...(record ? buildJobResponse(record) as Record<string, unknown> : {
        job: {
          id: fixedIds.jobId,
          goal,
          mode: requestedMode,
          status: "running",
          verified: false,
          output: "Running...",
        },
      }),
    });
    return;
  }

  const result = await executeJobByMode(requestedMode, goal, modelRoute, {
    requirePlannerCircuit: true,
    approvalMode: body.policy?.approval_mode,
  });
  const record = readJobRecord(result.job.id);

  jsonResponse(res, 201, {
    object: "job",
    job_id: result.job.id,
    resolved_model: result.resolvedModel,
    log_path: result.logPath,
    workflow: buildWorkflowPayload(result),
    ...(record ? buildJobResponse(record) as Record<string, unknown> : {
      job: result.job,
      plan: result.plan,
      taskRuns: result.taskRuns,
      artifacts: result.artifacts,
      control: {},
    }),
  });
}

async function handleGetJob(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  jsonResponse(res, 200, buildJobResponse(record, routeBasePath));
}

async function handleGetJobArtifacts(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  jsonResponse(res, 200, {
    job_id: jobId,
    count: record.artifacts.length,
    artifacts: record.artifacts,
  });
}

async function handleGetJobSteps(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const steps = buildStepList(record);
  jsonResponse(res, 200, {
    job_id: jobId,
    count: steps.length,
    workflow_summary: buildWorkflowSummary(record),
    steps,
  });
}

async function handleGetJobRuntimeProfile(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const config = loadConfig();
  const runtimeProfile = buildRuntimeProfile(config);
  jsonResponse(res, 200, {
    job_id: jobId,
    generated_at: new Date().toISOString(),
    diagnostics_summary: {
      dependency_warnings: runtimeProfile.diagnostics.dependencyChecks.filter((check) => check.status === "warning").length,
      dependency_checks: runtimeProfile.diagnostics.dependencyChecks.length,
    },
    runtime_profile: runtimeProfile,
  });
}

async function handleGetJobEvents(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sinceSeqRaw = url.searchParams.get("since_seq");
  const seqRaw = url.searchParams.get("seq");
  const limitRaw = url.searchParams.get("limit");
  const pageRaw = url.searchParams.get("page");
  const pageSizeRaw = url.searchParams.get("page_size");
  const sinceSeqResult = parseNonNegativeIntegerParam(sinceSeqRaw, "since_seq");
  if (!sinceSeqResult.ok) {
    jsonErrorResponse(res, 400, sinceSeqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const seqResult = parseNonNegativeIntegerParam(seqRaw, "seq");
  if (!seqResult.ok) {
    jsonErrorResponse(res, 400, seqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const limitResult = parseNonNegativeIntegerParam(limitRaw, "limit");
  if (!limitResult.ok) {
    jsonErrorResponse(res, 400, limitResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageResult = parseNonNegativeIntegerParam(pageRaw, "page");
  if (!pageResult.ok) {
    jsonErrorResponse(res, 400, pageResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageSizeResult = parseNonNegativeIntegerParam(pageSizeRaw, "page_size");
  if (!pageSizeResult.ok) {
    jsonErrorResponse(res, 400, pageSizeResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const sinceSeq = sinceSeqResult.value;
  const seq = seqResult.value;
  const limit = limitResult.value;
  const requestedPage = pageResult.value;
  const requestedPageSize = pageSizeResult.value;
  const eventQuery = readJobEventQuery(url);

  const fullEvents = mergeJobEvents(record, loadEventsFromDisk(jobId));
  const filteredEvents = filterJobEvents(fullEvents, {
    sinceSeq,
    seq,
    types: parseStringSetParam(url, "type"),
    statuses: parseStringSetParam(url, "status"),
    agents: eventQuery.agent ? new Set([eventQuery.agent]) : undefined,
    phases: eventQuery.phase ? new Set([eventQuery.phase]) : undefined,
    taskRunIds: eventQuery.taskRunId ? new Set([eventQuery.taskRunId]) : undefined,
  });
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.max(1, requestedPageSize as number)
    : Number.isFinite(limit)
      ? Math.max(1, limit as number)
      : filteredEvents.length || 1;
  const page = Math.max(1, requestedPage ?? 1);
  const offset = (page - 1) * pageSize;
  const pageEvents = filteredEvents.slice(offset, offset + pageSize);
  const events = Number.isFinite(limit) && !Number.isFinite(requestedPage)
    ? filteredEvents.slice(0, limit as number)
    : pageEvents;
  jsonResponse(res, 200, {
    job_id: jobId,
    count: events.length,
    total: filteredEvents.length,
    filters: {
      type: [...parseStringSetParam(url, "type")],
      status: [...parseStringSetParam(url, "status")],
      agent: eventQuery.agent ?? null,
      phase: eventQuery.phase ?? null,
      task_run_id: eventQuery.taskRunId ?? null,
      seq: seq ?? null,
      since_seq: sinceSeq ?? null,
    },
    pagination: {
      page,
      page_size: pageSize,
      total: filteredEvents.length,
      total_pages: Math.max(1, Math.ceil(filteredEvents.length / pageSize)),
    },
    snapshot: buildEventSnapshot(record, fullEvents, routeBasePath),
    events,
  });
}

async function handleJobStream(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  // Verify job exists
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const url = new URL(_req.url ?? "/", "http://127.0.0.1");
  const sinceSeqRaw = url.searchParams.get("since_seq");
  const seqRaw = url.searchParams.get("seq");
  const pageRaw = url.searchParams.get("page");
  const pageSizeRaw = url.searchParams.get("page_size");
  const lastEventIdRaw = getHeaderValue(_req, "last-event-id");
  const sinceSeqResult = parseNonNegativeIntegerParam(sinceSeqRaw, "since_seq");
  if (!sinceSeqResult.ok) {
    jsonErrorResponse(res, 400, sinceSeqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const seqResult = parseNonNegativeIntegerParam(seqRaw, "seq");
  if (!seqResult.ok) {
    jsonErrorResponse(res, 400, seqResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageResult = parseNonNegativeIntegerParam(pageRaw, "page");
  if (!pageResult.ok) {
    jsonErrorResponse(res, 400, pageResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const pageSizeResult = parseNonNegativeIntegerParam(pageSizeRaw, "page_size");
  if (!pageSizeResult.ok) {
    jsonErrorResponse(res, 400, pageSizeResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const lastEventIdResult = parseNonNegativeIntegerParam(lastEventIdRaw, "Last-Event-ID");
  if (!lastEventIdResult.ok) {
    jsonErrorResponse(res, 400, lastEventIdResult.message, "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  const requestedSinceSeq = sinceSeqResult.value;
  const requestedLastEventId = lastEventIdResult.value;
  const replayCursor = Number.isFinite(requestedSinceSeq)
    ? requestedSinceSeq as number
    : Number.isFinite(requestedLastEventId)
      ? requestedLastEventId as number
      : undefined;
  const eventQuery = readJobEventQuery(url);

  // Load existing events from disk
  const existingEvents = mergeJobEvents(record, loadEventsFromDisk(jobId));
  const replaySource = replayCursor !== undefined
    ? existingEvents
    : (existingEvents.length > 0 ? existingEvents : getEvents(jobId));
  const filteredReplayEvents = filterJobEvents(replaySource, {
    types: parseStringSetParam(url, "type"),
    statuses: parseStringSetParam(url, "status"),
    agents: eventQuery.agent ? new Set([eventQuery.agent]) : undefined,
    phases: eventQuery.phase ? new Set([eventQuery.phase]) : undefined,
    taskRunIds: eventQuery.taskRunId ? new Set([eventQuery.taskRunId]) : undefined,
    seq: seqResult.value,
    sinceSeq: replayCursor,
  });
  const streamPageSize = Number.isFinite(pageSizeResult.value) ? Math.max(1, pageSizeResult.value as number) : filteredReplayEvents.length || 1;
  const streamPage = Math.max(1, pageResult.value ?? 1);
  const replayEvents = Number.isFinite(pageResult.value) || Number.isFinite(pageSizeResult.value)
    ? filteredReplayEvents.slice((streamPage - 1) * streamPageSize, streamPage * streamPageSize)
    : filteredReplayEvents;

  // Set SSE headers
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Send initial snapshot
  const snapshot = buildEventSnapshot(record, existingEvents, routeBasePath);
  if (snapshot) {
    sseWriteEvent(res, "job.snapshot", JSON.stringify({
      ...snapshot,
      replay: {
        ...(isObjectRecord(snapshot.replay) ? snapshot.replay : {}),
        resumed_from_seq: replayCursor ?? null,
        replayed_count: replayEvents.length,
        filtered_count: filteredReplayEvents.length,
        page: streamPage,
        page_size: streamPageSize,
        filters: {
          type: [...parseStringSetParam(url, "type")],
          status: [...parseStringSetParam(url, "status")],
          agent: eventQuery.agent ?? null,
          phase: eventQuery.phase ?? null,
          task_run_id: eventQuery.taskRunId ?? null,
          seq: seqResult.value ?? null,
          since_seq: replayCursor ?? null,
        },
      },
    }));
    if (isObjectRecord(snapshot.follow) && typeof snapshot.follow.type === "string") {
      sseWriteEvent(res, "job.redirect", JSON.stringify(snapshot.follow));
    }
  }

  // Send replay events
  for (const event of replayEvents) {
    sseWriteEvent(res, "job.event", JSON.stringify(event), event.seq);
  }

  // Subscribe to new events
  const unsubscribe = subscribe(jobId, (event) => {
    try {
      if (filterJobEvents([event], {
        types: parseStringSetParam(url, "type"),
        statuses: parseStringSetParam(url, "status"),
        agents: eventQuery.agent ? new Set([eventQuery.agent]) : undefined,
        phases: eventQuery.phase ? new Set([eventQuery.phase]) : undefined,
        taskRunIds: eventQuery.taskRunId ? new Set([eventQuery.taskRunId]) : undefined,
        seq: seqResult.value,
      }).length === 0) {
        return;
      }
      sseWriteEvent(res, "job.event", JSON.stringify(event), event.seq);
      if (event.type === "job.resumed" && isObjectRecord(event.meta) && typeof event.meta.resumed_to_job_id === "string") {
        const follow = buildResumeFollowTarget(jobId, event.meta.resumed_to_job_id, routeBasePath);
        if (follow) {
          sseWriteEvent(res, "job.redirect", JSON.stringify(follow), event.seq);
        }
      }
      if (isRecoveryLifecycleEvent(event.type)) {
        const latestRecord = readJobRecord(jobId);
        const latestEvents = latestRecord ? mergeJobEvents(latestRecord, loadEventsFromDisk(jobId)) : null;
        const latestSnapshot = latestRecord && latestEvents ? buildEventSnapshot(latestRecord, latestEvents, routeBasePath) : null;
        if (latestSnapshot) {
          sseWriteEvent(res, "job.snapshot", JSON.stringify({
            ...latestSnapshot,
            replay: {
              ...(isObjectRecord(latestSnapshot.replay) ? latestSnapshot.replay : {}),
              resumed_from_seq: replayCursor ?? null,
              replayed_count: replayEvents.length,
            },
          }), event.seq);
        }
      }
    } catch {
      // Client disconnected
      unsubscribe();
    }
  });

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      sseWriteEvent(res, "heartbeat", JSON.stringify({ time: new Date().toISOString() }));
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 30_000);
  heartbeat.unref?.();

  // Auto-cleanup after 10 minutes (SSE connections shouldn't last forever)
  const maxDuration = 10 * 60 * 1000;
  const timeout = setTimeout(() => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // Ignore
    }
  }, maxDuration);
  timeout.unref?.();

  // Clear timeout if response ends normally
  const originalEnd = res.end.bind(res);
  res.end = function (...args: Parameters<typeof originalEnd>) {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    unsubscribe();
    return originalEnd(...args);
  } as typeof res.end;
}

async function handleCancelJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const active = getActiveJobSession(jobId);
  const interrupted = cancelActiveJobSession(jobId, `Run cancelled via API for job ${jobId}.`);
  const cancelledAt = new Date().toISOString();
  const updated = updateStoredJobRecord(jobId, (record) => ({
    ...record,
    savedAt: cancelledAt,
    job: {
      ...record.job,
      status: "cancelled",
      output: "Run cancelled.",
    },
    control: {
      ...record.control,
      cancellationRequestedAt: cancelledAt,
      cancelledAt,
    },
  }));
  if (!updated) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: updated.control?.cancelledAt ?? new Date().toISOString(),
    type: "job.cancelled",
    title: "Job cancelled",
    summary: "Cancellation was requested for this job.",
    status: "blocked",
    meta: {
      active: Boolean(active),
      interrupted,
      cancellation_requested_at: updated.control?.cancellationRequestedAt ?? null,
    },
  }));
  jsonResponse(res, 200, {
    ok: true,
    job_id: jobId,
    active: Boolean(active),
    interrupted,
    control: updated.control ?? {},
  });
}

async function handleRetryJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonErrorResponse(res, 404, `Job not found: ${jobId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }

  const retryResult = await executeJobByMode(record.job.mode, record.job.goal, undefined, {
    requirePlannerCircuit: false,
  });
  updateJobControlState(jobId, {
    retriedAt: new Date().toISOString(),
    retriedToJobId: retryResult.job.id,
  });
  const retriedRecord = updateJobControlState(retryResult.job.id, {
    retryOf: jobId,
  });
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: new Date().toISOString(),
    type: "job.retried",
    title: "Job retried",
    summary: `A retry job was created: ${retryResult.job.id}.`,
    status: "success",
    meta: {
      retried_to_job_id: retryResult.job.id,
    },
  }));

  jsonResponse(res, 200, {
    ok: true,
    retried_from: jobId,
    job: retryResult.job,
    plan: retryResult.plan,
    taskRuns: retryResult.taskRuns,
    artifacts: retryResult.artifacts,
    control: retriedRecord?.control ?? { retryOf: jobId },
  });
}

async function handleJobTimeline(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  routeBasePath = "/v1/jobs",
): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: `Job not found: ${jobId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  // Load events from disk
  const events = loadEventsFromDisk(jobId);
  const timelineEvents = events.length > 0 ? events : buildJobEvents(record);

  // Render timeline HTML
  const html = renderTimelineHtml(
    jobId,
    timelineEvents,
    record.job.goal,
    record.job.status,
    buildWorkflowSummary(record) as {
      current_task?: { title?: string; status?: string } | null;
      awaiting_approval_task?: { title?: string; status?: string } | null;
      task_counts?: Record<string, number>;
    },
    buildEventSnapshot(record, timelineEvents, routeBasePath) as {
      follow?: { type?: string; job_id?: string; job_url?: string; timeline_url?: string; stream_url?: string; events_url?: string } | null;
      actions?: Array<{ id?: string; label?: string; kind?: string; href?: string; method?: string; emphasis?: string }>;
      recovery?: { auto_resume_failed_at?: string | null; auto_resume_failure_message?: string | null } | null;
    },
    { routeBasePath },
  );

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleApproveJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const body = await readJsonBody<{ approval_id?: string; decision?: string; note?: string }>(req);
  if (!body.approval_id || !body.decision) {
    jsonErrorResponse(res, 400, "approval_id and decision are required.", "invalid_request_error", {
      status: "failed",
    });
    return;
  }
  if (body.decision !== "approved" && body.decision !== "denied") {
    jsonErrorResponse(res, 400, 'decision must be "approved" or "denied".', "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  const record = readJobRecord(jobId);
  if (!record) {
    jsonErrorResponse(res, 404, `Job not found: ${jobId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }

  const updated = resolveApprovalRequest(jobId, body.approval_id, body.decision, body.note);
  if (!updated) {
    jsonErrorResponse(res, 400, `Approval not found: ${body.approval_id}`, "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  const signaled = resolvePendingApproval(jobId, body.decision);
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: new Date().toISOString(),
    type: body.decision === "approved" ? "approval.approved" : "approval.denied",
    title: body.decision === "approved" ? "Approval granted" : "Approval denied",
    summary: body.decision === "approved"
      ? "A pending approval request was approved."
      : "A pending approval request was denied.",
    status: body.decision === "approved" ? "success" : "blocked",
    phase: "approval",
    meta: {
      approval_id: body.approval_id,
      note: body.note ?? "",
      signaled,
    },
  }));

  jsonResponse(res, 200, {
    ok: true,
    job_id: jobId,
    approval_id: body.approval_id,
    decision: body.decision,
    signaled,
    control: updated.control ?? {},
  });
}

async function handleResumeJob(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const record = readJobRecord(jobId);
  if (!record) {
    jsonErrorResponse(res, 404, `Job not found: ${jobId}`, "not_found_error", {
      status: "failed",
    });
    return;
  }

  if (record.job.status === "completed") {
    jsonErrorResponse(res, 400, "Cannot resume a completed job.", "invalid_request_error", {
      status: "failed",
    });
    return;
  }

  if (record.job.status === "awaiting_approval" || record.control?.pendingApprovalId) {
    jsonErrorResponse(res, 409, "Job is awaiting approval. Resolve it through /approve instead of /resume.", "conflict_error", {
      status: "blocked",
    });
    return;
  }

  const active = getActiveJobSession(jobId);
  if (active) {
    jsonErrorResponse(res, 409, "Job is currently running.", "conflict_error", {
      status: "blocked",
    });
    return;
  }

  const resumeResult = await executeJobByMode(record.job.mode, record.job.goal, undefined, {
    requirePlannerCircuit: false,
  });
  updateJobControlState(jobId, {
    resumedAt: new Date().toISOString(),
    resumedToJobId: resumeResult.job.id,
  });
  const resumedRecord = updateJobControlState(resumeResult.job.id, {
    resumeOf: jobId,
  });
  appendEvent(createLifecycleEvent({
    jobId,
    seq: getNextSeq(jobId),
    time: new Date().toISOString(),
    type: "job.resumed",
    title: "Job resumed",
    summary: `A resumed job was created: ${resumeResult.job.id}.`,
    status: "success",
    meta: {
      resumed_to_job_id: resumeResult.job.id,
    },
  }));

  jsonResponse(res, 200, {
    ok: true,
    resumed_from: jobId,
    job: resumeResult.job,
    plan: resumeResult.plan,
    taskRuns: resumeResult.taskRuns,
    artifacts: resumeResult.artifacts,
    control: resumedRecord?.control ?? { resumeOf: jobId },
  });
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ChatCompletionRequest>(req);
  const toolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  const mirrorProgressToContent = body.stream && !toolMode && shouldMirrorProgressToContent(body.include_progress_updates);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);

  if (toolMode) {
    if (extractLatestOpenAIWriteToolCompletion(body.messages)) {
      jsonResponse(res, 200, buildChatCompletionResponse(body.model || OPENAI_MODEL_ID, "File written successfully."));
      return;
    }
    if (extractLatestOpenAIResearchReadCompletion(body.messages)) {
      jsonResponse(res, 200, buildChatCompletionResponse(body.model || OPENAI_MODEL_ID, "Research evidence read successfully. Please summarize and finish without further tool calls."));
      return;
    }

    const overrides: import("./providers/openai-compatible.js").CompletionOverrides = {};
    if (body.temperature !== undefined) overrides.temperature = body.temperature;
    if (body.max_tokens !== undefined) overrides.maxTokens = body.max_tokens;
    if (body.top_p !== undefined) overrides.topP = body.top_p;
    if (body.stop !== undefined) overrides.stop = body.stop;
    if (body.tool_choice !== undefined) overrides.toolChoice = body.tool_choice;
    const toolResult = await runToolMode(normalizeOpenAIToolMessages(body.messages || []), body.model, body.tools, overrides);

    if (!body.stream) {
      if (toolResult.toolCalls.length > 0) {
        jsonResponse(res, 200, buildToolChatCompletionResponse(toolResult.resolvedModel, toolResult.toolCalls));
      } else {
        jsonResponse(res, 200, buildChatCompletionResponse(toolResult.resolvedModel, summarizeToolResultContent(toolResult.content) || toolResult.content));
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const streamId = `chatcmpl-${Date.now()}`;
    sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, { role: "assistant", content: "" }, null));
    if (toolResult.toolCalls.length > 0) {
      for (let i = 0; i < toolResult.toolCalls.length; i++) {
        sseWrite(res, buildToolChatCompletionChunk(toolResult.resolvedModel, streamId, toolResult.toolCalls[i], null, i));
      }
      sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, {}, "tool_calls"));
    } else {
      const finalText = summarizeToolResultContent(toolResult.content) || toolResult.content;
      for (const chunk of splitContentForStreaming(finalText)) {
        sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, { content: chunk }, null));
      }
      sseWrite(res, buildChatCompletionChunk(toolResult.resolvedModel, streamId, {}, "stop"));
    }
    if (includeWorkflowEvents) {
      sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", {
        job: null,
        plan: null,
        taskRuns: [],
        artifacts: [],
      }, {
        mode: "tool",
        model: toolResult.resolvedModel,
        toolCalls: toolResult.toolCalls,
        content: toolResult.content,
      }));
    }
    res.end("data: [DONE]\n\n");
    return;
  }

  // For streaming, set up SSE headers first so events can be sent in real-time
  if (body.stream) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const streamId = `chatcmpl-${Date.now()}`;
    sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { role: "assistant", content: "" }, null));

    const onEvent: OrchestratorEventCallback | undefined = includeWorkflowEvents
      ? (event) => {
          try {
            sseWriteEvent(res, event.type, JSON.stringify({
              type: event.type,
              step: event.step,
              ...event.data,
            }));
          } catch {
            // Ignore write errors (client may have disconnected)
          }
        }
      : undefined;
    let emittedProgressChunks = false;
    let pendingToolAggregation: ProgressAggregationState | null = null;
    const writeProgressText = (progressText: string) => {
      emittedProgressChunks = true;
      for (const chunk of splitContentForStreaming(progressText)) {
        sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { content: chunk }, null));
      }
    };
    const flushPendingToolAggregation = () => {
      if (!pendingToolAggregation) {
        return;
      }
      const progressText = buildAggregatedToolResult(pendingToolAggregation);
      pendingToolAggregation = null;
      if (!progressText) {
        return;
      }
      writeProgressText(progressText);
    };
    const emitProgressChunk = (event: OrchestratorEvent) => {
      if (!mirrorProgressToContent) {
        return;
      }

      if (event.type === "workflow.tool.start") {
        const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
        if (!shouldAggregateToolProgress(tool)) {
          flushPendingToolAggregation();
          const progressText = formatProgressUpdate(event);
          if (progressText) {
            writeProgressText(progressText);
          }
          return;
        }

        if (!pendingToolAggregation || pendingToolAggregation.tool !== tool || pendingToolAggregation.step !== event.step) {
          flushPendingToolAggregation();
          pendingToolAggregation = createProgressAggregationState(tool, event.step);
          pendingToolAggregation.startCount = 1;
          writeProgressText(buildAggregatedToolStart(tool));
          return;
        }

        pendingToolAggregation.startCount += 1;
        return;
      }

      if (event.type === "workflow.tool.result") {
        const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
        if (!shouldAggregateToolProgress(tool)) {
          flushPendingToolAggregation();
          const progressText = formatProgressUpdate(event);
          if (progressText) {
            writeProgressText(progressText);
          }
          return;
        }

        if (!pendingToolAggregation || pendingToolAggregation.tool !== tool || pendingToolAggregation.step !== event.step) {
          flushPendingToolAggregation();
          pendingToolAggregation = createProgressAggregationState(tool, event.step);
        }
        accumulateToolProgressResult(pendingToolAggregation, event);
        return;
      }

      flushPendingToolAggregation();
      const progressText = formatProgressUpdate(event);
      if (!progressText) {
        return;
      }
      writeProgressText(progressText);
    };
    const combinedOnEvent: OrchestratorEventCallback | undefined = (event) => {
      emitProgressChunk(event);
      onEvent?.(event);
    };

    try {
      const resultForModel = await runTaskFromMessagesWithRegistration(
        normalizeChatMessages(body.messages || []),
        body.model,
        combinedOnEvent,
        (jobId) => { requestJobId = jobId; },
      );
      const requestedModel = resultForModel.resolvedModel;
      const workflow = buildWorkflowPayload(resultForModel);
      flushPendingToolAggregation();

      if (mirrorProgressToContent && emittedProgressChunks) {
        sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: "\n[最终结论]\n" }, null));
      }
      const chunks = splitContentForStreaming(resultForModel.content);
      for (const chunk of chunks) {
        sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, { content: chunk }, null));
      }

      sseWrite(res, buildChatCompletionChunk(requestedModel, streamId, {}, "stop"));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
          mode: "task",
          model: requestedModel,
          status: resultForModel.job.status,
        }));
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sseWrite(res, buildChatCompletionChunk("dual-agent-orchestrator", streamId, { content: `Error: ${message}` }, "stop"));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.failed", buildWorkflowEvent("workflow.failed", {}, {
          mode: "task",
          error: message,
        }));
      }
      res.end("data: [DONE]\n\n");
    } finally {
      detachRequestAbort();
    }
    return;
  }

  // Non-streaming path
  try {
    const resultForModel = await runTaskFromMessagesWithRegistration(
      normalizeChatMessages(body.messages || []),
      body.model,
      undefined,
      (jobId) => { requestJobId = jobId; },
    ).catch((error) => { throw error; });
    const requestedModel = resultForModel.resolvedModel;
    const workflow = buildWorkflowPayload(resultForModel);
    jsonResponse(res, 200, buildChatCompletionResponse(requestedModel, resultForModel.content, workflow));
  } finally {
    detachRequestAbort();
  }
}

function buildResponsesOutput(content: string): unknown[] {
  return [
    {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: content,
          annotations: [],
        },
      ],
    },
  ];
}

function buildResponsesResponse(model: string, content: string, workflow?: unknown): unknown {
  return {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: buildResponsesOutput(content),
    output_text: content,
    error: null,
    workflow,
  };
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<ResponsesRequest>(req);
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  const messages = normalizeResponsesInput(body.input, body.instructions);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);
  const result = await runTaskFromMessagesWithRegistration(messages, body.model, undefined, (jobId) => {
    requestJobId = jobId;
  });
  const workflow = buildWorkflowPayload(result);

  if (!body.stream) {
    try {
      jsonResponse(res, 200, buildResponsesResponse(result.resolvedModel, result.content, workflow));
    } finally {
      detachRequestAbort();
    }
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const responseId = `resp_${Date.now()}`;
  sseWrite(res, JSON.stringify({ type: "response.created", response: { id: responseId, model: result.resolvedModel, status: "in_progress" } }));
  for (const chunk of splitContentForStreaming(result.content)) {
    sseWrite(res, JSON.stringify({ type: "response.output_text.delta", delta: chunk }));
  }
  sseWrite(res, JSON.stringify({ type: "response.completed", response: { id: responseId, model: result.resolvedModel, status: "completed" } }));
  if (includeWorkflowEvents) {
    sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
      mode: "task",
      model: result.resolvedModel,
      status: result.job.status,
    }));
  }
  try {
    res.end("data: [DONE]\n\n");
  } finally {
    detachRequestAbort();
  }
}

function buildAnthropicMessageResponse(model: string, content: string, workflow?: unknown): unknown {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "text",
        text: content,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
    workflow,
  };
}

async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<AnthropicMessagesRequest>(req);
  const messages = normalizeAnthropicMessages(body.messages, body.system);
  const requestedToolMode = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolHistory = hasAnthropicToolHistory(body.messages);
  const toolMode = requestedToolMode && hasToolHistory;
  const includeWorkflowEvents = shouldIncludeWorkflowEvents(req, body.include_workflow_events);
  let requestJobId: string | null = null;
  const detachRequestAbort = attachRequestAbortCancellation(res, () => requestJobId);

  if (requestedToolMode && !hasToolHistory) {
    const result = await runTaskFromMessagesWithRegistration(messages, body.model, undefined, (jobId) => {
      requestJobId = jobId;
    });
    const workflow = buildWorkflowPayload(result);

    if (!body.stream) {
      try {
        jsonResponse(res, 200, buildAnthropicMessageResponse(result.resolvedModel, summarizeToolResultContent(result.content) || result.content, workflow));
      } finally {
        detachRequestAbort();
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const messageId = `msg_${Date.now()}`;
    res.write(`event: message_start\n`);
    sseWrite(res, JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: result.resolvedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
    res.write(`event: content_block_start\n`);
    sseWrite(res, JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }));
    for (const chunk of splitContentForStreaming(summarizeToolResultContent(result.content) || result.content)) {
      res.write(`event: content_block_delta\n`);
      sseWrite(res, JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      }));
    }
    res.write(`event: content_block_stop\n`);
    sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
    res.write(`event: message_delta\n`);
    sseWrite(res, JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }));
    if (includeWorkflowEvents) {
      sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
        mode: "task",
        model: result.resolvedModel,
        status: result.job.status,
      }));
    }
    try {
      res.write(`event: message_stop\n`);
      sseWrite(res, JSON.stringify({ type: "message_stop" }));
      res.end();
    } finally {
      detachRequestAbort();
    }
    return;
  }

  detachRequestAbort();

  if (toolMode) {
    if (extractLatestAnthropicWriteToolCompletion(body.messages)) {
      jsonResponse(res, 200, buildAnthropicMessageResponse(body.model || OPENAI_MODEL_ID, "File written successfully."));
      return;
    }
    if (extractLatestAnthropicResearchReadCompletion(body.messages)) {
      jsonResponse(res, 200, buildAnthropicMessageResponse(body.model || OPENAI_MODEL_ID, "Research evidence read successfully. Please summarize and finish without further tool calls."));
      return;
    }

    const anthropicTools = body.tools ?? [];
    const convertedTools = anthropicTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name || "",
        description: tool.description || "",
        parameters: tool.input_schema || {},
      },
    }));
    const toolResult = await runToolMode(normalizeAnthropicToolMessages(body.messages, body.system), body.model, convertedTools);

    if (!body.stream) {
      if (toolResult.toolCalls.length > 0) {
        jsonResponse(res, 200, {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: toolResult.resolvedModel,
          content: toolResult.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: safeParseToolInput(call.arguments),
          })),
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        });
      } else {
        const finalText = summarizeToolResultContent(toolResult.content) || "Tool work completed. Please summarize and finish without further tool calls.";
        jsonResponse(res, 200, buildAnthropicMessageResponse(toolResult.resolvedModel, finalText));
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const messageId = `msg_${Date.now()}`;
    res.write(`event: message_start\n`);
    sseWrite(res, JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: toolResult.resolvedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));

    if (toolResult.toolCalls.length > 0) {
      for (const call of toolResult.toolCalls) {
        res.write(`event: content_block_start\n`);
        sseWrite(res, JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: {},
          },
        }));
        res.write(`event: content_block_delta\n`);
        sseWrite(res, JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: call.arguments,
          },
        }));
        res.write(`event: content_block_stop\n`);
        sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
      }

      res.write(`event: message_delta\n`);
      sseWrite(res, JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", {
          job: null,
          plan: null,
          taskRuns: [],
          artifacts: [],
        }, {
          mode: "tool",
          model: toolResult.resolvedModel,
          toolCalls: toolResult.toolCalls,
          content: toolResult.content,
        }));
      }
    } else {
      const result = await runTaskFromMessages(messages, body.model);
      const workflow = buildWorkflowPayload(result);
      res.write(`event: content_block_start\n`);
      sseWrite(res, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));
      const finalText = summarizeToolResultContent(result.content) || result.content || summarizeToolResultContent(toolResult.content) || "Tool work completed. Please summarize and finish without further tool calls.";
      for (const chunk of splitContentForStreaming(finalText)) {
        res.write(`event: content_block_delta\n`);
        sseWrite(res, JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: chunk,
          },
        }));
      }
      res.write(`event: content_block_stop\n`);
      sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
      res.write(`event: message_delta\n`);
      sseWrite(res, JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));
      if (includeWorkflowEvents) {
        sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
          mode: "task",
          model: result.resolvedModel,
          status: result.job.status,
        }));
      }
    }
    res.write(`event: message_stop\n`);
    sseWrite(res, JSON.stringify({ type: "message_stop" }));
    res.end();
    return;
  }

  const result = await runTaskFromMessages(messages, body.model);
  const workflow = buildWorkflowPayload(result);

  if (!body.stream) {
    jsonResponse(res, 200, buildAnthropicMessageResponse(result.resolvedModel, summarizeToolResultContent(result.content) || result.content, workflow));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const messageId = `msg_${Date.now()}`;
  res.write(`event: message_start\n`);
  sseWrite(res, JSON.stringify({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: result.resolvedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));
  res.write(`event: content_block_start\n`);
  sseWrite(res, JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }));
  for (const chunk of splitContentForStreaming(summarizeToolResultContent(result.content) || result.content)) {
    res.write(`event: content_block_delta\n`);
    sseWrite(res, JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    }));
  }
  res.write(`event: content_block_stop\n`);
  sseWrite(res, JSON.stringify({ type: "content_block_stop", index: 0 }));
  res.write(`event: message_delta\n`);
  sseWrite(res, JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
    workflow,
  }));
  res.write(`event: message_stop\n`);
  sseWrite(res, JSON.stringify({ type: "message_stop" }));
  if (includeWorkflowEvents) {
    sseWriteEvent(res, "workflow.completed", buildWorkflowEvent("workflow.completed", workflow, {
      mode: "task",
      model: result.resolvedModel,
      status: result.job.status,
    }));
  }
  res.end();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  try {
    if (method === "GET" && url.pathname === "/jobs/dashboard") {
      await handleJobsDashboard(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/jobs/data") {
      await handleBrowserListJobs(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/goals/dashboard") {
      await handleGoalsDashboard(req, res, "/goals");
      return;
    }

    if (method === "GET" && url.pathname === "/goals/data") {
      await handleBrowserListGoals(req, res);
      return;
    }

    const browserGoalMatch = url.pathname.match(/^\/goals\/([^/]+)$/);
    if (method === "GET" && browserGoalMatch) {
      await handleGetGoal(req, res, decodeURIComponent(browserGoalMatch[1]!));
      return;
    }

    const browserGoalEventsMatch = url.pathname.match(/^\/goals\/([^/]+)\/events$/);
    if (method === "GET" && browserGoalEventsMatch) {
      await handleGoalEvents(req, res, decodeURIComponent(browserGoalEventsMatch[1]!));
      return;
    }

    const browserGoalTimelineMatch = url.pathname.match(/^\/goals\/([^/]+)\/timeline$/);
    if (method === "GET" && browserGoalTimelineMatch) {
      await handleGoalTimeline(req, res, decodeURIComponent(browserGoalTimelineMatch[1]!), "/goals");
      return;
    }

    const browserJobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (method === "GET" && browserJobMatch) {
      await handleGetJob(req, res, decodeURIComponent(browserJobMatch[1]!), "/jobs");
      return;
    }

    const browserJobEventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
    if (method === "GET" && browserJobEventsMatch) {
      await handleGetJobEvents(req, res, decodeURIComponent(browserJobEventsMatch[1]!), "/jobs");
      return;
    }

    const browserJobStreamMatch = url.pathname.match(/^\/jobs\/([^/]+)\/stream$/);
    if (method === "GET" && browserJobStreamMatch) {
      await handleJobStream(req, res, decodeURIComponent(browserJobStreamMatch[1]!), "/jobs");
      return;
    }

    const browserJobTimelineMatch = url.pathname.match(/^\/jobs\/([^/]+)\/timeline$/);
    if (method === "GET" && browserJobTimelineMatch) {
      await handleJobTimeline(req, res, decodeURIComponent(browserJobTimelineMatch[1]!), "/jobs");
      return;
    }

    const browserJobResumeMatch = url.pathname.match(/^\/jobs\/([^/]+)\/resume$/);
    if (method === "POST" && browserJobResumeMatch) {
      await handleResumeJob(req, res, decodeURIComponent(browserJobResumeMatch[1]!));
      return;
    }

    if (url.pathname.startsWith("/v1/") && !isAuthorized(req)) {
      unauthorizedResponse(res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/models") {
      await handleModels(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      await handleHealth(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/jobs") {
      await handleListJobs(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/skills") {
      await handleListSkills(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/skills/install") {
      await handleInstallSkill(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/skill-evolution/proposals") {
      await handleListSkillEvolutionProposals(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/skill-evolution/ops") {
      await handleSkillEvolutionOps(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/skill-evolution/proposals") {
      await handleCreateSkillEvolutionProposal(req, res);
      return;
    }

    const skillReflectionsMatch = url.pathname.match(/^\/v1\/skills\/([^/]+)\/reflections$/);
    if (method === "GET" && skillReflectionsMatch) {
      await handleListSkillReflections(req, res, decodeURIComponent(skillReflectionsMatch[1]!));
      return;
    }

    const skillReflectMatch = url.pathname.match(/^\/v1\/skills\/([^/]+)\/reflect$/);
    if (method === "POST" && skillReflectMatch) {
      await handleCreateSkillReflection(req, res, decodeURIComponent(skillReflectMatch[1]!));
      return;
    }

    const skillProposeMatch = url.pathname.match(/^\/v1\/skills\/([^/]+)\/propose$/);
    if (method === "POST" && skillProposeMatch) {
      await handleCreateSkillProposal(req, res, decodeURIComponent(skillProposeMatch[1]!));
      return;
    }

    const skillEvolutionProposalMatch = url.pathname.match(/^\/v1\/skill-evolution\/proposals\/([^/]+)$/);
    if (method === "GET" && skillEvolutionProposalMatch) {
      await handleGetSkillEvolutionProposal(req, res, decodeURIComponent(skillEvolutionProposalMatch[1]!));
      return;
    }

    const skillEvolutionProposalAuditMatch = url.pathname.match(/^\/v1\/skill-evolution\/proposals\/([^/]+)\/audit$/);
    if (method === "POST" && skillEvolutionProposalAuditMatch) {
      await handleAuditSkillEvolutionProposal(req, res, decodeURIComponent(skillEvolutionProposalAuditMatch[1]!));
      return;
    }

    const skillEvolutionProposalValidateMatch = url.pathname.match(/^\/v1\/skill-evolution\/proposals\/([^/]+)\/validate$/);
    if (method === "POST" && skillEvolutionProposalValidateMatch) {
      await handleValidateSkillEvolutionProposal(req, res, decodeURIComponent(skillEvolutionProposalValidateMatch[1]!));
      return;
    }

    const skillEvolutionProposalAcceptMatch = url.pathname.match(/^\/v1\/skill-evolution\/proposals\/([^/]+)\/accept$/);
    if (method === "POST" && skillEvolutionProposalAcceptMatch) {
      await handleSkillEvolutionDecision(req, res, decodeURIComponent(skillEvolutionProposalAcceptMatch[1]!), "accepted");
      return;
    }

    const skillEvolutionProposalRejectMatch = url.pathname.match(/^\/v1\/skill-evolution\/proposals\/([^/]+)\/reject$/);
    if (method === "POST" && skillEvolutionProposalRejectMatch) {
      await handleSkillEvolutionDecision(req, res, decodeURIComponent(skillEvolutionProposalRejectMatch[1]!), "rejected");
      return;
    }

    if (method === "GET" && url.pathname === "/v1/goals") {
      await handleListGoals(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/goals/data") {
      jsonResponse(res, 200, {
        object: "list",
        data: buildListedGoalsResponse(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/v1/jobs/dashboard") {
      await handleJobsDashboard(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/goals/dashboard") {
      await handleGoalsDashboard(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/jobs") {
      await handleCreateJob(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/goals") {
      await handleCreateGoal(req, res);
      return;
    }

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (method === "GET" && jobMatch) {
      await handleGetJob(req, res, decodeURIComponent(jobMatch[1]!));
      return;
    }

    const goalMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)$/);
    if (method === "GET" && goalMatch) {
      await handleGetGoal(req, res, decodeURIComponent(goalMatch[1]!));
      return;
    }

    const goalEventsMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/events$/);
    if (method === "GET" && goalEventsMatch) {
      await handleGoalEvents(req, res, decodeURIComponent(goalEventsMatch[1]!));
      return;
    }

    const goalTimelineMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/timeline$/);
    if (method === "GET" && goalTimelineMatch) {
      await handleGoalTimeline(req, res, decodeURIComponent(goalTimelineMatch[1]!));
      return;
    }

    const goalRunNextMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/run-next$/);
    if (method === "POST" && goalRunNextMatch) {
      await handleRunNextGoal(req, res, decodeURIComponent(goalRunNextMatch[1]!));
      return;
    }

    const goalRetryMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/retry$/);
    if (method === "POST" && goalRetryMatch) {
      await handleRetryGoal(req, res, decodeURIComponent(goalRetryMatch[1]!));
      return;
    }

    const goalResumeMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/resume$/);
    if (method === "POST" && goalResumeMatch) {
      await handleResumeGoal(req, res, decodeURIComponent(goalResumeMatch[1]!));
      return;
    }

    const goalReviewMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/review$/);
    if (method === "POST" && goalReviewMatch) {
      await handleReviewGoal(req, res, decodeURIComponent(goalReviewMatch[1]!));
      return;
    }

    const jobStepsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/steps$/);
    if (method === "GET" && jobStepsMatch) {
      await handleGetJobSteps(req, res, decodeURIComponent(jobStepsMatch[1]!));
      return;
    }

    const jobArtifactsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts$/);
    if (method === "GET" && jobArtifactsMatch) {
      await handleGetJobArtifacts(req, res, decodeURIComponent(jobArtifactsMatch[1]!));
      return;
    }

    const jobRuntimeProfileMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/runtime-profile$/);
    if (method === "GET" && jobRuntimeProfileMatch) {
      await handleGetJobRuntimeProfile(req, res, decodeURIComponent(jobRuntimeProfileMatch[1]!));
      return;
    }

    const jobEventsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
    if (method === "GET" && jobEventsMatch) {
      await handleGetJobEvents(req, res, decodeURIComponent(jobEventsMatch[1]!));
      return;
    }

    const jobStreamMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/stream$/);
    if (method === "GET" && jobStreamMatch) {
      await handleJobStream(req, res, decodeURIComponent(jobStreamMatch[1]!));
      return;
    }

    const jobTimelineMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/timeline$/);
    if (method === "GET" && jobTimelineMatch) {
      await handleJobTimeline(req, res, decodeURIComponent(jobTimelineMatch[1]!));
      return;
    }

    const jobCancelMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (method === "POST" && jobCancelMatch) {
      await handleCancelJob(req, res, decodeURIComponent(jobCancelMatch[1]!));
      return;
    }

    const jobRetryMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/retry$/);
    if (method === "POST" && jobRetryMatch) {
      await handleRetryJob(req, res, decodeURIComponent(jobRetryMatch[1]!));
      return;
    }

    const jobApproveMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/approve$/);
    if (method === "POST" && jobApproveMatch) {
      await handleApproveJob(req, res, decodeURIComponent(jobApproveMatch[1]!));
      return;
    }

    const jobResumeMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/resume$/);
    if (method === "POST" && jobResumeMatch) {
      await handleResumeJob(req, res, decodeURIComponent(jobResumeMatch[1]!));
      return;
    }

    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/messages") {
      await handleAnthropicMessages(req, res);
      return;
    }

    jsonErrorResponse(res, 404, `Route not found: ${method} ${url.pathname}`, "not_found_error", {
      status: "failed",
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      serviceUnavailableResponse(res, error.message, error.retryAfterSeconds);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const isBadRequest = message.includes("must be a non-empty array")
      || message.includes("Unable to derive")
      || message.includes("Invalid JSON")
      || message.includes("exceeds maximum size");

    if (responseAlreadyStarted(res)) {
      console.error("Request failed after response started:", message);
      if (!(res as ServerResponse & { writableEnded?: boolean }).writableEnded) {
        try {
          res.end();
        } catch {
          // Best effort: the original response has already started.
        }
      }
      return;
    }

    jsonErrorResponse(res, isBadRequest ? 400 : 500, message, isBadRequest ? "invalid_request_error" : "server_error", {
      status: isBadRequest ? "failed" : "blocked",
    });
  }
}

function getPort(args: string[]): number {
  const explicitPort = args[1] ? Number(args[1]) : Number(process.env.PORT ?? "9898");
  return Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : 9898;
}

function parseTeamCliArgs(args: string[]): { goal: string; planOnly: boolean } {
  const planOnly = args[0] === "plan" || args.includes("--plan-only");
  const goalArgs = args
    .filter((arg, index) => !(index === 0 && arg === "plan") && arg !== "--plan-only" && arg !== "--");
  return {
    goal: goalArgs.join(" ").trim(),
    planOnly,
  };
}

function runConfigValidation(configPath?: string): void {
  const resolvedPath = configPath?.trim() || "config/config.yml";
  const config = loadConfig(resolvedPath);
  const routing = loadTaskRoutingConfig(config.taskRoutingPath);

  console.log(JSON.stringify({
    ok: true,
    config_path: resolvedPath,
    planner_model: config.planner.model,
    executor_model: config.executor.model,
    executor_candidates: config.modelRouting.executorCandidates,
    task_routing_path: config.taskRoutingPath,
    auto_resume_concurrency: config.policy.autoResumeConcurrency,
    route_types: routing.map((route) => route.type),
  }, null, 2));
}

type DoctorCheck = {
  name: string;
  ok: boolean;
  summary: string;
  detail?: unknown;
};

type DoctorRecommendation = {
  category:
    | "configuration"
    | "routing"
    | "network"
    | "filesystem"
    | "search"
    | "runtime";
  severity: "info" | "warning";
  message: string;
  suggested_action: string;
  related_checks: string[];
};

function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return `${value.slice(0, 1)}***`;
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function buildModelConfigCheck(
  name: "planner_model_config" | "executor_model_config",
  label: "planner" | "executor",
  config: OrchestratorConfig["planner"] | OrchestratorConfig["executor"],
): DoctorCheck {
  const urlLooksLocal = /^(https?:\/\/)(127\.0\.0\.1|localhost)/i.test(config.baseUrl);
  return {
    name,
    ok: Boolean(config.baseUrl && config.apiKey && config.model),
    summary: `${label} model config is ready${urlLooksLocal ? " (local endpoint)." : "."}`,
    detail: {
      base_url: config.baseUrl,
      api_key_present: Boolean(config.apiKey),
      api_key_preview: config.apiKey ? maskSecret(config.apiKey) : "",
      model: config.model,
      timeout_ms: config.timeoutMs,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      endpoint_scope: urlLooksLocal ? "local" : "remote",
    },
  };
}

function buildTaskRoutingCheck(taskRoutingPath: string | undefined, routing: RoutePolicy[]): DoctorCheck {
  const routesWithPreferredTools = routing.filter((route) => route.preferredTools.length > 0).length;
  const routesRequiringEvidence = routing.filter((route) => route.requireEvidenceBeforeFinal).length;
  return {
    name: "task_routing_summary",
    ok: routing.length > 0,
    summary: `Task routing loaded ${routing.length} route types.`,
    detail: {
      task_routing_path: taskRoutingPath ?? "config/task-routing.yml",
      route_count: routing.length,
      route_types: routing.map((route) => route.type),
      routes_with_preferred_tools: routesWithPreferredTools,
      routes_requiring_evidence: routesRequiringEvidence,
    },
  };
}

function buildSearchProviderCheck(config: OrchestratorConfig): DoctorCheck {
  if (!config.search) {
    return {
      name: "search_provider_readiness",
      ok: false,
      summary: "Search provider is not configured.",
      detail: {
        provider: null,
        fallback_enabled: false,
      },
    };
  }

  const providerConfig = config.search.providers[config.search.provider];
  const providerKindsRequiringApiKey = new Set(["serpapi", "bing_api", "google_cse"]);
  const providerKindsRequiringSection = new Set(["bing_html", "searxng", "serpapi", "bing_api", "google_cse", "mcp"]);
  const sectionPresent = config.search.provider === "url_template" || providerKindsRequiringSection.has(config.search.provider)
    ? Boolean(providerConfig)
    : true;
  const apiKeyRequired = providerKindsRequiringApiKey.has(config.search.provider);
  const apiKeyPresent = !apiKeyRequired || Boolean(config.search.apiKey);
  const ok = sectionPresent && apiKeyPresent;

  return {
    name: "search_provider_readiness",
    ok,
    summary: ok
      ? `Search provider "${config.search.provider}" is ready.`
      : `Search provider "${config.search.provider}" is only partially configured.`,
    detail: {
      provider: config.search.provider,
      provider_section_present: sectionPresent,
      api_key_required: apiKeyRequired,
      api_key_present: Boolean(config.search.apiKey),
      api_key_preview: config.search.apiKey ? maskSecret(config.search.apiKey) : "",
      fallback_enabled: config.search.fallbackEnabled,
      timeout_ms: config.search.timeoutMs,
      provider_config_keys: providerConfig ? Object.keys(providerConfig) : [],
    },
  };
}

function buildDoctorRecommendations(checks: DoctorCheck[]): DoctorRecommendation[] {
  const recommendations: DoctorRecommendation[] = [];
  const find = (name: string) => checks.find((check) => check.name === name);

  const configLoad = find("config_load");
  if (configLoad && !configLoad.ok) {
    recommendations.push({
      category: "configuration",
      severity: "warning",
      message: "Configuration failed to load.",
      suggested_action: "Fix the reported config schema errors, then rerun `npm run doctor` or `npm run config:validate`.",
      related_checks: ["config_load"],
    });
    return recommendations;
  }

  if ((find("planner_model_config") && !find("planner_model_config")!.ok) || (find("executor_model_config") && !find("executor_model_config")!.ok)) {
    recommendations.push({
      category: "configuration",
      severity: "warning",
      message: "Planner or executor model configuration is incomplete.",
      suggested_action: "Verify base URLs, model names, and API key env vars for both planner and executor.",
      related_checks: ["planner_model_config", "executor_model_config"],
    });
  }

  if (find("task_routing_load") && !find("task_routing_load")!.ok) {
    recommendations.push({
      category: "routing",
      severity: "warning",
      message: "Task routing config could not be loaded.",
      suggested_action: "Fix the task-routing YAML or fall back to the default `config/task-routing.yml` layout.",
      related_checks: ["task_routing_load", "task_routing_summary"],
    });
  }

  if (find("proxy_health") && !find("proxy_health")!.ok) {
    recommendations.push({
      category: "network",
      severity: "warning",
      message: "Proxy configuration looks degraded.",
      suggested_action: "Check `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, especially local placeholders or dead ports.",
      related_checks: ["proxy_health", "runtime_profile"],
    });
  }

  if ((find("workspace_writable") && !find("workspace_writable")!.ok) || (find("runtime_writable") && !find("runtime_writable")!.ok)) {
    recommendations.push({
      category: "filesystem",
      severity: "warning",
      message: "One or more writable roots are not writable.",
      suggested_action: "Check directory permissions and confirm the workspace/runtime roots are writable by this process.",
      related_checks: ["workspace_writable", "runtime_writable"],
    });
  }

  if (find("search_provider_readiness") && !find("search_provider_readiness")!.ok) {
    recommendations.push({
      category: "search",
      severity: "warning",
      message: "Search provider is only partially configured.",
      suggested_action: "Add the active provider section and required API key, or switch to a provider that is already configured.",
      related_checks: ["search_provider_readiness"],
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      category: "runtime",
      severity: "info",
      message: "No critical doctor issues were detected.",
      suggested_action: "Use `/v1/jobs/:id/runtime-profile`, `/events`, and `/timeline` when you need job-specific diagnostics.",
      related_checks: checks.filter((check) => check.ok).map((check) => check.name),
    });
  }

  return recommendations;
}

function runWritableCheck(targetDir: string, label: string): DoctorCheck {
  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const probePath = join(targetDir, `.doctor-write-check-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(probePath, "ok", "utf8");
    unlinkSync(probePath);
    return {
      name: `${label}_writable`,
      ok: true,
      summary: `${label} is writable.`,
      detail: { path: targetDir },
    };
  } catch (error) {
    return {
      name: `${label}_writable`,
      ok: false,
      summary: `${label} is not writable.`,
      detail: {
        path: targetDir,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function buildDoctorReport(configPath?: string): Record<string, unknown> {
  ensureRuntimeDirectories();
  const resolvedPath = configPath?.trim() || "config/config.yml";
  const checks: DoctorCheck[] = [];

  try {
    const config = loadConfig(resolvedPath);
    checks.push({
      name: "config_load",
      ok: true,
      summary: "Configuration loaded successfully.",
        detail: {
          planner_model: config.planner.model,
          executor_model: config.executor.model,
          auto_resume_concurrency: config.policy.autoResumeConcurrency,
        },
      });
    checks.push(buildModelConfigCheck("planner_model_config", "planner", config.planner));
    checks.push(buildModelConfigCheck("executor_model_config", "executor", config.executor));
    checks.push({
      name: "executor_candidate_queue",
      ok: config.modelRouting.executorCandidates.length > 0,
      summary: config.modelRouting.executorCandidates.length > 0
        ? `Executor candidate queue contains ${config.modelRouting.executorCandidates.length} model(s).`
        : "Executor candidate queue is empty.",
      detail: {
        executor_candidates: config.modelRouting.executorCandidates,
        candidate_count: config.modelRouting.executorCandidates.length,
      },
    });

    const routing = loadTaskRoutingConfig(config.taskRoutingPath);
    checks.push({
      name: "task_routing_load",
      ok: true,
      summary: "Task routing config loaded successfully.",
      detail: {
        task_routing_path: config.taskRoutingPath,
        route_types: routing.map((route) => route.type),
      },
    });
    checks.push(buildTaskRoutingCheck(config.taskRoutingPath, routing));

    const runtimeProfile = buildRuntimeProfile(config);
    checks.push({
      name: "runtime_profile",
      ok: true,
      summary: "Runtime profile generated successfully.",
      detail: runtimeProfile,
    });

    checks.push({
      name: "proxy_health",
      ok: runtimeProfile.network.proxyHealth === "ok",
      summary: runtimeProfile.network.proxyHealth === "ok"
        ? "Proxy health looks normal."
        : "Proxy configuration looks degraded.",
      detail: runtimeProfile.network,
    });

    checks.push(runWritableCheck(WORKSPACE_ROOT, "workspace"));
    checks.push(runWritableCheck(RUNTIME_ROOT, "runtime"));
    checks.push(runWritableCheck(ARTIFACTS_ROOT, "artifacts"));

    checks.push(buildSearchProviderCheck(config));

    return {
      ok: checks.every((check) => check.ok),
      generated_at: new Date().toISOString(),
      config_path: resolvedPath,
      diagnostic_taxonomy: {
        failure_categories: listFailureCategories(),
      },
      summary: {
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).length,
        total: checks.length,
      },
      recommendations: buildDoctorRecommendations(checks),
      checks,
    };
  } catch (error) {
    checks.push({
      name: "config_load",
      ok: false,
      summary: "Configuration failed to load.",
      detail: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      ok: false,
      generated_at: new Date().toISOString(),
      config_path: resolvedPath,
      diagnostic_taxonomy: {
        failure_categories: listFailureCategories(),
      },
      summary: {
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).length,
        total: checks.length,
      },
      recommendations: buildDoctorRecommendations(checks),
      checks,
    };
  }
}

function runDoctor(configPath?: string): void {
  console.log(JSON.stringify(buildDoctorReport(configPath), null, 2));
}

async function runCliTask(task: string): Promise<void> {
  const baseConfig = loadConfig();
  const healthSelection = await buildHealthyExecutorRuntimeConfig(baseConfig);
  assertHealthyExecutorSelection(healthSelection);
  configureSearchTools(healthSelection.config.search);
  const intentRoute = await detectIntentRoute({
    config: healthSelection.config,
    userGoal: task,
    allowPlannerFallback: true,
  });

  if (shouldDispatchToTeam(intentRoute)) {
    await runCliTeam(task);
    return;
  }

  const logger = createRunLogger(task);
  const result = await dispatchTaskIntentRoute(healthSelection.config, task, intentRoute, logger);
  console.error(`Run log: ${logger.logPath}`);
  console.log(JSON.stringify({
    status: result.status,
    output: result.output,
    verified: result.verified,
    executorHistory: result.executorHistory,
    job: result.job,
    plan: result.plan,
    taskRuns: result.taskRuns,
    artifacts: result.artifacts,
    model_health: healthSelection.results,
  }, null, 2));
}

async function runCliTeam(goal: string, options: { planOnly?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const healthSelection = await buildHealthyExecutorRuntimeConfig(config);
  assertHealthyExecutorSelection(healthSelection);
  configureSearchTools(healthSelection.config.search);
  const logger = createRunLogger(goal);
  const tracer = new Tracer(logger);
  const startedAt = new Date().toISOString();

  const teamAgents = resolveTeamAgents(healthSelection.config);

  const result = await runTeam(healthSelection.config, goal, teamAgents, logger, tracer, { planOnly: options.planOnly });

  // Export dashboard
  const dashData = buildDashboardData(
    logger.runId,
    goal,
    result.tasks,
    tracer.getEvents(),
    startedAt,
    result.job.intentRoute ?? {
      kind: "goal",
      reason: "team CLI mode selected",
      source: "heuristic",
    },
  );
  const jsonPath = exportDashboardJson(dashData);
  const htmlPath = exportDashboardHtml(dashData);
  console.error(`Run log: ${logger.logPath}`);
  console.error(`Dashboard JSON: ${jsonPath}`);
  console.error(`Dashboard HTML: ${htmlPath}`);

  console.log(JSON.stringify({
    goal: result.goal,
    finalAnswer: result.finalAnswer,
    taskResults: Object.fromEntries(result.taskResults),
    memorySummary: result.memorySummary,
    job: result.job,
    plan: result.plan,
    taskRuns: result.taskRuns,
    artifacts: result.artifacts,
    model_health: healthSelection.results,
    traceSummary: tracer.getSummary(),
  }, null, 2));
}

function runServer(port: number): void {
  ensureRuntimeDirectories();
  const config = loadConfig();
  configureSearchTools(config.search);
  const recoveryPromise = recoverInterruptedJobs(config.policy.autoResumeConcurrency);
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dual Agent Orchestrator API listening on http://127.0.0.1:${port}`);
    console.log(`API key: ${getServerApiKey()}`);
    console.log(`Models: ${getExposedModels(config).map((model) => model.id).join(", ")}`);
    void recoveryPromise
      .then((recoveredJobIds) => {
        if (recoveredJobIds.length > 0) {
          console.log(`Recovered interrupted jobs after restart: ${recoveredJobIds.join(", ")}`);
        }
      })
      .catch((error) => {
        console.error(`Failed to recover interrupted jobs after restart: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "config" && args[1] === "validate") {
    runConfigValidation(args[2]);
    return;
  }

  if (args[0] === "doctor") {
    runDoctor(args[1]);
    return;
  }

  if (args[0] === "serve") {
    runServer(getPort(args));
    return;
  }

  if (args[0] === "team") {
    const { goal, planOnly } = parseTeamCliArgs(args.slice(1));
    if (!goal) {
      throw new Error("Usage: node dist/index.js team [plan|--plan-only] \"your multi-agent goal here\"");
    }
    await runCliTeam(goal, { planOnly });
    return;
  }

  const userGoal = args.join(" ").trim();
  if (!userGoal) {
    throw new Error("Usage: node dist/index.js \"your task here\" OR node dist/index.js serve [port] OR node dist/index.js team [plan|--plan-only] \"goal\" OR node dist/index.js config validate [path] OR node dist/index.js doctor [path]");
  }

  await runCliTask(userGoal);
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
  });
}

export const __testables = {
  handleRequest,
  buildHealthResponse,
  parseTeamCliArgs,
  buildJobResponse,
  buildStepList,
  buildJobEvents,
  buildClaudeControlResponse,
  isClaudeControlMessage,
  setTaskExecutorForTests,
  setTeamExecutorForTests,
  resolveTeamAgents,
  resolveRegisteredRoleAgent,
  createTeamApprovalGate,
  persistTeamApprovalSnapshot,
  getActiveJobSession,
  recoverInterruptedJobs,
  buildDoctorReport,
  buildSkillReflectionRecord,
  persistSkillReflectionForRecord,
  runAutomaticSkillEvolutionForRecord,
  shouldAutoAcceptSkillEvolution,
  resolveSkillAutomationRiskTier,
  isAutomationStageAllowedForTier,
  buildSkillEvolutionDynamicRiskSummary,
  setConfigOverrideForTests: (config: OrchestratorConfig | null) => {
    configOverrideForTests = config;
  },
};
