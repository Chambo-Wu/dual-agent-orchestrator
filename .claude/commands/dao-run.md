---
description: Run a task through Dual Agent Orchestrator routing instead of answering as plain Q&A.
argument-hint: <task>
---

# DAO Run

Do not print or summarize this command file.
Execute the user task in `$ARGUMENTS` through the route contract below.

User task:

```text
$ARGUMENTS
```

## Required Behavior

1. Treat this as an execution request, not a documentation request.
2. Create or update a task note under `runtime/agentic-os/tasks/<yyyyMMdd-HHmmss>-<slug>.md` from `SHARED_TASK_NOTES.template.md`.
3. Choose exactly one route:
   - `service_job`: default for complex, long-running, research-heavy, resumable, or timeline-worthy tasks when `http://127.0.0.1:9898/health` is reachable.
   - `mcp_service_job`: use only when Dual Agent Orchestrator MCP job tools are actually configured.
   - `hybrid`: use when Claude Code should inspect/edit locally while the service owns durable orchestration.
   - `native`: use only for short local synchronous work or when service/MCP is unavailable.
4. Do not collapse durable workflow requests into a plain Q&A answer.
5. Always end with the DAO Run Summary format below.

## Service Job Procedure

If route is `service_job`:

1. Check `GET http://127.0.0.1:9898/health`.
2. Create a job:

```json
{
  "goal": "$ARGUMENTS",
  "mode": "task",
  "policy": {
    "async": true
  }
}
```

Use:

```text
POST http://127.0.0.1:9898/v1/jobs
Authorization: Bearer dual-agent-local
Content-Type: application/json
```

3. Record returned `job_id`, `events_url`, `stream_url`, and `timeline_url` in the task note.
4. Convert relative URLs to absolute URLs with `http://127.0.0.1:9898`.
5. Use the timeline URL as the primary CTA.
6. If the service is unavailable, record `service_unavailable`, select `native` only if the task remains safe to complete, and tell the user durability/timeline/recovery were unavailable.

Use `mode: "team"` only when the user explicitly asks for team-mode execution or the task clearly requires service-side team subtasks.
If the service returns a workflow-plan validation error, record it and fall back to native execution for the current user answer instead of retrying blindly.

## Native Procedure

If route is `native`:

1. Make a compact plan.
2. Use specialist agents conceptually: planner for decomposition, researcher for evidence, coder/writer for artifacts, verifier for checks.
3. For external/current research, use web search and cite sources.
4. Update the task note with route, progress, artifacts, verification, and CTA.

## Task Note Minimum Fields

The task note must include:

- route
- status
- service_base_url
- job_id, events_url, stream_url, timeline_url when available
- acceptance criteria
- progress
- artifacts
- verification
- blockers
- CTA

## Final Output

End every run with:

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
