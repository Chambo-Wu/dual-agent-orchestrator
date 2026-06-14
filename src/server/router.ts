import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceUnavailableError, serviceUnavailableResponse } from "../planner-circuit.js";
import { isAuthorized, unauthorizedResponse } from "./auth.js";
import { handleAnthropicMessages, handleChatCompletions, handleResponses } from "./chat-routes.js";
import {
	buildListedGoalsResponse,
	handleBrowserListGoals,
	handleCreateGoal,
	handleGetGoal,
	handleGoalEvents,
	handleGoalsDashboard,
	handleGoalTimeline,
	handleListGoals,
	handleResumeGoal,
	handleRetryGoal,
	handleReviewGoal,
	handleRunNextGoal,
} from "./goal-routes.js";
import {
	handleApproveJob,
	handleBrowserListJobs,
	handleCancelJob,
	handleCreateJob,
	handleGetJob,
	handleGetJobArtifacts,
	handleGetJobEvents,
	handleGetJobRuntimeProfile,
	handleGetJobSteps,
	handleHealth,
	handleJobStream,
	handleJobsDashboard,
	handleJobTimeline,
	handleListJobs,
	handleModels,
	handleResumeJob,
	handleRetryJob,
} from "./job-routes.js";
import { jsonErrorResponse, jsonResponse, responseAlreadyStarted } from "./shared.js";
import {
	handleAuditSkillEvolutionProposal,
	handleBrowserSkillEvolutionOpsData,
	handleCreateSkillEvolutionProposal,
	handleCreateSkillProposal,
	handleCreateSkillReflection,
	handleGetSkillEvolutionProposal,
	handleInstallSkill,
	handleListSkillEvolutionProposals,
	handleListSkillReflections,
	handleListSkills,
	handleSkillEvolutionDecision,
	handleSkillEvolutionOps,
	handleSkillEvolutionOpsDashboard,
	handleValidateSkillEvolutionProposal,
} from "./skill-evolution-routes.js";

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

		if (method === "GET" && url.pathname === "/skill-evolution/ops") {
			await handleSkillEvolutionOpsDashboard(req, res);
			return;
		}

		if (method === "GET" && url.pathname === "/skill-evolution/ops/data") {
			await handleBrowserSkillEvolutionOpsData(req, res);
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

		if (method === "GET" && url.pathname === "/v1/skill-evolution/ops/dashboard") {
			await handleSkillEvolutionOpsDashboard(req, res);
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
		const isBadRequest =
			message.includes("must be a non-empty array") ||
			message.includes("Unable to derive") ||
			message.includes("Invalid JSON") ||
			message.includes("exceeds maximum size");

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
