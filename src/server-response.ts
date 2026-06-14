import { loadConfig } from "./config.js";
import { summarizeGoals } from "./goal-store.js";
import { listStoredJobs, readJobRecord, type StoredJobRecord } from "./job-store.js";
import { getExposedModels } from "./model-api.js";
import type { ModelHealthResult } from "./model-health.js";
import { getPlannerCircuitRetryAfterSeconds, isPlannerCircuitOpen, plannerCircuit } from "./planner-circuit.js";
import { listSkillEvolutionProposals } from "./skill-evolution-store.js";
import { getInstalledSkillRecord } from "./skill-installer.js";
import { listAvailableSkills, listBuiltinSkills, listInstalledSkills } from "./skill-registry.js";
import { buildTeamAgentRegistrySnapshot } from "./team.js";
import { resolveTeamAgents } from "./team-agents.js";
import type { Artifact, Job, Plan, TaskRun } from "./types.js";

type HealthResponse = {
	status: string;
	planner: Record<string, unknown>;
	executor: Record<string, unknown>;
	runtime: Record<string, unknown>;
	skills?: Record<string, unknown>;
	skill_evolution?: Record<string, unknown>;
	models: string[];
};

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

export function buildHealthResponse(config = loadConfig(), executorHealthResults?: ModelHealthResult[]): HealthResponse {
	const circuitOpen = isPlannerCircuitOpen();
	const executorHealthSummary = summarizeExecutorHealth(executorHealthResults ?? []);
	const probedHealthyCandidates = executorHealthResults?.filter((result) => result.status === "healthy").map((result) => result.modelId) ?? [];
	const recentIntentRoutes = summarizeRecentIntentRoutes();
	const availableSkills = listAvailableSkills(config);
	const builtinSkills = listBuiltinSkills(config);
	const installedSkills = listInstalledSkills(config);
	const goalsSummary = summarizeGoals();
	const skillEvolutionProposals = listSkillEvolutionProposals(config.skillEvolution.candidateDir);
	const lastProposalAt =
		skillEvolutionProposals
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
			retry_after: circuitOpen ? getPlannerCircuitRetryAfterSeconds() : 0,
			last_failure_at: plannerCircuit.lastFailureAt || null,
			last_failure_message: plannerCircuit.lastFailureMessage || null,
		},
		executor: {
			model: config.executor.model,
			base_url: config.executor.baseUrl,
			configured_candidates: config.modelRouting.executorCandidates,
			active_probe: {
				mode: "explicit_probe",
				description:
					"Active probe health for /health and doctor-style diagnostics. This is not the runtime lazy selection cache used during real task execution.",
				healthy_candidates: probedHealthyCandidates,
				health_summary: executorHealthSummary,
				health_checks:
					executorHealthResults?.map((result) => ({
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
			team_agents: buildTeamAgentRegistrySnapshot(config, resolveTeamAgents(config)),
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
				dynamic_window_hours: config.skillEvolution.riskTiering.dynamicWindowHours,
				low_risk_pilot_skills: config.skillEvolution.riskTiering.lowRiskPilotSkills,
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

export function buildWorkflowPayload(payload: { job: Job; plan: Plan; taskRuns: TaskRun[]; artifacts: Artifact[] }): unknown {
	return {
		intent_route: payload.job.intentRoute ?? payload.plan.intentRoute ?? null,
		job: payload.job,
		plan: payload.plan,
		taskRuns: payload.taskRuns,
		artifacts: payload.artifacts,
	};
}
