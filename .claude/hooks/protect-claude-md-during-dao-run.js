/**
 * PreToolUse hook: Protect CLAUDE.md from being overwritten during dao-run/dao-exec execution.
 *
 * Context: When dao-run CLI fails silently (service down), the model may try to "help" by doing
 * the task natively and accidentally overwrite CLAUDE.md (the kernel instruction file) with task
 * output. This hook blocks any Write/Edit to CLAUDE.md when a dao-run command is in flight.
 *
 * Trigger: PreToolUse (before every tool call)
 * Effect: Blocks Write/Edit/NotebookEdit targeting CLAUDE.md during dao-run/dao-exec
 */

export default function protectClaudeMdDuringDaoRun({ tool, conversation }) {
  // Only intercept file-write tools
  const writeTools = ['Write', 'Edit', 'NotebookEdit'];
  if (!writeTools.includes(tool.name)) {
    return { allow: true };
  }

  // Check if we're in a dao-run/dao-exec command invocation
  const lastUserMessage = conversation
    .slice()
    .reverse()
    .find(msg => msg.role === 'user');

  if (!lastUserMessage) {
    return { allow: true };
  }

  const content = lastUserMessage.content || '';
  const isDaoRunInvocation =
    content.includes('<command-name>/dao-run</command-name>') ||
    content.includes('<command-name>/dao-exec</command-name>') ||
    content.includes('command-name>dao-run<') ||
    content.includes('command-name>dao-exec<');

  if (!isDaoRunInvocation) {
    return { allow: true };
  }

  // We're in a dao-run context. Block any write to CLAUDE.md
  const filePath = tool.parameters?.file_path || '';
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

  if (normalizedPath.endsWith('claude.md') || normalizedPath.includes('/claude.md')) {
    return {
      allow: false,
      reason: 'CLAUDE.md is a kernel instruction file and cannot be edited during dao-run/dao-exec. ' +
              'If dao-run failed, check service health (npm run serve:restart:9898) and re-run the command. ' +
              'Do not write task results into CLAUDE.md — use runtime/agentic-os/tasks/ for task notes.'
    };
  }

  return { allow: true };
}
