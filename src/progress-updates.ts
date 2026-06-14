import { truncateToolResultContent } from "./chat-message-utils.js";
import { getExecutorDisplaySummary, getPlannerDecisionText } from "./output-contract.js";
import type { OrchestratorEvent } from "./types.js";

export function formatProgressUpdate(event: OrchestratorEvent): string | null {
	switch (event.type) {
		case "workflow.step.start":
			return buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, "正在规划下一步。");
		case "workflow.planner.decision": {
			const summary = getPlannerDecisionText(event.data);
			return summary
				? buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, humanizePlannerSummary(summary))
				: buildProgressCard(`步骤 ${event.step ?? 1} · 规划中`, "正在整理下一步策略。");
		}
		case "workflow.executor.start": {
			const instruction = typeof event.data.instruction === "string" ? event.data.instruction.trim() : "";
			return instruction
				? buildProgressCard(`步骤 ${event.step ?? 1} · ${inferExecutorPhaseLabel(instruction)}`, humanizeExecutorInstruction(instruction))
				: buildProgressCard(`步骤 ${event.step ?? 1} · 执行中`, "正在处理当前任务。");
		}
		case "workflow.executor.result": {
			const summary = getExecutorDisplaySummary(event.data);
			return summary ? buildProgressCard(`步骤 ${event.step ?? 1} · ${inferExecutionSummaryPhaseLabel(summary)}`, humanizeExecutionSummary(summary)) : null;
		}
		case "workflow.tool.start": {
			const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
			return buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, humanizeToolStart(tool));
		}
		case "workflow.tool.result": {
			const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
			const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
			return summary
				? buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, humanizeToolSummary(tool, summary))
				: buildProgressCard(`步骤 ${event.step ?? 1} · ${phaseLabelForTool(tool)}`, "当前操作已完成。");
		}
		default:
			return null;
	}
}

function buildProgressCard(title: string, summary: string): string {
	return `\n\n[${title}]\n${summary}\n`;
}

function compactProgressText(text: string, maxLength: number): string {
	const normalized = text
		.replace(/\s+/g, " ")
		.replace(/\s*:\s*/g, ": ")
		.trim();

	const firstSentence = normalized.match(/.*?[.!?](\s|$)/)?.[0]?.trim() ?? normalized;
	const preferred = firstSentence.length >= 24 ? firstSentence : normalized;
	return truncateToolResultContent(preferred).slice(0, maxLength).trim();
}

function phaseLabelForTool(tool: string): string {
	switch (tool) {
		case "web_search":
			return "检索中";
		case "url_fetch":
		case "read_file":
			return "取证中";
		case "write_file":
			return "写作中";
		default:
			return "处理中";
	}
}

function inferExecutorPhaseLabel(instruction: string): string {
	const normalized = instruction.replace(/\s+/g, " ").trim();
	if (/search the web|web searches?|web_search/i.test(normalized)) {
		return "检索中";
	}
	if (/read the artifact|read_file|runtime\/command-results|extract/i.test(normalized)) {
		return "取证中";
	}
	if (/write|report|summary|markdown|final/i.test(normalized)) {
		return "写作中";
	}
	return "执行中";
}

function inferExecutionSummaryPhaseLabel(summary: string): string {
	const normalized = summary.trim();
	if (/Found \d+ results/i.test(normalized)) {
		return "筛选中";
	}
	if (/Fetch failed/i.test(normalized) || /Read file/i.test(normalized)) {
		return "取证中";
	}
	if (/Wrote file/i.test(normalized)) {
		return "写作中";
	}
	if (/Collected \d+ useful artifacts/i.test(normalized)) {
		return "归纳中";
	}
	return "执行中";
}

function humanizePlannerSummary(summary: string): string {
	const normalized = summary.replace(/\s+/g, " ").trim();
	if (/search|web|benchmark|evidence|comparison/i.test(normalized)) {
		return "正在确定检索重点，并准备补齐关键对比证据。";
	}
	if (/consolidate|summarize|final/i.test(normalized)) {
		return "正在收拢已有信息，准备形成阶段性结论。";
	}
	if (/fetch|read|artifact|extract/i.test(normalized)) {
		return "正在检查现有资料，并决定下一步证据路径。";
	}
	return compactProgressText(normalized, 120);
}

function humanizeExecutorInstruction(instruction: string): string {
	const normalized = instruction.replace(/\s+/g, " ").trim();
	if (/search the web|web searches?|web_search/i.test(normalized)) {
		return "正在检索支撑资料和基准对比信息。";
	}
	if (/read the artifact|read_file|runtime\/command-results|extract/i.test(normalized)) {
		return "正在读取已收集资料，并提取可用证据。";
	}
	if (/write|report|summary|markdown|final/i.test(normalized)) {
		return "正在整理已有发现，准备输出总结。";
	}
	return compactProgressText(normalized, 120);
}

function humanizeExecutionSummary(summary: string): string {
	const normalized = summary.trim();
	if (/Found \d+ results/i.test(normalized)) {
		const count = normalized.match(/Found (\d+) results/i)?.[1] ?? "多条";
		return `已收集 ${count} 条候选资料，正在筛选高质量证据。`;
	}
	if (/Fetch failed/i.test(normalized)) {
		return "部分页面暂时无法访问，正在调整证据路径。";
	}
	if (/Collected \d+ useful artifacts/i.test(normalized)) {
		const count = normalized.match(/Collected (\d+) useful artifacts/i)?.[1] ?? "多份";
		return `已沉淀 ${count} 份有效资料，准备进入归纳阶段。`;
	}
	if (/Read file/i.test(normalized)) {
		return "已读取一份已保存资料，并提炼关键细节。";
	}
	if (/Search queries returned irrelevant results/i.test(normalized)) {
		return "本轮检索结果相关性不足，正在调整关键词和证据路径。";
	}
	if (/Fetched\s+(\S+)/i.test(normalized)) {
		return "已读取目标页面，正在提取其中的关键信息。";
	}
	if (/Wrote file\s+(.+)/i.test(normalized)) {
		const target = normalized.match(/Wrote file\s+(.+)/i)?.[1]?.trim() ?? "";
		const fileName = target.split(/[\\/]/).pop() || target;
		return target ? `报告已保存到本地文件：${fileName}` : "报告已保存到本地文件。";
	}
	return compactProgressText(normalized, 120);
}

function humanizeToolStart(tool: string): string {
	switch (tool) {
		case "web_search":
			return "正在搜索候选资料来源。";
		case "url_fetch":
			return "正在打开页面，提取更具体的证据。";
		case "read_file":
			return "正在读取已保存的过程资料。";
		default:
			return `正在执行 ${tool}。`;
	}
}

function humanizeToolSummary(tool: string, summary: string): string {
	const normalized = summary.trim();
	if (tool === "web_search") {
		const count = normalized.match(/Found (\d+) results/i)?.[1];
		if (count) {
			return `已找到 ${count} 条候选结果，正在筛选可信来源。`;
		}
		if (/returned no parsed results/i.test(normalized)) {
			return "这次搜索还没有拿到可用结果，正在尝试调整关键词。";
		}
	}

	if (tool === "url_fetch") {
		if (/Fetched\s+(\S+)/i.test(normalized)) {
			const url = normalized.match(/Fetched\s+(\S+)/i)?.[1] ?? "source";
			return `已抓取页面内容：${url}。`;
		}
		if (/Fetch failed/i.test(normalized)) {
			return "目标页面暂时无法读取，正在尝试其他来源。";
		}
	}

	if (tool === "read_file" && /Read file/i.test(normalized)) {
		return "已载入保存的过程资料，正在深入分析。";
	}

	return compactProgressText(normalized, 120);
}

export type ProgressAggregationState = {
	tool: string;
	step?: number;
	startCount: number;
	resultCount: number;
	successCount: number;
	failureCount: number;
	candidateResults: number;
	summaries: string[];
};

export function shouldAggregateToolProgress(tool: string): boolean {
	return tool === "web_search" || tool === "url_fetch" || tool === "read_file";
}

export function createProgressAggregationState(tool: string, step?: number): ProgressAggregationState {
	return {
		tool,
		step,
		startCount: 0,
		resultCount: 0,
		successCount: 0,
		failureCount: 0,
		candidateResults: 0,
		summaries: [],
	};
}

export function buildAggregatedToolStart(tool: string): string {
	switch (tool) {
		case "web_search":
			return buildProgressCard("检索中", "正在扩展检索范围，补充更多候选资料。");
		case "url_fetch":
			return buildProgressCard("取证中", "正在打开候选页面，提取关键证据。");
		case "read_file":
			return buildProgressCard("取证中", "正在读取已保存资料，补充现有证据。");
		default:
			return buildProgressCard(phaseLabelForTool(tool), humanizeToolStart(tool));
	}
}

export function buildAggregatedToolResult(state: ProgressAggregationState): string | null {
	if (state.resultCount === 0) {
		return null;
	}

	if (state.tool === "web_search") {
		if (state.resultCount <= 1) {
			const summary = state.summaries.at(-1);
			return summary ? buildProgressCard("检索中", summary) : null;
		}
		const total = state.candidateResults > 0 ? `累计找到 ${state.candidateResults} 条候选结果` : "已补充多轮候选结果";
		return buildProgressCard("检索中", `已完成 ${state.resultCount} 轮搜索，${total}，正在筛选可信来源。`);
	}

	if (state.tool === "url_fetch") {
		if (state.resultCount <= 1) {
			const summary = state.summaries.at(-1);
			return summary ? buildProgressCard("取证中", summary) : null;
		}
		if (state.failureCount > 0 && state.successCount > 0) {
			return buildProgressCard("取证中", `已读取 ${state.successCount} 个页面，另有 ${state.failureCount} 个页面暂时无法访问，正在切换其他来源。`);
		}
		if (state.failureCount > 0) {
			return buildProgressCard("取证中", `连续 ${state.failureCount} 个页面暂时无法读取，正在调整证据来源。`);
		}
		return buildProgressCard("取证中", `已读取 ${state.successCount} 个页面，正在整理其中的关键证据。`);
	}

	if (state.tool === "read_file") {
		if (state.resultCount <= 1) {
			const summary = state.summaries.at(-1);
			return summary ? buildProgressCard("取证中", summary) : null;
		}
		return buildProgressCard("取证中", `已读取 ${state.resultCount} 份过程资料，正在提炼其中的关键信息。`);
	}

	const summary = state.summaries.at(-1);
	return summary ? buildProgressCard(phaseLabelForTool(state.tool), summary) : null;
}

export function accumulateToolProgressResult(state: ProgressAggregationState, event: OrchestratorEvent): void {
	const ok = event.data.ok === true;
	const summary = typeof event.data.summary === "string" ? event.data.summary.trim() : "";
	state.resultCount += 1;
	state.successCount += ok ? 1 : 0;
	state.failureCount += ok ? 0 : 1;

	if (summary) {
		state.summaries.push(humanizeToolSummary(state.tool, summary));
		if (state.tool === "web_search") {
			const count = summary.match(/Found (\d+) results/i)?.[1];
			if (count) {
				state.candidateResults += Number(count);
			}
		}
	}
}
