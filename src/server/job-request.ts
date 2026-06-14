function extractTaggedValue(input: string, tagName: string): string | undefined {
	const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, "i");
	const match = input.match(pattern);
	return typeof match?.[1] === "string" && match[1].trim() ? match[1].trim() : undefined;
}

export function normalizeDaoRunGoal(rawGoal: string): { goal: string; sanitized: boolean; reason?: string } {
	const trimmed = rawGoal.trim();
	const commandName = extractTaggedValue(trimmed, "command-name")?.replace(/^\//, "");
	const commandArgs = extractTaggedValue(trimmed, "command-args");
	if ((commandName === "dao-run" || commandName === "dao-exec") && commandArgs) {
		return {
			goal: commandArgs,
			sanitized: commandArgs !== trimmed,
			reason: "claude_command_args",
		};
	}

	const flowMatch = trimmed.match(/Execute this exact flow for [`"“]([\s\S]*?)[`"”]\s*:/i);
	if (flowMatch?.[1]?.trim()) {
		return {
			goal: flowMatch[1].trim(),
			sanitized: flowMatch[1].trim() !== trimmed,
			reason: "dao_run_command_body",
		};
	}

	return {
		goal: trimmed,
		sanitized: false,
	};
}
