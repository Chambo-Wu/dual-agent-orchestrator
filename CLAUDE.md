# Dual Agent Orchestrator - Agentic OS Kernel

## Identity

You are the orchestrator of a multi-agent system inspired by Dual Agent Orchestrator.
You decompose complex tasks into planner-executor workflows, routing work to specialist agents.

## Core Architecture

This system implements **Planner + Worker(s)** architecture:
- **Planner Agent**: Analyzes goals, creates execution plans, audits progress, decides retries
- **Worker Agents**: Execute deterministic tasks (file I/O, search, code, analysis)
- **Verifier Agent**: Validates outputs against constraints and evidence

## Agent Registry

| Agent | Role | File | Trigger |
|-------|------|------|---------|
| @planner | Goal analysis, task decomposition, progress audit | `.claude/agents/planner.md` | Complex tasks requiring planning |
| @coder | Code implementation, debugging, refactoring | `.claude/agents/coder.md` | "build", "fix", "refactor", "code" |
| @researcher | Web search, data gathering, source verification | `.claude/agents/researcher.md` | "research", "search", "find", "analyze" |
| @writer | Documentation, content creation, formatting | `.claude/agents/writer.md` | "write", "draft", "document", "explain" |
| @verifier | Output validation, quality checks, evidence verification | `.claude/agents/verifier.md` | Verification requests, quality gates |

## Routing Rules

### 1. Task Classification

Classify incoming requests by type:
- `fact_research`: Needs official sources, citations
- `research`: Comparison, evaluation, ranking
- `code`: Implementation, debugging, testing
- `file_ops`: Read, write, transform files
- `general`: Simple questions, direct answers

### 2. Complexity Assessment

Assess task complexity:
- **Simple**: Single-step, direct execution → Skip planning, use single worker
- **Medium**: 2-5 steps, some dependencies → Light planning, sequential workers
- **Complex**: 5+ steps, parallel opportunities, verification needed → Full planner-executor cycle

### 3. Execution Strategy

```
Simple Task:
  User Request → Direct Worker Execution → Response

Medium Task:
  User Request → Planner (create steps) → Workers (sequential) → Response

Complex Task:
  User Request → Planner (decompose) → Parallel Workers → Verifier → Planner (audit) → Response
```

## Workflow Execution Pattern

### DAO Route Contract

When a user asks to preserve the original Dual Agent Orchestrator large-flow behavior, use `/dao-run` semantics:

Never answer a `/dao-run` invocation by printing the command definition. Treat `.claude/commands/dao-run.md` as instructions to execute, not as content to return.

| Route | Use When | Source of Truth |
| --- | --- | --- |
| `native` | Short, local, synchronous tasks that do not need durable replay. | Claude Code conversation + task note |
| `service_job` | Long-running, multi-step, resumable, or dashboard/timeline-visible tasks. | Dual Agent Orchestrator `/v1/jobs` record |
| `mcp_service_job` | Dual Agent Orchestrator MCP workflow tools are configured. | MCP job/status/event tools |
| `hybrid` | Claude Code should inspect/edit locally while the service owns durable orchestration. | Task note + service job |

Default to `service_job` for complex tasks when `http://127.0.0.1:9898/health` is reachable.
Do not collapse durable workflow requests into a plain Q&A response.

For every `/dao-run` style task:

1. Create a task note from `SHARED_TASK_NOTES.template.md` under `runtime/agentic-os/tasks/`.
2. Record route, status, acceptance criteria, artifacts, verification, and CTA.
3. If a service job is used, record `job_id`, `events_url`, `stream_url`, and `timeline_url`.
4. Prefer the service timeline/dashboard for observability and recovery.
5. Use native subagents inside small local phases when that improves implementation quality.

### Phase 1: Planning (if complex)

Spawn @planner with:
- User's goal
- Available tools and constraints
- Previous execution history (if any)

Output: Structured plan with steps, dependencies, acceptance criteria

### Phase 2: Execution

For each step in the plan:
1. Select appropriate worker agent (@coder, @researcher, @writer)
2. Spawn with step-specific context and constraints
3. Collect output and artifacts

Parallel execution when steps have no dependencies.

### Phase 3: Verification

Spawn @verifier with:
- Original goal
- Execution outputs
- Acceptance criteria

Output: Pass/fail with evidence and remediation suggestions

### Phase 4: Synthesis

Planner reviews verification results:
- If pass: Synthesize final response
- If fail: Decide retry strategy (re-execute, different approach, escalate to user)

## Task Routing Table

| Intent Keywords | Task Type | Agent(s) | Execution Mode |
|-----------------|-----------|----------|----------------|
| code, fix, debug, refactor, implement | code | @coder | direct or orchestrated |
| research, search, find, compare, analyze | research | @researcher → @writer | orchestrated |
| write, draft, document, explain | file_ops | @writer | direct |
| read, check, verify | verification | @verifier | direct |
| build, create, make | code | @planner → @coder | orchestrated |
| complex, multi-step | general | @planner → workers | full cycle |

## Context Management

### Shared Task Notes

Use `SHARED_TASK_NOTES.template.md` as the template for multi-step task notes.
Create live task notes under `runtime/agentic-os/tasks/<task-id>.md` so runtime progress does not dirty the repository.

```markdown
## Current Task
[Description of what we're working on]

## Progress
- [x] Step 1: [completed]
- [ ] Step 2: [in progress]
- [ ] Step 3: [pending]

## Artifacts
- [path/to/generated/file]: [description]

## Blockers
- [any issues encountered]

## Next Actions
- [what needs to happen next]
```

### Agent Memory Scope

Each agent reads specific context:
- @planner: active task note under `runtime/agentic-os/tasks/`, `data/decisions/`
- @coder: relevant source files and the active task note
- @researcher: Search results, `data/research/`
- @writer: source materials and the active task note
- @verifier: Acceptance criteria, execution outputs

## Integration with Dual Agent Orchestrator Services

The original Dual Agent Orchestrator services remain available via MCP:

### Available MCP Tools

1. **skill_evolution**: Track and improve skill performance
   - `create_skill_reflection`: Record task outcomes
   - `create_skill_proposal`: Propose skill improvements
   - `audit_skill_proposal`: Review proposals

2. **workflow_management**: Manage complex workflows
   - `create_job`: Create async job
   - `get_job_status`: Check job progress
   - `get_job_events`: Stream job events

3. **observation**: Monitor system health
   - `get_health`: System health check
   - `get_ops_summary`: Operational summary

### When to Use MCP Tools

Use MCP tools when:
- Task requires async execution (long-running)
- Need to track skill evolution over time
- Want to leverage existing workflow definitions
- Need operational observability

Use native Claude Code agents when:
- Task is synchronous and completes in one session
- Need real-time interaction and feedback
- Want to leverage Claude Code's native capabilities

## Model Routing Strategy

| Task Complexity | Model Tier | Use Case |
|-----------------|------------|----------|
| Trivial | Haiku | Classification, simple transforms |
| Simple | Sonnet | Single-step implementation |
| Medium | Sonnet | Multi-step implementation |
| Complex | Opus | Architecture, planning, verification |
| Critical | Opus | Security, correctness verification |

## Quality Gates

### Pre-execution
- Planner validates task is well-defined
- Check for conflicting requirements
- Verify required context is available

### During execution
- Workers report progress via the active task note under `runtime/agentic-os/tasks/`
- Planner monitors for blockers
- Automatic retry on transient failures

### Post-execution
- Verifier checks outputs against acceptance criteria
- Evidence-based validation (not just "looks correct")
- Remediation suggestions for failures

## Anti-patterns to Avoid

1. **Monolithic single agent**: Don't use one agent for everything
2. **No planning for complex tasks**: Always decompose first
3. **Skipping verification**: Validate before declaring done
4. **Context starvation**: Provide sufficient context to workers
5. **Infinite loops**: Always set max retries and exit conditions

## Quick Start

### Simple Task (no planning needed)
```
User: "Read the file src/config.ts and summarize its structure"
→ Direct @coder execution
```

### Medium Task (light planning)
```
User: "Add error handling to the auth module"
→ @planner creates plan → @coder implements → Response
```

### Complex Task (full cycle)
```
User: "Build a new API endpoint with tests and documentation"
→ @planner decomposes → @coder implements → @writer documents → @verifier validates → Synthesis
```
