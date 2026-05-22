export function buildDecompositionPrompt(goal: string, agents: string[]): string {
  return `You are a task coordinator. Your job is to decompose the following goal into concrete, executable tasks.

Goal: ${goal}

Available agents: ${agents.length > 0 ? agents.join(", ") : "(any)"}

Rules:
- Break the goal into 2-6 independent or dependent tasks.
- Each task must have a clear title and description.
- If tasks have dependencies, specify them via "dependsOn" (use task titles).
- Assign each task to an agent if appropriate, or leave unassigned for auto-assignment.
- Prefer parallel execution: independent tasks should NOT depend on each other.
- Every task title must be unique.
- "assignee" must be one of the available agent names when provided.
- "memoryScope" may be "dependencies" or "all"; omit it unless needed.
- "maxRetries", "retryDelayMs", and "retryBackoff" must be non-negative integers when provided.

Return a JSON array inside a fenced code block (\`\`\`json ... \`\`\`):

\`\`\`json
[
  {
    "title": "Task title",
    "description": "What to do",
    "assignee": "agent_name or omit for auto-assign",
    "dependsOn": ["other task title or omit if independent"],
    "memoryScope": "dependencies"
  }
]
\`\`\`

Return ONLY the JSON array. No other text outside the code block.`;
}

export function buildSynthesisPrompt(goal: string, taskResults: string, memorySummary?: string): string {
  return `You are a coordinator synthesizing the results of a multi-task execution.

Original goal: ${goal}

Task results:
${taskResults}

${memorySummary ? `Shared memory:\n${memorySummary}\n` : ""}
Rules:
- Combine all task results into a single coherent answer.
- If any tasks failed, acknowledge the failures and provide what you can.
- Be concise but complete.
- Cite which task produced which part of the answer when relevant.

Return your final synthesized answer as plain text.`;
}

export function buildTaskPrompt(title: string, description: string, dependencyContext?: string): string {
  let prompt = `# Task: ${title}\n\n${description}`;
  if (dependencyContext) {
    prompt += `\n\n## Context from prerequisite tasks\n${dependencyContext}`;
  }
  return prompt;
}
