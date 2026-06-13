# /dao-run

Run a user task through the Dual Agent Orchestrator route contract.

## Usage

```text
/dao-run <task>
```

## Intent

Use this command when the user wants the original Dual Agent Orchestrator style of work:

- keep the larger route visible
- decompose work before execution
- use planner + worker/workers inside each small flow
- persist progress in a task note
- use the service job control plane when durability, replay, timeline, recovery, or dashboard visibility matters

## Route Decision

Classify the request before execution:

| Route | Use When | Execution Surface |
| --- | --- | --- |
| `native` | The task is short, local, synchronous, and does not need durable replay. | Claude Code subagents from `.claude/agents/` |
| `service_job` | The task is long-running, multi-step, needs recovery, needs dashboard/timeline visibility, or should survive CLI interruption. | Dual Agent Orchestrator HTTP `/v1/jobs` |
| `mcp_service_job` | MCP tools for Dual Agent Orchestrator are configured and expose job operations. | MCP workflow tools |
| `hybrid` | Claude Code should inspect or edit local files, while the service owns durable orchestration. | Claude Code subagents + `/v1/jobs` or MCP |

Default to `service_job` for complex tasks when the local service is reachable.
Fall back to `native` only when the service/MCP route is unavailable or the task is clearly small.

## Required Task Note

Before executing, create or update a task note using `SHARED_TASK_NOTES.template.md`:

```text
runtime/agentic-os/tasks/<yyyyMMdd-HHmmss>-<slug>.md
```

The task note must include:

- `route`: `native`, `service_job`, `mcp_service_job`, or `hybrid`
- `status`: `planned`, `running`, `blocked`, `verifying`, `completed`, or `failed`
- `job_id` and `timeline_url` when a service job is created
- acceptance criteria
- progress entries
- artifacts
- verification result
- next action / CTA

## Service Job Flow

When route is `service_job`:

1. Check service health at `http://127.0.0.1:9898/health` unless the user specified another URL.
2. Create a job with `POST /v1/jobs`.
3. Use the user's task as the job input.
4. Prefer async job mode when available.
5. Record `job_id`, `events_url`, `stream_url`, and `timeline_url` in the task note.
6. Tell the user the dashboard and timeline URLs.
7. Follow events when useful, but do not hide that the durable source of truth is the job record.
8. On failure or interruption, record the recovery CTA: open timeline, resume, retry, cancel, or inspect events.

Default local service:

```text
base_url: http://127.0.0.1:9898
dashboard: http://127.0.0.1:9898/jobs/dashboard
```

Default auth header for local development:

```text
Authorization: Bearer dual-agent-local
```

Create request shape:

```json
{
  "goal": "$ARGUMENTS",
  "mode": "team",
  "policy": {
    "async": true
  }
}
```

Use `mode: "task"` only when the work is clearly single-lane and does not benefit from team/subtask routing.

Expected async response fields:

```json
{
  "object": "job",
  "job_id": "job_...",
  "status": "running",
  "accepted": true,
  "stream_url": "/v1/jobs/job_.../stream",
  "events_url": "/v1/jobs/job_.../events",
  "timeline_url": "/v1/jobs/job_.../timeline"
}
```

After creation:

1. Convert relative response URLs to absolute URLs using the service base URL.
2. Store all URLs in the task note.
3. Poll `GET /v1/jobs/:id` for coarse status when SSE is not needed.
4. Use `GET /v1/jobs/:id/events` for replayable event history.
5. Use `GET /v1/jobs/:id/timeline` as the primary human-facing CTA.

If health check fails:

1. Record `route: native` or `route: hybrid` with degradation reason.
2. Record `service_unavailable` in `Blockers`.
3. Continue only if the task can be completed safely without durable job semantics.
4. Tell the user that dashboard/timeline/recovery were unavailable for this run.

## MCP Flow

When route is `mcp_service_job`:

1. Use the configured Dual Agent Orchestrator MCP workflow tools.
2. Create the job through MCP instead of raw HTTP.
3. Record MCP server/tool names in the task note.
4. Fetch job status/events through MCP.
5. Include the same CTA fields as the HTTP service job route.

If MCP is not configured, do not pretend it is available. Use `service_job` if the HTTP service is reachable.

## Native Flow

When route is `native`:

1. Ask `@planner` for a compact plan when there is more than one step.
2. Execute with `@coder`, `@researcher`, and/or `@writer`.
3. Verify with `@verifier` when code, files, or claims changed.
4. Update the task note after each phase.
5. Finish with a clear CTA and verification summary.

## Output Contract

Always end with:

```markdown
## DAO Run Summary

- **Route**: [native/service_job/mcp_service_job/hybrid]
- **Task Note**: `runtime/agentic-os/tasks/...md`
- **Job**: [job id or none]
- **Timeline**: [url or none]
- **Status**: [completed/running/blocked/failed]
- **Verification**: [what was checked]
- **CTA**: [open timeline / resume / retry / inspect / next command]
```

## User Task

$ARGUMENTS
