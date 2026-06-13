import { existsSync } from "node:fs";
import { loadEventsFromDisk } from "./job-event-bus.js";
import type { validateSkillEvolutionProposal } from "./skill-deployment-validator.js";
import {
	getSkillEvolutionProposalCandidateRoot,
	getSkillEvolutionProposalRollbackRoot,
	listSkillEvolutionProposals,
	readSkillAuditReport,
	readSkillDeploymentValidationReport,
	readSkillEvolutionDecisionRecord,
	readSkillReflectionRecord,
} from "./skill-evolution-store.js";
import type {
	SkillEvolutionAutomationBlockSummary,
	SkillEvolutionDecisionRecord,
	SkillEvolutionProposal,
	SkillProposalStatus,
} from "./skill-evolution-types.js";
import type { getSkillManifest } from "./skill-registry.js";
import type { OrchestratorConfig } from "./types.js";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function shouldAutoAcceptSkillEvolution(validation: ReturnType<typeof validateSkillEvolutionProposal>, config: OrchestratorConfig): boolean {
	return config.skillEvolution.autoAccept && validation.passed && validation.decision.autoAcceptReady;
}

export type SkillEvolutionAutomationStage = "auto_reflect" | "auto_propose" | "auto_audit" | "auto_validate" | "auto_accept";

export const SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER: Record<SkillEvolutionAutomationStage, number> = {
	auto_reflect: 1,
	auto_propose: 2,
	auto_audit: 3,
	auto_validate: 4,
	auto_accept: 5,
};
export function isSkillEvolutionAutomationStage(value: unknown): value is SkillEvolutionAutomationStage {
	return value === "auto_reflect" || value === "auto_propose" || value === "auto_audit" || value === "auto_validate" || value === "auto_accept";
}

export function resolveSkillAutomationRiskTier(manifest: ReturnType<typeof getSkillManifest> | null, config: OrchestratorConfig): "low" | "medium" | "high" {
	const intents = new Set(manifest?.intents ?? []);
	if (intents.has("coding") || intents.has("file_ops")) {
		return "high";
	}
	return config.skillEvolution.riskTiering.defaultTier;
}

export function isAutomationStageAllowedForTier(tier: "low" | "medium" | "high", stage: SkillEvolutionAutomationStage, config: OrchestratorConfig): boolean {
	if (!config.skillEvolution.riskTiering.enabled) {
		return true;
	}
	const ceiling = config.skillEvolution.riskTiering.automationCeilings[tier];
	return SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[stage] <= SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[ceiling];
}

export function isAutomationStageAllowedForCeiling(ceiling: SkillEvolutionAutomationStage, stage: SkillEvolutionAutomationStage): boolean {
	return SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[stage] <= SKILL_EVOLUTION_AUTOMATION_STAGE_ORDER[ceiling];
}

export function isLowRiskPilotSkill(skillId: string, riskTier: "low" | "medium" | "high", config: OrchestratorConfig): boolean {
	return riskTier === "low" && config.skillEvolution.riskTiering.lowRiskPilotSkills.includes(skillId);
}

export function buildAutomationCeilingBlockMeta(
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

export function buildDynamicAutomationCeilingBlockMeta(
	skillId: string,
	blockedStage: SkillEvolutionAutomationStage,
	dynamicRisk: Record<string, unknown>,
	context?: {
		reflectionId?: string;
		proposalId?: string;
	},
): Record<string, unknown> {
	const ceiling = isSkillEvolutionAutomationStage(dynamicRisk.automation_ceiling) ? dynamicRisk.automation_ceiling : "auto_validate";
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

export type SkillEvolutionProposalControlPlaneRecord = SkillEvolutionProposal & {
	automation_block: SkillEvolutionAutomationBlockSummary | null;
	validation_summary: Record<string, unknown> | null;
	dynamic_risk: Record<string, unknown>;
	eligibility: Record<string, unknown>;
	ops_summary: Record<string, unknown>;
	rollback_guide: Record<string, unknown> | null;
};

export const SKILL_EVOLUTION_QUEUE_STATUSES = new Set<SkillProposalStatus>(["draft", "auditing", "audit_failed", "validated", "validation_failed"]);

export function classifySkillEvolutionAgeBucket(createdAt: string, now = Date.now()): "under_1h" | "over_1h" | "over_24h" {
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

export function resolveSkillEvolutionQueueState(status: SkillProposalStatus): "proposal_queue" | "accepted_history" | "rejected_history" {
	if (status === "accepted") {
		return "accepted_history";
	}
	if (status === "rejected") {
		return "rejected_history";
	}
	return "proposal_queue";
}

export function resolveSkillEvolutionFunnelStage(status: SkillProposalStatus): string {
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

export function buildSkillEvolutionProposalOpsSummary(
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
	const stuckState = resolveSkillEvolutionStuckState(proposal, validationSummary, automationBlock, dynamicRisk, now);
	const nextAction =
		typeof stuckState.next_action === "string"
			? stuckState.next_action
			: proposal.status === "draft"
				? "run_audit"
				: proposal.status === "auditing"
					? "wait_for_audit"
					: proposal.status === "audit_failed"
						? "regenerate_or_reject"
						: proposal.status === "validation_failed"
							? "inspect_validation"
							: proposal.status === "validated" && eligible
								? "accept"
								: proposal.status === "validated"
									? "manual_review"
									: proposal.status === "accepted"
										? "monitor_or_rollback"
										: "none";
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
		next_action: nextAction,
		queue_category: stuckState.primary_category ?? (queueState === "proposal_queue" ? "ready_for_operator" : queueState),
		stuck_state: stuckState,
		rollback_available: rollbackGuide && rollbackGuide.rollback_available === true,
	};
}

export function resolveSkillEvolutionStuckState(
	proposal: SkillEvolutionProposal,
	validationSummary: Record<string, unknown> | null,
	automationBlock: SkillEvolutionAutomationBlockSummary | null,
	dynamicRisk: Record<string, unknown>,
	now = Date.now(),
): Record<string, unknown> {
	const ageBucket = classifySkillEvolutionAgeBucket(proposal.createdAt, now);
	const inQueue = SKILL_EVOLUTION_QUEUE_STATUSES.has(proposal.status);
	const categories: Array<{
		category: string;
		severity: "info" | "warning" | "critical";
		reason: string;
		action_hint: string;
	}> = [];
	if (inQueue && automationBlock) {
		categories.push({
			category: "automation_blocked",
			severity: "warning",
			reason: `automation blocked at ${automationBlock.blockedStage}`,
			action_hint: "Review the automation ceiling and decide whether this proposal should continue manually.",
		});
	}
	if (inQueue && proposal.status === "audit_failed") {
		categories.push({
			category: "audit_failed",
			severity: "critical",
			reason: "audit failed",
			action_hint: "Inspect the audit report and regenerate or reject the proposal.",
		});
	}
	if (inQueue && proposal.status === "validation_failed") {
		categories.push({
			category: "validation_failed",
			severity: "critical",
			reason: "validation failed",
			action_hint: "Inspect validation failures before retrying or regenerating the proposal.",
		});
	}
	if (inQueue && (dynamicRisk.tier === "high" || dynamicRisk.auto_accept_blocked === true)) {
		categories.push({
			category: "dynamic_risk_blocked",
			severity: dynamicRisk.tier === "high" ? "critical" : "warning",
			reason: dynamicRisk.tier === "high" ? "dynamic risk is high" : "dynamic risk blocks auto-accept",
			action_hint: "Wait for cooldown or manually review recent failures before accepting.",
		});
	}
	if (inQueue && validationSummary && validationSummary.auto_accept_ready !== true && proposal.status === "validated") {
		categories.push({
			category: "manual_accept_required",
			severity: "warning",
			reason: "validated but not auto-accept eligible",
			action_hint: "Review validation summary and accept or reject manually.",
		});
	}
	if (inQueue && ageBucket !== "under_1h") {
		categories.push({
			category: "aging_queue",
			severity: ageBucket === "over_24h" ? "critical" : "warning",
			reason: `proposal age bucket is ${ageBucket}`,
			action_hint: "Prioritize this proposal or explicitly reject it to keep the queue fresh.",
		});
	}
	const reasons = categories.map((item) => item.reason);
	const primary = categories[0] ?? null;
	const nextAction =
		primary?.category === "automation_blocked"
			? "manual_review"
			: primary?.category === "audit_failed"
				? "regenerate_or_reject"
				: primary?.category === "validation_failed"
					? "inspect_validation"
					: primary?.category === "dynamic_risk_blocked"
						? "wait_or_manual_review"
						: primary?.category === "manual_accept_required"
							? "manual_review"
							: primary?.category === "aging_queue"
								? "prioritize_or_reject"
								: null;
	return {
		stuck: reasons.length > 0,
		stage: primary?.reason ?? null,
		primary_category: primary?.category ?? null,
		severity: primary?.severity ?? null,
		action_hint: primary?.action_hint ?? null,
		next_action: nextAction,
		categories,
		reasons,
		age_bucket: ageBucket,
	};
}

export function readAutomationBlockForProposal(proposal: SkillEvolutionProposal, config: OrchestratorConfig): SkillEvolutionAutomationBlockSummary | null {
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
	if (
		(riskTier !== "low" && riskTier !== "medium" && riskTier !== "high") ||
		(blockedStage !== "auto_reflect" &&
			blockedStage !== "auto_propose" &&
			blockedStage !== "auto_audit" &&
			blockedStage !== "auto_validate" &&
			blockedStage !== "auto_accept") ||
		(automationCeiling !== "auto_reflect" &&
			automationCeiling !== "auto_propose" &&
			automationCeiling !== "auto_audit" &&
			automationCeiling !== "auto_validate" &&
			automationCeiling !== "auto_accept")
	) {
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

export function buildSkillEvolutionDynamicRiskSummary(
	proposal: SkillEvolutionProposal,
	validationSummary: Record<string, unknown> | null,
	config: OrchestratorConfig,
	proposalHistory?: SkillEvolutionProposal[],
): Record<string, unknown> {
	const now = Date.now();
	const windowHours =
		typeof config.skillEvolution.riskTiering.dynamicWindowHours === "number" && Number.isFinite(config.skillEvolution.riskTiering.dynamicWindowHours)
			? config.skillEvolution.riskTiering.dynamicWindowHours
			: 24;
	const windowMs = windowHours * 60 * 60 * 1000;
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
	const replayInstabilitySignals = validationReports
		.filter(
			(report) =>
				isRecent(report.createdAt) &&
				(report.stability?.autoAcceptBlocked === true ||
					report.stability?.replayInstabilityDetected === true ||
					report.replay?.sameInputComparison?.readiness !== "ready" ||
					report.replay?.runtimeBoundary?.trueRuntimeReplayReady !== true),
		)
		.map((report) => report.createdAt);
	const auditFailureCount = auditFailureSignals.length;
	const validationFailureCount = validationFailureSignals.length;
	const replayInstabilityCount = replayInstabilitySignals.length;
	const recentReports = validationReports.filter((report) => isRecent(report.createdAt));
	const failureRateSampleCount = recentReports.length;
	const failureRateFailureCount = recentReports.filter((report) => !report.passed).length;
	const failureRate = failureRateSampleCount > 0 ? failureRateFailureCount / failureRateSampleCount : 0;
	const failureRateDowngrade = failureRateSampleCount >= 2 && failureRate >= 0.5;
	const signalTimes = [...auditFailureSignals, ...validationFailureSignals, ...replayInstabilitySignals]
		.map((createdAt) => Date.parse(createdAt))
		.filter((value) => Number.isFinite(value));
	const newestSignalMs = signalTimes.length > 0 ? Math.max(...signalTimes) : null;
	const cooldownUntilMs = newestSignalMs === null ? null : newestSignalMs + windowMs;
	const cooldownActive = cooldownUntilMs !== null && cooldownUntilMs > now;
	const newestSignalAt = newestSignalMs === null ? null : new Date(newestSignalMs).toISOString();
	const cooldownUntil = cooldownUntilMs === null ? null : new Date(cooldownUntilMs).toISOString();
	const currentAutoAcceptReady = validationSummary?.auto_accept_ready === true;
	const currentReadiness = typeof validationSummary?.same_input_readiness === "string" ? validationSummary.same_input_readiness : null;
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
	if (failureRateDowngrade) {
		reasons.push(`recent validation failure rate is ${failureRateFailureCount}/${failureRateSampleCount}`);
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
	const failureClusters = [
		{
			category: "audit_failure",
			count: auditFailureCount,
			window_hours: windowHours,
			newest_signal_at: auditFailureSignals
				.map((createdAt) => Date.parse(createdAt))
				.filter((value) => Number.isFinite(value))
				.sort((left, right) => right - left)[0],
			downgrade_stage: auditFailureCount > 0 ? "auto_propose" : null,
		},
		{
			category: "validation_failure",
			count: validationFailureCount,
			window_hours: windowHours,
			newest_signal_at: validationFailureSignals
				.map((createdAt) => Date.parse(createdAt))
				.filter((value) => Number.isFinite(value))
				.sort((left, right) => right - left)[0],
			downgrade_stage: validationFailureCount > 0 ? "auto_audit" : null,
		},
		{
			category: "replay_instability",
			count: replayInstabilityCount,
			window_hours: windowHours,
			newest_signal_at: replayInstabilitySignals
				.map((createdAt) => Date.parse(createdAt))
				.filter((value) => Number.isFinite(value))
				.sort((left, right) => right - left)[0],
			downgrade_stage: replayInstabilityCount >= 2 ? "auto_audit" : replayInstabilityCount > 0 ? "auto_validate" : null,
		},
		{
			category: "validation_failure_rate",
			count: failureRateFailureCount,
			window_hours: windowHours,
			sample_count: failureRateSampleCount,
			failure_rate: failureRate,
			downgrade_stage: failureRateDowngrade ? "auto_audit" : null,
		},
	].map((cluster) => ({
		...cluster,
		newest_signal_at: typeof cluster.newest_signal_at === "number" ? new Date(cluster.newest_signal_at).toISOString() : null,
		active: (typeof cluster.count === "number" && cluster.count > 0) || cluster.downgrade_stage !== null,
	}));

	const tier: "low" | "medium" | "high" =
		validationFailureCount > 0 || replayInstabilityCount >= 2 || failureRateDowngrade
			? "high"
			: auditFailureCount > 0 || replayInstabilityCount > 0
				? "medium"
				: "low";
	const automationCeiling: SkillEvolutionAutomationStage =
		validationFailureCount > 0 || replayInstabilityCount >= 2 || failureRateDowngrade
			? "auto_audit"
			: auditFailureCount > 0
				? "auto_propose"
				: replayInstabilityCount > 0
					? "auto_validate"
					: config.skillEvolution.riskTiering.automationCeilings.low;
	const gateSummary = (["auto_audit", "auto_validate", "auto_accept"] as const).map((stage) => ({
		stage,
		allowed_by_ceiling: isAutomationStageAllowedForCeiling(automationCeiling, stage),
		allowed_by_config:
			stage === "auto_audit"
				? config.skillEvolution.autoAudit
				: stage === "auto_validate"
					? config.skillEvolution.autoValidate
					: config.skillEvolution.autoAccept,
		blocked_by_dynamic_risk: !isAutomationStageAllowedForCeiling(automationCeiling, stage),
		reason: !isAutomationStageAllowedForCeiling(automationCeiling, stage)
			? `dynamic risk ceiling ${automationCeiling} is below ${stage}`
			: stage === "auto_accept" && !currentAutoAcceptReady
				? "current proposal is not auto-accept ready"
				: "gate allowed by dynamic risk",
	}));
	const recoveryPolicy = {
		strategy: "cooldown_window_clear",
		window_hours: windowHours,
		cooldown_active: cooldownActive,
		cooldown_until: cooldownUntil,
		recovery_condition: cooldownActive
			? `no new audit, validation, or replay instability signals before ${cooldownUntil}`
			: "dynamic risk can recover when no recent failure cluster remains in the configured window",
		restored_ceiling: config.skillEvolution.riskTiering.automationCeilings.low,
	};
	return {
		tier,
		source: "recent_skill_evolution_history",
		automation_ceiling: automationCeiling,
		auto_accept_blocked: tier !== "low" || !currentAutoAcceptReady,
		audit_failure_count: auditFailureCount,
		validation_failure_count: validationFailureCount,
		replay_instability_count: replayInstabilityCount,
		failure_rate: failureRate,
		failure_rate_sample_count: failureRateSampleCount,
		failure_rate_failure_count: failureRateFailureCount,
		failure_rate_downgrade: failureRateDowngrade,
		failure_clusters: failureClusters,
		gate_summary: gateSummary,
		recovery_policy: recoveryPolicy,
		sampled_proposal_count: skillProposals.length,
		window_hours: windowHours,
		newest_signal_at: newestSignalAt,
		cooldown_until: cooldownUntil,
		cooldown_active: cooldownActive,
		reasons: reasons.length > 0 ? reasons : ["no recent dynamic risk signals"],
	};
}

export function buildSkillEvolutionEligibilitySummary(
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
		const readiness = typeof validationSummary.same_input_readiness === "string" ? validationSummary.same_input_readiness : null;
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
	const validationReady = validationSummary?.auto_accept_ready === true;
	const sameInputReadiness = typeof validationSummary?.same_input_readiness === "string" ? validationSummary.same_input_readiness : null;
	const state = eligible ? "eligible" : !validationSummary ? "pending_validation" : validationSummary.passed !== true ? "validation_required" : "blocked";
	return {
		eligible,
		action: eligible ? "auto_accept" : "manual_review",
		reasons: eligible ? ["auto-accept eligibility checks passed"] : reasons,
		contract: {
			state,
			gates: {
				proposal_status_validated: proposal.status === "validated",
				validation_passed: validationSummary?.passed === true,
				validation_auto_accept_ready: validationReady,
				same_input_ready: sameInputReadiness === null || sameInputReadiness === "ready",
				automation_not_blocked: automationBlock === null,
				dynamic_risk_allows_auto_accept: dynamicRisk.auto_accept_blocked !== true,
			},
			required_action: eligible ? "auto_accept" : state === "pending_validation" ? "run_validation" : "manual_review",
		},
	};
}

export function buildSkillEvolutionProposalControlPlaneRecord(
	proposal: SkillEvolutionProposal,
	config: OrchestratorConfig,
	proposalHistory?: SkillEvolutionProposal[],
): SkillEvolutionProposalControlPlaneRecord {
	const validation = readSkillDeploymentValidationReport(proposal.id, config.skillEvolution.candidateDir);
	const validationSummary = validation ? buildSkillEvolutionValidationSummary(validation) : null;
	const automationBlock = readAutomationBlockForProposal(proposal, config);
	const dynamicRisk = buildSkillEvolutionDynamicRiskSummary(proposal, validationSummary, config, proposalHistory);
	const eligibility = buildSkillEvolutionEligibilitySummary(proposal, validationSummary, automationBlock, dynamicRisk);
	const acceptedDecision =
		proposal.status === "accepted" ? readSkillEvolutionDecisionRecord(proposal.id, "accepted", config.skillEvolution.candidateDir) : null;
	const rollbackGuide = proposal.status === "accepted" ? buildSkillEvolutionRollbackGuide(proposal, acceptedDecision, config) : null;
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

export function buildSkillEvolutionOpsItem(record: SkillEvolutionProposalControlPlaneRecord, config: OrchestratorConfig): Record<string, unknown> {
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
		rollback_guide_url: record.status === "accepted" ? `/v1/skill-evolution/proposals/${encodeURIComponent(record.id)}` : null,
		candidate_path: getSkillEvolutionProposalCandidateRoot(record.id, config.skillEvolution.candidateDir),
	};
}

export function buildSkillEvolutionRollbackGuide(
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

export function buildSkillEvolutionOpsSummary(config: OrchestratorConfig): Record<string, unknown> {
	const proposals = listSkillEvolutionProposals(config.skillEvolution.candidateDir);
	const records = proposals.map((proposal) => buildSkillEvolutionProposalControlPlaneRecord(proposal, config, proposals));
	const proposalQueue = records
		.filter((record) => SKILL_EVOLUTION_QUEUE_STATUSES.has(record.status))
		.map((record) => buildSkillEvolutionOpsItem(record, config));
	const acceptedRecords = records.filter((record) => record.status === "accepted");
	const acceptedHistory = acceptedRecords.map((record) => {
		const decision = readSkillEvolutionDecisionRecord(record.id, "accepted", config.skillEvolution.candidateDir);
		return {
			...buildSkillEvolutionOpsItem(record, config),
			decision: decision
				? {
						decision: decision.decision,
						reason: decision.reason ?? null,
						created_at: decision.createdAt,
					}
				: null,
			rollback: buildSkillEvolutionRollbackGuide(record, decision, config),
		};
	});
	const statusCounts = records.reduce<Record<string, number>>((acc, record) => {
		acc[record.status] = (acc[record.status] ?? 0) + 1;
		return acc;
	}, {});
	const now = Date.now();
	const agingBuckets = proposalQueue.reduce<Record<string, number>>(
		(acc, item) => {
			const bucket = classifySkillEvolutionAgeBucket(typeof item.created_at === "string" ? item.created_at : "", now);
			acc[bucket] = (acc[bucket] ?? 0) + 1;
			return acc;
		},
		{ under_1h: 0, over_1h: 0, over_24h: 0 },
	);
	const dynamicRiskCounts = records.reduce<Record<string, number>>(
		(acc, record) => {
			const tier = typeof record.dynamic_risk.tier === "string" ? record.dynamic_risk.tier : "unknown";
			acc[tier] = (acc[tier] ?? 0) + 1;
			return acc;
		},
		{ low: 0, medium: 0, high: 0 },
	);
	const eligibilityCounts = records.reduce<Record<string, number>>(
		(acc, record) => {
			const key = record.eligibility.eligible === true ? "eligible" : "blocked";
			acc[key] = (acc[key] ?? 0) + 1;
			return acc;
		},
		{ eligible: 0, blocked: 0 },
	);
	const stuckCount = records.filter((record) => {
		const stuckState = record.ops_summary.stuck_state;
		return isObjectRecord(stuckState) && stuckState.stuck === true;
	}).length;
	const stuckCategories = records.reduce<Record<string, number>>((acc, record) => {
		const stuckState = record.ops_summary.stuck_state;
		if (!isObjectRecord(stuckState) || !Array.isArray(stuckState.categories)) {
			return acc;
		}
		for (const category of stuckState.categories) {
			if (!isObjectRecord(category) || typeof category.category !== "string") {
				continue;
			}
			acc[category.category] = (acc[category.category] ?? 0) + 1;
		}
		return acc;
	}, {});
	const filterOptions = {
		skills: [...new Set(records.map((record) => record.skillId))].sort(),
		statuses: [...new Set(records.map((record) => record.status))].sort(),
		risk_tiers: [
			...new Set(
				records.map((record) => {
					const tier = record.dynamic_risk.tier;
					return typeof tier === "string" ? tier : "unknown";
				}),
			),
		].sort(),
		queue_states: [
			...new Set(
				records.map((record) => {
					const queueState = record.ops_summary.queue_state;
					return typeof queueState === "string" ? queueState : "unknown";
				}),
			),
		].sort(),
		next_actions: [
			...new Set(
				records.map((record) => {
					const nextAction = record.ops_summary.next_action;
					return typeof nextAction === "string" ? nextAction : "unknown";
				}),
			),
		].sort(),
	};
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
			stuck_categories: stuckCategories,
		},
		filters: filterOptions,
		proposal_queue: proposalQueue,
		accepted_history: acceptedHistory,
		rollback_guides: acceptedHistory.map((item) => item.rollback),
	};
}

export function summarizeReplayJob(
	replayJob:
		| {
				status?: string;
				verificationStatus?: string;
				events?: Array<{
					type?: string;
					status?: string;
					summary?: string;
				}>;
		  }
		| null
		| undefined,
): Record<string, unknown> | null {
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

export function buildSkillEvolutionValidationSummary(validation: {
	passed: boolean;
	risk?: {
		tier?: string;
	};
	stability?: {
		replayStabilityScore?: number;
		replayStabilityLevel?: string;
	};
	decision?: {
		reasonCode?: string;
		autoAcceptReady?: boolean;
	};
	resultTaxonomy?: {
		category?: string;
		reason?: string;
		retryable?: boolean;
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
			runtimeConfig?: {
				replayTaskPayloads?: Array<{
					taskRunId?: string;
					title?: string;
					status?: string;
					verified?: boolean;
					artifactCount?: number;
					attempts?: number;
					assignee?: string | null;
					dependsOn?: string[];
					outputPreview?: string;
				}>;
			};
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
	const candidateTerminalType = candidateReplay && typeof candidateReplay.terminal_event_type === "string" ? candidateReplay.terminal_event_type : null;
	const candidateEventCount = candidateReplay && typeof candidateReplay.event_count === "number" ? candidateReplay.event_count : 0;
	const replayHeadline = validation.replay?.provenance?.isolated
		? `Isolated replay ${validation.passed ? "passed" : "ended blocked"} with ${candidateEventCount} candidate event(s) and terminal state ${candidateTerminalType ?? "unknown"}.`
		: "Isolated replay has not executed for this validation result.";
	return {
		passed: validation.passed,
		risk_tier: validation.risk?.tier ?? null,
		reason_code: validation.decision?.reasonCode ?? null,
		result_category: validation.resultTaxonomy?.category ?? null,
		result_reason: validation.resultTaxonomy?.reason ?? null,
		result_retryable: validation.resultTaxonomy?.retryable ?? null,
		auto_accept_ready: validation.decision?.autoAcceptReady ?? false,
		replay_stability_score: validation.stability?.replayStabilityScore ?? null,
		replay_stability_level: validation.stability?.replayStabilityLevel ?? null,
		runtime_boundary: validation.replay?.runtimeBoundary ?? null,
		isolated_replay: validation.replay?.provenance?.isolated ?? false,
		same_input_readiness: validation.replay?.sameInputComparison?.readiness ?? null,
		runtime_replay_task_payloads: validation.replay?.provenance?.runtimeConfig?.replayTaskPayloads ?? [],
		replay_headline: replayHeadline,
		baseline_replay: baselineReplay,
		candidate_replay: candidateReplay,
	};
}
