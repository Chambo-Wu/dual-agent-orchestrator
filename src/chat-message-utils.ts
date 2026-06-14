import { compressJsonOutput, compressToolOutput } from "./compress.js";
import type { ChatMessage } from "./providers/openai-compatible.js";
import { TOOL_DEFINITIONS } from "./tools.js";

const MAX_TOOL_RESULT_CHARS = 2000;
export const MAX_TOOL_MODE_ROUNDS = 4;
const MAX_TOOL_CONTEXT_CHARS = 1200;

export interface OpenAIMessage {
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

export interface ResponseInputItem {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

export interface AnthropicContentBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string;
}

export interface AnthropicMessage {
	role?: string;
	content?: string | AnthropicContentBlock[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getMessageText(message: OpenAIMessage): string {
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

export function getAnthropicContentText(content: string | AnthropicContentBlock[] | undefined): string {
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

	const patterns = [/\bcwd\s*[:=]\s*([^\r\n]+)/i, /\bworking directory\s*[:=]\s*([^\r\n]+)/i, /<cwd>\s*([^<]+)\s*<\/cwd>/i];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return "";
}

export function truncateToolResultContent(content: string): string {
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

export function normalizeChatMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
	return messages.map((message) => ({
		role: message.role || "user",
		content: getMessageText(message),
	}));
}

export function normalizeResponsesInput(input: string | ResponseInputItem[] | undefined, instructions?: string): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [];
	if (typeof instructions === "string" && instructions.trim()) {
		messages.push({ role: "system", content: instructions.trim() });
	}
	if (typeof input === "string" && input.trim()) {
		messages.push({ role: "user", content: input.trim() });
		return messages;
	}
	if (Array.isArray(input)) {
		return messages.concat(
			input.map((item) => ({
				role: item.role || "user",
				content:
					typeof item.content === "string"
						? item.content
						: Array.isArray(item.content)
							? item.content
									.filter((part) => part && part.type === "text" && typeof part.text === "string")
									.map((part) => part.text ?? "")
									.join("\n")
									.trim()
							: "",
			})),
		);
	}
	return messages;
}

export function normalizeAnthropicMessages(messages: AnthropicMessage[] | undefined, system?: string | AnthropicContentBlock[]): OpenAIMessage[] {
	const normalized: OpenAIMessage[] = [];
	const systemText = getAnthropicContentText(system);
	if (systemText) {
		normalized.push({ role: "system", content: systemText });
	}
	if (Array.isArray(messages)) {
		normalized.push(
			...messages.map((message) => ({
				role: message.role || "user",
				content: getAnthropicContentText(message.content),
			})),
		);
	}
	return normalized;
}

export function normalizeAnthropicToolMessages(messages: AnthropicMessage[] | undefined, system?: string | AnthropicContentBlock[]): ChatMessage[] {
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
					content: summarizeToolResultContent(
						typeof part.content === "string" ? part.content : typeof part.text === "string" ? part.text : JSON.stringify(part.content ?? ""),
					),
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

export function safeParseToolInput(argumentsText: string | undefined): Record<string, unknown> {
	if (typeof argumentsText !== "string" || !argumentsText.trim()) {
		return {};
	}
	try {
		const parsed = JSON.parse(argumentsText);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function isSuccessfulNativeToolResult(content: string): boolean {
	return /"ok"\s*:\s*true/i.test(content) || /"summary"\s*:\s*"Wrote file/i.test(content) || /"summary"\s*:\s*"Read file/i.test(content);
}

export function extractLatestOpenAIWriteToolCompletion(messages: OpenAIMessage[] | undefined): boolean {
	if (!Array.isArray(messages) || messages.length < 2) return false;
	const lastMessage = messages[messages.length - 1];
	const previousMessage = messages[messages.length - 2];
	if (lastMessage?.role !== "tool" || previousMessage?.role !== "assistant" || !Array.isArray(previousMessage.tool_calls)) return false;
	const matchedTool = previousMessage.tool_calls.find((call) => call?.id === lastMessage.tool_call_id);
	if (matchedTool?.function?.name !== "write_file") return false;
	return isSuccessfulNativeToolResult(getMessageText(lastMessage));
}

export function extractLatestAnthropicWriteToolCompletion(messages: AnthropicMessage[] | undefined): boolean {
	if (!Array.isArray(messages) || messages.length < 2) return false;
	const lastMessage = messages[messages.length - 1];
	const previousMessage = messages[messages.length - 2];
	if (lastMessage?.role !== "user" || previousMessage?.role !== "assistant") return false;
	if (!Array.isArray(lastMessage.content) || !Array.isArray(previousMessage.content)) return false;
	const latestToolResult = [...lastMessage.content].reverse().find((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
	if (!latestToolResult) return false;
	const matchedToolUse = previousMessage.content.find((part) => part?.type === "tool_use" && part.id === latestToolResult.tool_use_id);
	if (matchedToolUse?.name !== "write_file") return false;
	const content =
		typeof latestToolResult.content === "string"
			? latestToolResult.content
			: typeof latestToolResult.text === "string"
				? latestToolResult.text
				: JSON.stringify(latestToolResult.content ?? "");
	return isSuccessfulNativeToolResult(content);
}

export function extractLatestOpenAIResearchReadCompletion(messages: OpenAIMessage[] | undefined): boolean {
	if (!Array.isArray(messages) || messages.length < 2) return false;
	const lastMessage = messages[messages.length - 1];
	const previousMessage = messages[messages.length - 2];
	if (lastMessage?.role !== "tool" || previousMessage?.role !== "assistant" || !Array.isArray(previousMessage.tool_calls)) return false;
	const matchedTool = previousMessage.tool_calls.find((call) => call?.id === lastMessage.tool_call_id);
	if (matchedTool?.function?.name !== "read_file") return false;
	return isSuccessfulNativeToolResult(getMessageText(lastMessage));
}

export function extractLatestAnthropicResearchReadCompletion(messages: AnthropicMessage[] | undefined): boolean {
	if (!Array.isArray(messages) || messages.length < 2) return false;
	const lastMessage = messages[messages.length - 1];
	const previousMessage = messages[messages.length - 2];
	if (lastMessage?.role !== "user" || previousMessage?.role !== "assistant") return false;
	if (!Array.isArray(lastMessage.content) || !Array.isArray(previousMessage.content)) return false;
	const latestToolResult = [...lastMessage.content].reverse().find((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
	if (!latestToolResult) return false;
	const matchedToolUse = previousMessage.content.find((part) => part?.type === "tool_use" && part.id === latestToolResult.tool_use_id);
	if (matchedToolUse?.name !== "read_file") return false;
	const content =
		typeof latestToolResult.content === "string"
			? latestToolResult.content
			: typeof latestToolResult.text === "string"
				? latestToolResult.text
				: JSON.stringify(latestToolResult.content ?? "");
	return isSuccessfulNativeToolResult(content);
}

export function countToolModeRounds(messages: ChatMessage[]): number {
	return messages.filter((message) => message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0).length;
}

export function shouldForceTextResponseForToolMessage(message: ChatMessage | undefined): boolean {
	if (message?.role !== "tool") {
		return false;
	}
	const content = typeof message.content === "string" ? message.content : "";
	return content.includes("command-results") || content.includes("[...") || content.includes("truncated") || content.length > MAX_TOOL_CONTEXT_CHARS;
}

export function buildUserGoal(messages: OpenAIMessage[]): string {
	const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
	const systemContext = messages
		.filter((message) => message.role === "system")
		.map((message) => getMessageText(message))
		.filter(Boolean)
		.join("\n");
	const cwdHint = extractWorkingDirectoryHint(systemContext);

	if (lastUserMessage) {
		const goal = getMessageText(lastUserMessage);
		return cwdHint && !goal.includes(cwdHint) ? `${goal}\n\nCurrent working directory: ${cwdHint}` : goal;
	}

	return messages
		.map((message) => getMessageText(message))
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function isClaudeControlMessage(goal: string): boolean {
	const trimmed = goal.trim();
	return (
		trimmed === "/init" ||
		trimmed.startsWith("/init ") ||
		/<command-name>\s*\/init\s*<\/command-name>/i.test(trimmed) ||
		/<command-message>\s*init\s*<\/command-message>/i.test(trimmed) ||
		/^\[SUGGESTION MODE:/i.test(trimmed)
	);
}

export function hasAnthropicToolHistory(messages: AnthropicMessage[] | undefined): boolean {
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

export function splitContentForStreaming(content: string): string[] {
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
		return words.map((word, index) => (index === words.length - 1 ? word : `${word} `));
	}

	return [normalized];
}

export function normalizeIncomingTools(tools: unknown): typeof TOOL_DEFINITIONS {
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

export function normalizeOpenAIToolMessages(messages: OpenAIMessage[]): ChatMessage[] {
	return messages.flatMap<ChatMessage>((message) => {
		if (!message || typeof message !== "object") {
			return [];
		}

		const asRecord = message as Record<string, unknown>;
		const role = typeof asRecord.role === "string" ? asRecord.role : "user";
		const content = getMessageText(message);

		if (role === "tool") {
			return [
				{
					role: "tool",
					content: truncateToolResultContent(content),
					tool_call_id: typeof asRecord.tool_call_id === "string" ? asRecord.tool_call_id : undefined,
					name: typeof asRecord.name === "string" ? asRecord.name : undefined,
				},
			];
		}

		const toolCalls = Array.isArray(asRecord.tool_calls)
			? asRecord.tool_calls.flatMap((call) => {
					if (!isObjectRecord(call)) {
						return [];
					}
					const fn = isObjectRecord(call.function) ? call.function : {};
					return [
						{
							id: typeof call.id === "string" ? call.id : undefined,
							type: typeof call.type === "string" ? call.type : "function",
							function: {
								name: typeof fn.name === "string" ? fn.name : undefined,
								arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
							},
						},
					];
				})
			: undefined;

		return [
			{
				role,
				content,
				tool_calls: toolCalls,
			},
		];
	});
}
