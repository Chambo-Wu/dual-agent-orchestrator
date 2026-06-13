# Shared Task Notes Template

Copy this template to `runtime/agentic-os/tasks/<task-id>.md` for multi-step tasks.
Do not write live task progress into this template.

## Contract

- `route`: `native` | `service_job` | `mcp_service_job` | `hybrid`
- `status`: `planned` | `running` | `blocked` | `verifying` | `completed` | `failed`
- `service_base_url`: optional, default `http://127.0.0.1:9898`
- `job_id`: required for `service_job` / `mcp_service_job` after job creation
- `timeline_url`: required when available
- `cta`: required before handing control back to the user

## Current Task
[Description of what we're working on]

## Route
- route: [native/service_job/mcp_service_job/hybrid]
- reason: [why this route was selected]
- service_base_url: [http://127.0.0.1:9898 or other]
- mcp_server: [server/tool names or none]

## Service Job
- job_id: [job id or none]
- job_url: [url or none]
- events_url: [url or none]
- stream_url: [url or none]
- timeline_url: [url or none]
- dashboard_url: [url or none]

## Status
- status: [planned/running/blocked/verifying/completed/failed]
- started_at: [ISO timestamp]
- updated_at: [ISO timestamp]

## Progress
- [ ] Step 1: [Pending]
- [ ] Step 2: [Pending]
- [ ] Step 3: [Pending]

## Acceptance Criteria
- [ ] [Measurable criterion 1]
- [ ] [Measurable criterion 2]

## Artifacts
- [path/to/file]: [description]

## Decisions
- [Decision 1]: [Rationale]

## Verification
- verdict: [not_run/pass/pass_with_warnings/fail]
- evidence:
  - [command/check]: [result]
- residual_risk:
  - [risk or none]

## Blockers
- [Any issues encountered]

## Next Actions
- [What needs to happen next]

## CTA
- action: [open_timeline/resume/retry/cancel/inspect_events/continue_native/none]
- label: [short user-facing instruction]
- url_or_command: [URL or command]
