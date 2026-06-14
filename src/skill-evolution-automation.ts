import { loadConfig } from "./config.js";
import { appendEvent, getNextSeq } from "./job-event-bus.js";
import { readJobRecord, type StoredJobRecord } from "./job-store.js";
import { createLifecycleEvent } from "./job-response.js";
import { auditSkillEvolutionProposal } from "./skill-auditor.js";
import { buildSkillEvolutionProposal, buildSkillReflectionFromRecord } from "./skill-evolution-builders.js";
import {
	buildAutomationCeilingBlockMeta,
	buildDynamicAutomationCeilingBlockMeta,
	buildSkillEvolutionDynamicRiskSummary,
	buildSkillEvolutionValidationSummary,
	isAutomationStageAllowedForCeiling,
	isAutomationStageAllowedForTier,
	isLowRiskPilotSkill,
	isSkillEvolutionAutomationStage,
	resolveSkillAutomationRiskTier,
	shouldAutoAcceptSkillEvolution,
} from "./skill-evolution-control-plane.js";
import { validateSkillEvolutionProposal, validateSkillEvolutionProposalWithRuntimeReplay } from "./skill-deployment-validator.js";
import {
	applyAcceptedSkillProposal,
	persistSkillAuditReport,
	persistSkillDeploymentValidationReport,
	persistSkillEvolutionDecisionRecord,
	persistSkillEvolutionProposal,
	persistSkillReflectionRecord,
	updateSkillEvolutionProposal,
} from "./skill-evolution-store.js";
import type { SkillEvolutionDecisionRecord } from "./skill-evolution-types.js";
import { getSkillManifest } from "./skill-registry.js";
import type { OrchestratorConfig } from "./types.js";

export function persistSkillReflectionForRecord(record: StoredJobRecord, config = loadConfig()): void {
	if (!config.skillEvolution.enabled || !config.skillEvolution.autoReflect) {
		return;
	}
	const skillReflection = buildSkillReflectionFromRecord(record);
	if (!skillReflection) {
		return;
	}
	persistSkillReflectionRecord(skillReflection, config.skillEvolution.candidateDir);
}

export async function runAutomaticSkillEvolutionForRecord(record: StoredJobRecord, config = loadConfig()): Promise<void> {
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
	appendEvent(
		createLifecycleEvent({
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
		}),
	);

	if (!config.skillEvolution.autoPropose || !isAutomationStageAllowedForTier(riskTier, "auto_propose", config)) {
		if (config.skillEvolution.autoPropose && config.skillEvolution.riskTiering.enabled) {
			appendEvent(
				createLifecycleEvent({
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
				}),
			);
		}
		return;
	}

	const proposal = buildSkillEvolutionProposal(reflection, config.skillEvolution.candidateDir, config);
	persistSkillEvolutionProposal(proposal, config.skillEvolution.candidateDir);
	appendEvent(
		createLifecycleEvent({
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
		}),
	);

	const proposalDynamicRisk = buildSkillEvolutionDynamicRiskSummary(proposal, null, config);
	const proposalDynamicCeiling = isSkillEvolutionAutomationStage(proposalDynamicRisk.automation_ceiling)
		? proposalDynamicRisk.automation_ceiling
		: "auto_validate";
	if (
		config.skillEvolution.autoAudit &&
		config.skillEvolution.riskTiering.enabled &&
		!isAutomationStageAllowedForCeiling(proposalDynamicCeiling, "auto_audit")
	) {
		appendEvent(
			createLifecycleEvent({
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
			}),
		);
		return;
	}

	if (!config.skillEvolution.autoAudit || !isAutomationStageAllowedForTier(riskTier, "auto_audit", config)) {
		if (config.skillEvolution.autoAudit && config.skillEvolution.riskTiering.enabled) {
			appendEvent(
				createLifecycleEvent({
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
				}),
			);
		}
		return;
	}

	const audit = auditSkillEvolutionProposal({
		proposal,
		reflection,
		manifest,
	});
	const auditPath = persistSkillAuditReport(audit, config.skillEvolution.candidateDir);
	const auditedProposal = updateSkillEvolutionProposal(
		proposal.id,
		(current) => ({
			...current,
			status: audit.passed ? "validated" : "audit_failed",
			auditReportPath: auditPath,
		}),
		config.skillEvolution.candidateDir,
	);
	if (!auditedProposal) {
		return;
	}
	appendEvent(
		createLifecycleEvent({
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
		}),
	);

	const auditDynamicRisk = buildSkillEvolutionDynamicRiskSummary(auditedProposal, null, config);
	const auditDynamicCeiling = isSkillEvolutionAutomationStage(auditDynamicRisk.automation_ceiling) ? auditDynamicRisk.automation_ceiling : "auto_validate";
	const lowRiskPilotValidate = isLowRiskPilotSkill(auditedProposal.skillId, riskTier, config);
	const autoValidateAllowedByConfig = config.skillEvolution.autoValidate || lowRiskPilotValidate;
	if (
		audit.passed &&
		autoValidateAllowedByConfig &&
		config.skillEvolution.riskTiering.enabled &&
		!isAutomationStageAllowedForCeiling(auditDynamicCeiling, "auto_validate")
	) {
		appendEvent(
			createLifecycleEvent({
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
			}),
		);
		return;
	}

	if (!audit.passed || !autoValidateAllowedByConfig || !isAutomationStageAllowedForTier(riskTier, "auto_validate", config)) {
		if (
			audit.passed &&
			autoValidateAllowedByConfig &&
			config.skillEvolution.riskTiering.enabled &&
			!isAutomationStageAllowedForTier(riskTier, "auto_validate", config)
		) {
			appendEvent(
				createLifecycleEvent({
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
				}),
			);
		} else if (audit.passed && !autoValidateAllowedByConfig) {
			appendEvent(
				createLifecycleEvent({
					jobId: reflection.jobId,
					seq: getNextSeq(reflection.jobId),
					time: new Date().toISOString(),
					type: "system.skill_evolution_automation_blocked",
					title: "Skill evolution automation blocked",
					summary:
						"Automatic skill evolution stopped before validation because auto_validate is disabled and this skill is not in the low-risk pilot allowlist.",
					status: "blocked",
					meta: {
						skill_id: auditedProposal.skillId,
						reflection_id: reflection.id,
						proposal_id: auditedProposal.id,
						risk_tier: riskTier,
						blocked_stage: "auto_validate",
						automation_ceiling: config.skillEvolution.riskTiering.automationCeilings[riskTier],
						low_risk_pilot: false,
					},
				}),
			);
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
	const validatedProposal = updateSkillEvolutionProposal(
		auditedProposal.id,
		(current) => ({
			...current,
			status: validation.passed ? "validated" : "validation_failed",
			validationReportPath: validationPath,
		}),
		config.skillEvolution.candidateDir,
	);
	if (!validatedProposal) {
		return;
	}
	appendEvent(
		createLifecycleEvent({
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
		}),
	);
	const validationSummary = buildSkillEvolutionValidationSummary(validation);
	const dynamicRisk = buildSkillEvolutionDynamicRiskSummary(validatedProposal, validationSummary, config);
	const dynamicCeiling = isSkillEvolutionAutomationStage(dynamicRisk.automation_ceiling) ? dynamicRisk.automation_ceiling : "auto_validate";
	if (config.skillEvolution.autoAccept && config.skillEvolution.riskTiering.enabled && !isAutomationStageAllowedForCeiling(dynamicCeiling, "auto_accept")) {
		appendEvent(
			createLifecycleEvent({
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
			}),
		);
		return;
	}
	if (!shouldAutoAcceptSkillEvolution(validation, config) || !isAutomationStageAllowedForTier(riskTier, "auto_accept", config)) {
		if (
			shouldAutoAcceptSkillEvolution(validation, config) &&
			config.skillEvolution.riskTiering.enabled &&
			!isAutomationStageAllowedForTier(riskTier, "auto_accept", config)
		) {
			appendEvent(
				createLifecycleEvent({
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
				}),
			);
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
	const acceptedProposal = updateSkillEvolutionProposal(
		validatedProposal.id,
		(current) => ({
			...current,
			status: "accepted",
			decidedAt: decisionRecord.createdAt,
		}),
		config.skillEvolution.candidateDir,
	);
	if (!acceptedProposal) {
		return;
	}
	appendEvent(
		createLifecycleEvent({
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
		}),
	);
}
