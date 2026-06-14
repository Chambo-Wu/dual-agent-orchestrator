import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createRunLogger } from "./logger.js";
import { type buildHealthyExecutorRuntimeConfig, NoHealthyExecutorError } from "./model-health.js";
import { PlannerUnavailableError } from "./orchestrator.js";
import { configureSearchTools } from "./tools.js";
import {
	isClaudeControlMessage,
	truncateToolResultContent,
} from "./chat-message-utils.js";
export type { OpenAIMessage } from "./chat-message-utils.js";
import type {
	ApprovalRequest,
	Artifact,
	IntentRouteMetadata,
	Job,
	OrchestratorConfig,
	OrchestratorEvent,
	OrchestratorEventCallback,
	Plan,
	Task,
	TaskRun,
	VerificationCheck,
} from "./types.js";
import { runTeam } from "./team.js";
import { resolveRegisteredRoleAgent, resolveTeamAgents } from "./team-agents.js";
import { resolveRequestedModel, type ExposedModel } from "./model-api.js";
import {
	attachFailureCategory,
	createLifecycleEvent,
	createRecoveryEvent,
	createVerificationCheckEvent,
	intentRouteToMeta,
	mapVerificationCheckStatus,
	mapVerificationCheckType,
} from "./job-response.js";
import { Tracer } from "./trace.js";
import {
	createModelVerifier,
	DEFAULT_VERIFIERS,
	runVerifiers,
	verificationPassed as verificationResultPassed,
	type VerificationContext,
} from "./verification.js";
import { RUNTIME_ROOT, WORKSPACE_ROOT, ensureRuntimeDirectories } from "./paths.js";
import {
	listStoredJobs,
	persistApprovalRequest,
	persistJobRecord,
	readJobRecord,
	updateJobControlState,
	updateStoredJobRecord,
	type StoredJobRecord,
} from "./job-store.js";
import { cancelActiveJobSession, registerActiveJobSession, setApprovalResolver, unregisterActiveJobSession } from "./job-runtime.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "./workflow-contract.js";
import { normalizeWorkflowEvent, type InternalWorkflowEvent, type WorkflowUiEvent } from "./workflow-ui-events.js";
import { appendEvent, getNextSeq } from "./job-event-bus.js";
import { buildWorkflowGraph } from "./workflow-graph.js";
import { mapJobStatusToLifecycleType, mapJobStatusToUiStatus } from "./status-semantics.js";
import { summarizeVerification } from "./output-contract.js";
import { detectIntentRoute } from "./intent-router.js";
import { dispatchTaskIntentRoute } from "./intent-dispatch.js";
import { runAutomaticSkillEvolutionForRecord } from "./skill-evolution-automation.js";
import { assertPlannerCircuitClosed, markPlannerFailure, markPlannerSuccess } from "./planner-circuit.js";

const OPENAI_MODEL_ID = "dual-agent-orchestrator";
const DEFAULT_AUTO_RESUME_CONCURRENCY = 3;

export interface TaskExecutionPayload {
	content: string;
	logPath: string;
	resolvedModel: string;
	job: Job;
	plan: Plan;
	taskRuns: TaskRun[];
	artifacts: Artifact[];
	intentRoute?: IntentRouteMetadata;
}

export interface TaskExecutionContext {
	jobId: string;
	planId: string;
	taskRunId: string;
	signal: AbortSignal;
	emitEvent?: OrchestratorEventCallback;
}

export interface FixedTaskIds {
	jobId: string;
	planId: string;
	taskRunId: string;
}

export interface JobExecutionOptions {
	requirePlannerCircuit?: boolean;
	fixedIds?: FixedTaskIds;
	approvalMode?: string;
}

let injectedTaskExecutor:
	| ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>)
	| null = null;
let injectedTeamExecutor: ((userGoal: string, model: string | undefined, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null = null;

export function assertHealthyExecutorSelection(healthSelection: Awaited<ReturnType<typeof buildHealthyExecutorRuntimeConfig>>): void {
	if (healthSelection.healthyExecutorIds.length > 0) {
		return;
	}
	throw new NoHealthyExecutorError(healthSelection.results);
}

export function setTaskExecutorForTests(
	executor:
		| ((userGoal: string, model: string | undefined, requirePlannerCircuit: boolean, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>)
		| null,
): void {
	injectedTaskExecutor = executor;
}

export function setTeamExecutorForTests(
	executor: ((userGoal: string, model: string | undefined, context?: TaskExecutionContext) => Promise<TaskExecutionPayload>) | null,
): void {
	injectedTeamExecutor = executor;
}

export function persistWorkflowPayload(payload: Pick<TaskExecutionPayload, "job" | "plan" | "taskRuns" | "artifacts">): string {
	ensureRuntimeDirectories();
	return persistJobRecord({
		job: payload.job,
		plan: payload.plan,
		taskRuns: payload.taskRuns,
		artifacts: payload.artifacts,
		workflowGraph: payload.job.workflowGraph,
	});
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
	const activeVerifiers = verifierConfig ? [...DEFAULT_VERIFIERS, createModelVerifier(verifierConfig.model)] : undefined;
	const verificationResult = await runVerifiers(verificationContext, activeVerifiers);
	const allPassed = verificationResultPassed(verificationResult);
	const verifiedJob = allPassed ? { ...payload.job, verificationResult } : { ...payload.job, verified: false, verificationResult };
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
			input.emitLifecycle(
				mapVerificationCheckType(check),
				check.passed ? "Verification check passed" : "Verification check reported issues",
				check.detail,
				mapVerificationCheckStatus(check),
				meta,
			);
		}
	}
	return verifiedJob;
}

export function createTeamApprovalGate(jobId: string): (tasks: readonly Task[]) => Promise<boolean> {
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

export function persistTeamApprovalSnapshot(jobId: string, event: OrchestratorEvent): void {
	if (event.type !== "workflow.task.awaiting_approval") {
		return;
	}
	const taskId = typeof event.data.task_id === "string" ? event.data.task_id : "";
	if (!taskId) {
		return;
	}
	const title = typeof event.data.title === "string" && event.data.title.trim() ? event.data.title.trim() : "Team task awaiting approval";
	const assignee = typeof event.data.assignee === "string" ? event.data.assignee : typeof event.data.role === "string" ? event.data.role : undefined;
	const dependsOn = Array.isArray(event.data.depends_on) ? event.data.depends_on.filter((item): item is string => typeof item === "string") : [];

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
			? record.taskRuns.map((taskRun) => (taskRun.id === taskId ? awaitingTask : taskRun))
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

		const currentTaskRun =
			record.taskRuns.find((taskRun) => taskRun.id === taskRunId) ??
			createTaskRunRecord({
				id: taskRunId,
				title: "Primary Task",
				description: record.job.goal,
				status: "pending",
				verified: false,
				output: "",
				attempts: 0,
				artifacts: [],
			});

		const isTerminalJobEvent = event.type === "job.completed" || event.type === "job.failed" || event.type === "job.cancelled";

		const nextTaskRun = {
			...currentTaskRun,
			status:
				event.type === "job.completed"
					? ("completed" as const)
					: event.type === "job.failed"
						? ("failed" as const)
						: event.type === "job.cancelled"
							? ("blocked" as const)
							: event.type === "system.verification_failed"
								? ("blocked" as const)
								: event.type === "executor.result" || event.type === "executor.partial_success"
									? ("in_progress" as const)
									: event.type === "planner.start" || event.type === "planner.decision" || event.type === "executor.start"
										? ("in_progress" as const)
										: currentTaskRun.status,
			output: !isTerminalJobEvent && typeof event.summary === "string" && event.summary.trim().length > 0 ? event.summary : currentTaskRun.output,
			verified: typeof event.meta?.verified === "boolean" ? event.meta.verified : currentTaskRun.verified,
			attempts: event.step ? Math.max(currentTaskRun.attempts, event.step) : currentTaskRun.attempts,
		};

		if (event.type === "workflow.executor.result" || event.type === "executor.result" || event.type === "executor.partial_success") {
			const artifactCount = typeof event.meta?.artifact_count === "number" ? event.meta.artifact_count : undefined;
			void artifactCount;
		}

		const taskRuns = record.taskRuns.some((taskRun) => taskRun.id === taskRunId)
			? record.taskRuns.map((taskRun) => (taskRun.id === taskRunId ? nextTaskRun : taskRun))
			: [nextTaskRun];

		const latestTaskRun = taskRuns.find((taskRun) => taskRun.id === taskRunId) ?? nextTaskRun;
		const nextJobStatus =
			event.type === "job.completed"
				? ("completed" as const)
				: event.type === "job.failed"
					? ("failed" as const)
					: event.type === "job.cancelled"
						? ("cancelled" as const)
						: event.type === "system.verification_failed"
							? ("blocked" as const)
							: ("running" as const);

		const job = {
			...record.job,
			status: nextJobStatus,
			verified: typeof event.meta?.verified === "boolean" ? event.meta.verified : record.job.verified,
			output: nextJobStatus === "running" ? latestTaskRun.output || record.job.output : record.job.output,
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

export function buildClaudeControlResponse(goal: string): TaskExecutionPayload | null {
	const trimmed = goal.trim();
	if (!isClaudeControlMessage(trimmed)) {
		return null;
	}

	const isInitCommand =
		trimmed === "/init" ||
		trimmed.startsWith("/init ") ||
		/<command-name>\s*\/init\s*<\/command-name>/i.test(trimmed) ||
		/<command-message>\s*init\s*<\/command-message>/i.test(trimmed);
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

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function recoverInterruptedJobs(
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
				taskRuns: record.taskRuns.map((taskRun) =>
					taskRun.status === "completed" || taskRun.status === "failed" || taskRun.status === "blocked" || taskRun.status === "skipped"
						? taskRun
						: {
								...taskRun,
								status: taskRun.status === "awaiting_approval" ? "awaiting_approval" : "blocked",
								output: taskRun.output || "Execution was interrupted by a service restart.",
							},
				),
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

		if (updated?.job.status !== "blocked") {
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
	const workers = Array.from({ length: workerCount }, (_, workerIndex) =>
		(async () => {
			for (let index = workerIndex; index < recoveryCandidates.length; index += workerCount) {
				const candidate = recoveryCandidates[index]!;
				const attemptedAt = new Date().toISOString();
				updateJobControlState(candidate.job.id, {
					autoResumeStatus: "running",
					autoResumeAttemptedAt: attemptedAt,
					autoResumeFailedAt: undefined,
					autoResumeFailureMessage: undefined,
				});
				appendEvent(
					createLifecycleEvent({
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
					}),
				);

				try {
					const resumed =
						candidate.job.mode === "team"
							? await executeTeamGoal(candidate.job.goal, undefined)
							: await executeTaskGoal(candidate.job.goal, undefined, false);
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
					appendEvent(
						createLifecycleEvent({
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
						}),
					);
				} catch (error) {
					const failureMessage = error instanceof Error ? error.message : String(error);
					updateJobControlState(candidate.job.id, {
						autoResumeStatus: "failed",
						autoResumeFailedAt: new Date().toISOString(),
						autoResumeFailureMessage: failureMessage,
					});
					appendEvent(
						createLifecycleEvent({
							jobId: candidate.job.id,
							seq: getNextSeq(candidate.job.id),
							time: new Date().toISOString(),
							type: "job.failed",
							title: "Automatic resume failed",
							summary: "The service restarted but could not automatically resume this job.",
							status: "failed",
							meta: attachFailureCategory("job.failed", "failed", "The service restarted but could not automatically resume this job.", {
								error: failureMessage,
								recovery_reason: "service_restart",
								attempted_auto_resume: true,
								auto_resume_status: "failed",
							}),
						}),
					);
				}
			}
		})(),
	);

	await Promise.all(workers);
	return recoveredJobIds;
}

export async function executeTaskGoal(
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
	const emitLifecycle = (
		type: string,
		title: string,
		summary: string,
		status: WorkflowUiEvent["status"],
		meta: Record<string, unknown> = {},
		phase: WorkflowUiEvent["phase"] = "result",
	) => {
		emitUiEvent(
			createLifecycleEvent({
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
			}),
		);
	};
	const emitVerificationCheck = (check: VerificationCheck, verificationStatus: string, _meta: Record<string, unknown> = {}) => {
		emitUiEvent(
			createVerificationCheckEvent({
				jobId,
				seq: getNextSeq(jobId),
				time: new Date().toISOString(),
				check,
				taskRunId,
				source: "job",
				verificationStatus,
			}),
		);
	};
	const forwardRuntimeEvent: OrchestratorEventCallback = (event) => {
		persistTeamApprovalSnapshot(jobId, event);
		emitUiEvent(
			normalizeWorkflowEvent(
				{ type: event.type, step: event.step, data: event.data } as InternalWorkflowEvent,
				jobId,
				getNextSeq(jobId),
				new Date().toISOString(),
				taskRunId,
			),
		);
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
	emitLifecycle(
		"job.created",
		"Job created",
		"A new job was created and queued for execution.",
		"running",
		{
			mode: pendingJob.mode,
			goal: pendingJob.goal,
			plan_id: pendingPlan.id,
			...intentRouteToMeta(resolvedIntentRoute),
		},
		"start",
	);
	emitLifecycle(
		"job.started",
		"Job started",
		"Execution started for the requested goal.",
		"running",
		{
			plan_id: pendingPlan.id,
			task_run_id: pendingTaskRun.id,
			...intentRouteToMeta(resolvedIntentRoute),
		},
		"start",
	);

	if (!injectedTaskExecutor) {
		const baseConfig = loadConfig();
		modelSelection = resolveRequestedModel(baseConfig, model);
		verificationConfig = modelSelection.resolvedConfig;
		logger = createRunLogger(userGoal);
		resolvedIntentRoute =
			presetIntentRoute ??
			(await detectIntentRoute({
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
			}));
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
		emitLifecycle(
			"system.intent_routed",
			"Intent route selected",
			`Request routed to ${resolvedIntentRoute.kind}.`,
			"running",
			{
				mode: pendingJob.mode,
				...intentRouteToMeta(resolvedIntentRoute),
			},
			"decision",
		);
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
			let result: Awaited<ReturnType<typeof dispatchTaskIntentRoute>>;
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
		emitLifecycle(
			mapJobStatusToLifecycleType(verifiedJob.status),
			"Job finished",
			`Job finished with status ${verifiedJob.status}.`,
			mapJobStatusToUiStatus(verifiedJob.status),
			{
				verified: verifiedJob.verified,
				output_preview: verifiedJob.output.slice(0, 200),
				log_path: payload.logPath,
				job_record_path: jobRecordPath,
			},
			"final",
		);

		console.error(`Run log: ${payload.logPath}`);
		console.error(`Job record: ${jobRecordPath}`);
		return {
			...payload,
			job: verifiedJob,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const healthMeta =
			error instanceof NoHealthyExecutorError
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

export async function executeTeamGoal(
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
	const emitLifecycle = (
		type: string,
		title: string,
		summary: string,
		status: WorkflowUiEvent["status"],
		meta: Record<string, unknown> = {},
		phase: WorkflowUiEvent["phase"] = "result",
	) => {
		emitUiEvent(
			createLifecycleEvent({
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
			}),
		);
	};
	const emitVerificationCheck = (check: VerificationCheck, verificationStatus: string, _meta: Record<string, unknown> = {}) => {
		emitUiEvent(
			createVerificationCheckEvent({
				jobId,
				seq: getNextSeq(jobId),
				time: new Date().toISOString(),
				check,
				taskRunId,
				source: "job",
				verificationStatus,
			}),
		);
	};
	const forwardRuntimeEvent: OrchestratorEventCallback = (event) => {
		emitUiEvent(
			normalizeWorkflowEvent(
				{ type: event.type, step: event.step, data: event.data } as InternalWorkflowEvent,
				jobId,
				getNextSeq(jobId),
				new Date().toISOString(),
				taskRunId,
			),
		);
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
	emitLifecycle(
		"job.created",
		"Job created",
		"A new team job was created and queued for execution.",
		"running",
		{
			mode: pendingJob.mode,
			goal: pendingJob.goal,
			plan_id: pendingPlan.id,
			...intentRouteToMeta(intentRoute),
		},
		"start",
	);
	emitLifecycle(
		"job.started",
		"Job started",
		"Execution started for the requested team goal.",
		"running",
		{
			plan_id: pendingPlan.id,
			task_run_id: pendingTaskRun.id,
			...intentRouteToMeta(intentRoute),
		},
		"start",
	);
	emitLifecycle(
		"system.intent_routed",
		"Intent route selected",
		`Request routed to ${intentRoute.kind}.`,
		"running",
		{
			mode: pendingJob.mode,
			...intentRouteToMeta(intentRoute),
		},
		"decision",
	);

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
			const teamConfig = approvalMode === "always" ? { onApproval: createTeamApprovalGate(jobId) } : undefined;
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
		emitLifecycle(
			mapJobStatusToLifecycleType(verifiedJob.status),
			"Job finished",
			`Job finished with status ${verifiedJob.status}.`,
			mapJobStatusToUiStatus(verifiedJob.status),
			{
				verified: verifiedJob.verified,
				output_preview: verifiedJob.output.slice(0, 200),
				log_path: payload.logPath,
				job_record_path: jobRecordPath,
			},
			"final",
		);
		return {
			...payload,
			job: verifiedJob,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const healthMeta =
			error instanceof NoHealthyExecutorError
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
