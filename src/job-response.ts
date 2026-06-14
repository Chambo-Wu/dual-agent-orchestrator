import { loadConfig } from "./config.js";
import { classifyFailure, getFailureCategoryLabel } from "./failure-classification.js";
import { loadEventsFromDisk } from "./job-event-bus.js";
import type { StoredJobRecord } from "./job-store.js";
import { getExecutorDisplaySummary } from "./output-contract.js";
import { buildSkillOutcomeSummary } from "./skill-outcome.js";
import { buildSkillReflectionRecord } from "./skill-reflection.js";
import { listBuiltinSkills } from "./skill-registry.js";
import { buildSkillVerificationSummary } from "./skill-verification.js";
import { describeJobState, mapJobStatusToLifecycleType, mapJobStatusToUiStatus, mapTaskRunStatusToUiStatus } from "./status-semantics.js";
import { buildTeamAgentRegistrySnapshot } from "./team.js";
import { resolveTeamAgents } from "./team-agents.js";
import type { CandidateSkillSummary, ExecutorOutput, IntentRouteMetadata, SelectedSkillSummary, TaskRun, VerificationCheck } from "./types.js";
import { buildWorkflowGraph } from "./workflow-graph.js";
import { createUiEvent, type WorkflowUiEvent } from "./workflow-ui-events.js";

const DEFAULT_AUTO_RESUME_CONCURRENCY = 3;

type SkillEvolutionSummaryResolver = (record: StoredJobRecord) => Record<string, unknown> | null;
let skillEvolutionSummaryResolver: SkillEvolutionSummaryResolver | null = null;

export function configureJobResponseDependencies(input: { resolveSkillEvolutionSummary?: SkillEvolutionSummaryResolver | null }): void {
	skillEvolutionSummaryResolver = input.resolveSkillEvolutionSummary ?? null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

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

export function resolveSelectedSkillSummary(record: StoredJobRecord, events?: WorkflowUiEvent[]): SelectedSkillSummary | null {
	const direct = record.job.selectedSkill ?? record.plan.selectedSkill;
	if (direct?.skill_id || direct?.skill_action || direct?.skill_reason || direct?.skill_install_status) {
		return {
			...direct,
			skill_install_status: direct.skill_install_status ?? inferSkillInstallStatus(direct.skill_id, direct.skill_action),
		};
	}

	const plannerEvent = [...(events ?? [])].reverse().find((event) => event.type === "planner.decision" || event.type === "workflow.planner.decision");
	const meta = plannerEvent?.meta ?? {};
	const skillId =
		typeof meta.selected_skill === "string" && meta.selected_skill.trim().length > 0
			? meta.selected_skill.trim()
			: typeof meta.skill_id === "string" && meta.skill_id.trim().length > 0
				? meta.skill_id.trim()
				: undefined;
	const skillAction =
		meta.skill_action === "use_installed" || meta.skill_action === "install_then_use" || meta.skill_action === "skip_skill" ? meta.skill_action : undefined;
	const skillReason = typeof meta.skill_reason === "string" && meta.skill_reason.trim().length > 0 ? meta.skill_reason.trim() : undefined;
	const skillInstallStatus =
		typeof meta.skill_install_status === "string" && meta.skill_install_status.trim().length > 0
			? (meta.skill_install_status.trim() as SelectedSkillSummary["skill_install_status"])
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
	return (
		typeof entry.skillId === "string" &&
		typeof entry.score === "number" &&
		Array.isArray(entry.reasons) &&
		(entry.source === "rule" || entry.source === "planner")
	);
}

function resolveCandidateSkillsSummary(record: StoredJobRecord, events?: WorkflowUiEvent[]): CandidateSkillSummary[] {
	const direct = record.job.candidateSkills ?? record.plan.candidateSkills;
	if (Array.isArray(direct) && direct.every(isCandidateSkillSummary)) {
		return [...direct];
	}

	const skillEvent = [...(events ?? [])].reverse().find((event) => event.type === "system.skill_selected");
	const raw = skillEvent?.meta?.candidate_skills;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter(isCandidateSkillSummary);
}

export function resolveSkillVerificationSummary(record: StoredJobRecord): Record<string, unknown> | null {
	const skillVerifyTaskRun = [...record.taskRuns].reverse().find((taskRun) => taskRun.id.endsWith("__skill_verify"));
	if (!skillVerifyTaskRun) {
		return null;
	}
	const skillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
	return buildSkillVerificationSummary(skillVerifyTaskRun, skillId ?? null);
}

export function buildStepList(record: StoredJobRecord): unknown[] {
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

export function createLifecycleEvent(input: {
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

export function intentRouteToMeta(intentRoute: IntentRouteMetadata | undefined): Record<string, unknown> {
	if (!intentRoute) {
		return {};
	}
	return {
		intent_kind: intentRoute.kind,
		intent_reason: intentRoute.reason,
		intent_source: intentRoute.source,
	};
}

export function mapVerificationCheckType(check: VerificationCheck): string {
	if (check.passed) {
		return "system.verification_check_passed";
	}
	return check.status === "insufficient" ? "system.verification_check_insufficient" : "system.verification_check_failed";
}

export function mapVerificationCheckStatus(check: VerificationCheck): WorkflowUiEvent["status"] {
	if (check.passed) {
		return "success";
	}
	return check.status === "insufficient" ? "blocked" : "failed";
}

export function createVerificationCheckEvent(input: {
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
		title: input.check.passed ? "Verification check passed" : checkStatus === "insufficient" ? "Verification check insufficient" : "Verification check failed",
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

export function attachFailureCategory(
	type: string,
	status: WorkflowUiEvent["status"],
	summary: string,
	meta: Record<string, unknown>,
): Record<string, unknown> {
	const existingCategory = typeof meta.failure_category === "string" ? meta.failure_category : null;
	const failureCategory =
		existingCategory ??
		classifyFailure({
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

export function buildJobEvents(record: StoredJobRecord): WorkflowUiEvent[] {
	const events: WorkflowUiEvent[] = [];
	let seq = 1;
	const push = (event: WorkflowUiEvent) => {
		events.push(event);
		seq += 1;
	};

	push(
		createLifecycleEvent({
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
		}),
	);

	push(
		createLifecycleEvent({
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
		}),
	);

	if (record.job.intentRoute ?? record.plan.intentRoute) {
		const intentRoute = record.job.intentRoute ?? record.plan.intentRoute;
		push(
			createLifecycleEvent({
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
			}),
		);
	}

	for (const taskRun of record.taskRuns) {
		push(
			createLifecycleEvent({
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
			}),
		);

		for (const [index, executorOutput] of (taskRun.executorHistory ?? []).entries()) {
			push(
				createLifecycleEvent({
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
				}),
			);
		}

		for (const check of taskRun.verificationResult?.checks ?? []) {
			push(
				createVerificationCheckEvent({
					jobId: record.job.id,
					seq,
					time: record.savedAt,
					check,
					taskRunId: taskRun.id,
					source: "task_run",
					verificationStatus: taskRun.verificationResult?.status,
				}),
			);
		}
	}

	for (const check of record.job.verificationResult?.checks ?? []) {
		push(
			createVerificationCheckEvent({
				jobId: record.job.id,
				seq,
				time: record.savedAt,
				check,
				source: "job",
				verificationStatus: record.job.verificationResult?.status,
			}),
		);
	}

	for (const artifact of record.artifacts) {
		push(
			createLifecycleEvent({
				jobId: record.job.id,
				seq,
				time: record.savedAt,
				type: "artifact.created",
				title: "Artifact created",
				summary: artifact.path ? `Artifact saved to ${artifact.path}.` : `Artifact ${artifact.id} was created.`,
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
			}),
		);
	}

	const selectedSkill = resolveSelectedSkillSummary(record, events);
	const skillVerification = resolveSkillVerificationSummary(record);
	const skillOutcome = buildSkillOutcomeSummary(record, events, selectedSkill, skillVerification);
	const skillReflection = buildSkillReflectionRecord(skillOutcome, {
		record,
		events,
	});
	if (skillReflection) {
		push(
			createLifecycleEvent({
				jobId: record.job.id,
				seq,
				time: skillReflection.createdAt,
				type: "system.skill_reflection_recorded",
				title: "Skill reflection recorded",
				summary: skillReflection.reason,
				status: skillReflection.reflectionKind === "skill_defect" || skillReflection.reflectionKind === "execution_lapse" ? "blocked" : "success",
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
					failure_category:
						skillReflection.reflectionKind === "skill_defect"
							? "verification_failure"
							: skillReflection.reflectionKind === "execution_lapse"
								? "execution_failure"
								: undefined,
				},
			}),
		);
	}

	if (record.control?.cancelledAt) {
		push(
			createLifecycleEvent({
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
			}),
		);
	}

	if (record.control?.retriedAt) {
		push(
			createLifecycleEvent({
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
			}),
		);
	}

	if (record.control?.retryOf) {
		push(
			createLifecycleEvent({
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
			}),
		);
	}

	const recoveryEvent = createRecoveryEvent(record, seq);
	if (recoveryEvent) {
		push(recoveryEvent);
	}

	push(
		createLifecycleEvent({
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
		}),
	);

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
		default:
			return "executor.result";
	}
}

function getRecoveredTaskRunIds(record: StoredJobRecord): string[] {
	if (!record.control?.recoveredAt) {
		return [];
	}
	return record.taskRuns.filter((taskRun) => taskRun.status === "blocked" && /service restart/i.test(taskRun.output)).map((taskRun) => taskRun.id);
}

export function createRecoveryEvent(record: StoredJobRecord, seq: number): WorkflowUiEvent | null {
	if (!record.control?.recoveredAt || record.control.recoveryReason !== "service_restart") {
		return null;
	}
	const autoResumedToJobId = record.control.resumedToJobId;
	const autoResumeStatus = record.control.autoResumeStatus ?? (autoResumedToJobId ? "succeeded" : record.control.autoResumeFailedAt ? "failed" : "queued");
	const autoResumeFailedAt = record.control.autoResumeFailedAt;
	const autoResumeFailureMessage = record.control.autoResumeFailureMessage;
	const queueText =
		typeof record.control.autoResumeQueuePosition === "number" && typeof record.control.autoResumeBatchSize === "number"
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

export function buildJobRouteSet(
	jobId: string,
	routeBasePath = "/v1/jobs",
): {
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

export function buildResumeFollowTarget(sourceJobId: string, resumedToJobId: string | undefined, routeBasePath = "/v1/jobs"): Record<string, unknown> | null {
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

export function buildControlActions(record: StoredJobRecord, routeBasePath = "/v1/jobs"): Array<Record<string, unknown>> {
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

export function isRecoveryLifecycleEvent(type: string): boolean {
	return type === "job.recovered" || type === "job.auto_resume_started" || type === "job.resumed" || type === "job.failed";
}

export function getConfiguredAutoResumeConcurrency(): number {
	try {
		return loadConfig().policy.autoResumeConcurrency;
	} catch {
		return DEFAULT_AUTO_RESUME_CONCURRENCY;
	}
}

export function buildEventSnapshot(record: StoredJobRecord, events: WorkflowUiEvent[], routeBasePath = "/v1/jobs"): Record<string, unknown> | null {
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
	const recovery =
		record.control?.recoveredAt && record.control.recoveryReason
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
		latest_executor_status: typeof latestExecutorEvent?.meta.executor_status === "string" ? latestExecutorEvent.meta.executor_status : null,
		live_artifact_count: events
			.filter((event) => event.agent === "executor" && typeof event.meta.artifact_count === "number")
			.reduce((total, event) => total + Number(event.meta.artifact_count ?? 0), 0),
	};
}

function resolveTeamAgentRegistrySummary(record: StoredJobRecord, events: WorkflowUiEvent[]): Record<string, unknown> | null {
	if (record.job.mode !== "team") {
		return null;
	}
	const registryEvent = [...events].reverse().find((event) => event.type === "system.team_agent_registry_snapshot");
	if (registryEvent && isObjectRecord(registryEvent.meta)) {
		return registryEvent.meta;
	}
	try {
		const config = loadConfig();
		return buildTeamAgentRegistrySnapshot(config, resolveTeamAgents(config)) as unknown as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function mergeJobEvents(record: StoredJobRecord, persistedEvents: WorkflowUiEvent[]): WorkflowUiEvent[] {
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
	const merged = [...fallbackEvents, ...persistedEvents].sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq);
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

	return deduped.reverse().map((event, index) => ({ ...event, seq: index + 1 }));
}

export function buildJobResponse(record: StoredJobRecord, routeBasePath = "/v1/jobs"): unknown {
	const persistedEvents = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
	const liveSnapshot = buildEventSnapshot(record, persistedEvents, routeBasePath);
	const latestStep = record.taskRuns.at(-1);
	const liveJobStatus = typeof liveSnapshot?.job_status === "string" ? liveSnapshot.job_status : record.job.status;
	const liveArtifactCount =
		typeof liveSnapshot?.live_artifact_count === "number" ? Math.max(record.artifacts.length, liveSnapshot.live_artifact_count) : record.artifacts.length;
	const liveExecutorStatus = typeof liveSnapshot?.latest_executor_status === "string" ? liveSnapshot.latest_executor_status : latestExecutorStatus(record);
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
	const teamAgentRegistry = resolveTeamAgentRegistrySummary(record, persistedEvents);
	return {
		saved_at: record.savedAt,
		intent_route: record.job.intentRoute ?? record.plan.intentRoute ?? null,
		candidate_skills: candidateSkills,
		selected_skill: selectedSkill,
		skill_outcome: skillOutcome,
		skill_reflection: skillReflection,
		team_agent_registry: teamAgentRegistry,
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

export function buildJobListItem(record: StoredJobRecord, routeBasePath = "/v1/jobs"): Record<string, unknown> {
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
		team_agent_registry: response.team_agent_registry ?? null,
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

export function buildWorkflowSummary(record: StoredJobRecord): Record<string, unknown> {
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
	const skillEvolution = skillEvolutionSummaryResolver?.(record) ?? null;
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

export function buildFailureSummary(events: WorkflowUiEvent[]): {
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

export function getWorkflowCurrentTask(record: StoredJobRecord): TaskRun | null {
	return record.taskRuns.find((taskRun) => taskRun.status === "awaiting_approval" || taskRun.status === "in_progress" || taskRun.status === "pending") ?? null;
}

export function getWorkflowAwaitingApprovalTask(record: StoredJobRecord): TaskRun | null {
	return record.taskRuns.find((taskRun) => taskRun.status === "awaiting_approval") ?? null;
}

export function buildWorkflowEvent(type: string, workflow: unknown, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type,
		workflow,
		...extra,
	});
}
