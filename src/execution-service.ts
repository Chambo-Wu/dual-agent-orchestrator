import type { ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import {
	buildUserGoal,
	countToolModeRounds,
	MAX_TOOL_MODE_ROUNDS,
	normalizeChatMessages,
	normalizeIncomingTools,
	shouldForceTextResponseForToolMessage,
	type OpenAIMessage,
} from "./chat-message-utils.js";
import { detectIntentRoute } from "./intent-router.js";
import { shouldDispatchToTeam } from "./intent-dispatch.js";
import { cancelActiveJobSession } from "./job-runtime.js";
import { resolveRequestedModel } from "./model-api.js";
import type { ChatMessage, CompletionOverrides } from "./providers/openai-compatible.js";
import { runChatCompletionDetailed } from "./providers/openai-compatible.js";
import type { ChatCompletionRequest } from "./api-types.js";
import {
	buildClaudeControlResponse,
	executeTaskGoal,
	executeTeamGoal,
	type FixedTaskIds,
	type JobExecutionOptions,
	type TaskExecutionPayload,
} from "./task-execution.js";
import type { Job, OrchestratorEventCallback } from "./types.js";

export type { FixedTaskIds, OpenAIMessage, TaskExecutionPayload } from "./task-execution.js";
export type { JobExecutionOptions, TaskExecutionContext } from "./task-execution.js";
export type { ChatCompletionRequest } from "./api-types.js";

export async function executeJobByMode(
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

export async function runTaskFromRequest(body: ChatCompletionRequest): Promise<TaskExecutionPayload> {
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

export async function runTaskFromMessages(
	messages: OpenAIMessage[],
	model: string | undefined,
	onEvent?: OrchestratorEventCallback,
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

	return executePromptByIntent(userGoal, model, onEvent);
}

export async function runTaskFromMessagesWithRegistration(
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

export function attachRequestAbortCancellation(res: ServerResponse, lookupJobId: () => string | null): () => void {
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

export async function runToolMode(
	messages: ChatMessage[],
	model: string | undefined,
	tools: unknown,
	requestOverrides?: CompletionOverrides,
): Promise<{
	resolvedModel: string;
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	content: string;
}> {
	const baseConfig = loadConfig();
	const modelSelection = resolveRequestedModel(baseConfig, model);
	const allowedTools = normalizeIncomingTools(tools);
	const toolRoundCount = countToolModeRounds(messages);
	const lastMessage = messages[messages.length - 1];
	const forceTextResponse = toolRoundCount >= MAX_TOOL_MODE_ROUNDS || shouldForceTextResponseForToolMessage(lastMessage);
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
