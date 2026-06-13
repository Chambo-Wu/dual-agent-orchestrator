---
description: Execute a task through Dual Agent Orchestrator routing with task note and CTA.
argument-hint: <task>
---

# DAO Exec

Do not print this command file. Execute `$ARGUMENTS`.

Task:

```text
$ARGUMENTS
```

## Steps

1. Create a task note under `runtime/agentic-os/tasks/<yyyyMMdd-HHmmss>-<slug>.md` from `SHARED_TASK_NOTES.template.md`.
2. Check whether `http://127.0.0.1:9898/health` is reachable.
3. If reachable and the task needs durable job/timeline/recovery, create a service job.
4. If not reachable, use native execution and record `service_unavailable`.
5. Do the work. For research, gather current sources and cite them.
6. Update the task note.
7. End with `DAO Run Summary`.

## Service Job

Use this payload by default:

```json
{
  "goal": "$ARGUMENTS",
  "mode": "task",
  "policy": {
    "async": true
  }
}
```

Use `mode: "team"` only when the user explicitly asks for team-mode execution or the task clearly requires service-side team subtasks.

Request:

```text
POST http://127.0.0.1:9898/v1/jobs
Authorization: Bearer dual-agent-local
Content-Type: application/json
```

Record returned `job_id`, `events_url`, `stream_url`, and `timeline_url`.

If the service returns a workflow-plan validation error, do not keep retrying blindly. Record the error in the task note and fall back to native execution for the current user answer.

## Final Output

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
