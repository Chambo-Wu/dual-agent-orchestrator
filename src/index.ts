import * as process from "node:process";
import { pathToFileURL } from "node:url";
import { isClaudeControlMessage } from "./chat-message-utils.js";
export { shouldForceTextResponseForToolMessage, summarizeToolResultContent } from "./chat-message-utils.js";
export {
	accumulateToolProgressResult,
	buildAggregatedToolResult,
	buildAggregatedToolStart,
	createProgressAggregationState,
	formatProgressUpdate,
	shouldAggregateToolProgress,
} from "./progress-updates.js";
import { getActiveJobSession } from "./job-runtime.js";
import {
	buildJobEvents,
	buildJobResponse,
	buildStepList,
	configureJobResponseDependencies,
	mergeJobEvents,
	resolveSelectedSkillSummary,
	resolveSkillVerificationSummary,
} from "./job-response.js";
export {
	buildEventSnapshot,
	buildFailureSummary,
	buildJobEvents,
	buildJobListItem,
	buildJobResponse,
	buildJobRouteSet,
	buildResumeFollowTarget,
	buildStepList,
	buildWorkflowEvent,
	buildWorkflowSummary,
	createLifecycleEvent,
	getConfiguredAutoResumeConcurrency,
	getWorkflowAwaitingApprovalTask,
	getWorkflowCurrentTask,
	isRecoveryLifecycleEvent,
	mergeJobEvents,
	resolveSelectedSkillSummary,
	resolveSkillVerificationSummary,
} from "./job-response.js";
import { buildHealthResponse } from "./server-response.js";
export { buildHealthResponse, buildWorkflowPayload } from "./server-response.js";
export { buildModelsResponse, getExposedModels, resolveRequestedModel, type ExposedModel } from "./model-api.js";
import { resolveRegisteredRoleAgent, resolveTeamAgents } from "./team-agents.js";
export { resolveRegisteredRoleAgent, resolveTeamAgents } from "./team-agents.js";
import { buildSkillReflectionRecord } from "./skill-reflection.js";
import { persistSkillReflectionForRecord, runAutomaticSkillEvolutionForRecord } from "./skill-evolution-automation.js";
import {
	buildSkillEvolutionDynamicRiskSummary,
	isAutomationStageAllowedForTier,
	resolveSkillAutomationRiskTier,
	resolveSkillEvolutionSummary,
	shouldAutoAcceptSkillEvolution,
} from "./skill-evolution-control-plane.js";
import {
	assertHealthyExecutorSelection,
	buildClaudeControlResponse,
	createTeamApprovalGate,
	isObjectRecord,
	persistTeamApprovalSnapshot,
	persistWorkflowPayload,
	recoverInterruptedJobs,
	setTaskExecutorForTests,
	setTeamExecutorForTests,
} from "./task-execution.js";
export {
	assertHealthyExecutorSelection,
	buildClaudeControlResponse,
	createTeamApprovalGate,
	isObjectRecord,
	persistTeamApprovalSnapshot,
	persistWorkflowPayload,
	recoverInterruptedJobs,
	setTaskExecutorForTests,
	setTeamExecutorForTests,
	type FixedTaskIds,
	type JobExecutionOptions,
	type OpenAIMessage,
	type TaskExecutionContext,
	type TaskExecutionPayload,
} from "./task-execution.js";
export {
	attachRequestAbortCancellation,
	executeJobByMode,
	runTaskFromMessages,
	runTaskFromMessagesWithRegistration,
	runTaskFromRequest,
	runToolMode,
	type ChatCompletionRequest,
} from "./execution-service.js";
import type { OrchestratorConfig } from "./types.js";
import { main, parseTeamCliArgs } from "./cli/entry.js";
import { buildDoctorReport } from "./cli/doctor.js";
import { handleRequest as routedHandleRequest } from "./server/router.js";
export { handleRequest } from "./server/router.js";
export { getServerApiKey } from "./server/auth.js";
import { getRuntimeConfig, setConfigOverrideForTests as setServerConfigOverrideForTests } from "./server/shared.js";

configureJobResponseDependencies({
	resolveSkillEvolutionSummary: (record) => resolveSkillEvolutionSummary(record, getRuntimeConfig()),
});

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}

export const __testables = {
	handleRequest: routedHandleRequest,
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
	mergeJobEvents,
	resolveSelectedSkillSummary,
	resolveSkillVerificationSummary,
	setConfigOverrideForTests: (config: OrchestratorConfig | null) => {
		setServerConfigOverrideForTests(config);
	},
};
