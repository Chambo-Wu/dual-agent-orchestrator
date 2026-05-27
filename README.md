# Dual Agent Orchestrator

Dual Agent Orchestrator is a generic `planner + executor` runtime for multi-model task execution. It exposes:

- OpenAI-compatible chat APIs
- Anthropic-style `messages` APIs
- a job-oriented control plane for long-running work
- realtime workflow progress streams for frontend clients

Chinese documentation: [Readme-CN.md](./Readme-CN.md)

Additional project planning docs:

- [路线图-分阶段持续推进与实施清单-20260526.md](./docs/路线图-分阶段持续推进与实施清单-20260526.md)

- [Frontend Recovery Status And CTA Contract](./docs/%E5%89%8D%E7%AB%AF%E6%81%A2%E5%A4%8D%E7%8A%B6%E6%80%81%E4%B8%8ECTA%E5%AF%B9%E6%8E%A5-20260527.md)

## Overview

The system is built around two model roles:

- `planner`: a stronger model that understands the goal, breaks work into steps, audits progress, decides retries, and produces final answers
- `executor`: a cheaper or more local model that performs deterministic tool work such as reading files, writing files, searching, and fetching URLs

The current implementation supports both:

- direct chat-style use through `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`
- first-class task jobs through `/v1/jobs`

## Terminology

Use these terms consistently across the runtime, API, UI, and planning docs:

- `job`: the top-level execution record managed through `/v1/jobs`
- `workflow`: a structured execution plan attached to a job; may be replaced by runtime `replan`
- `task`: a node inside a workflow plan, such as `write`, `search`, `fetch`, `verify`, or `synthesize`
- `task run`: the persisted runtime record for a task execution inside a job
- `step`: a planner/executor iteration or an event-level progression marker; not the same thing as a `task`
- `artifact`: a concrete output produced by tools or task execution and persisted for later verification or consumption
- `verifier`: the system-first verification layer that checks whether outputs are real, valid, and sufficient
- `retry`: rerun the same job or task intent again
- `resume`: continue from an interrupted or blocked job through the control plane
- `replan`: replace or adjust the active workflow after failure or new information
- `replay`: re-read persisted events from `/events` or `/stream` using `since_seq` or `Last-Event-ID`

## Current Status

This is no longer just a CLI skeleton. The current codebase includes:

- async job creation with persistent job records
- planner/executor iteration history, task runs, and artifacts
- realtime workflow event streaming over SSE
- HTML timeline rendering for jobs
- workflow-plan parsing, validation, and runtime execution
- explicit workflow DAG summaries with active and superseded lanes
- runtime workflow replan history preserved in job responses
- dependency-graph visualization in the built-in timeline UI
- replan-to-graph focus interactions in the timeline UI
- Cherry Studio-friendly progress mirroring inside standard chat streams
- protocol compatibility guards for OpenAI-style and Anthropic-style clients
- stronger file-write validation so the system cannot claim a report was saved unless `write_file` actually succeeded

Milestone note:

- Milestone C is now effectively closed at the runtime and UI-contract level
- the next phase is mainly Milestone D polish, richer workflow UX, and deeper observability

## Architecture

- `src/orchestrator.ts`: planner/executor loop, protocol correction, evidence checks, file-write validation
- `src/tools.ts`: native tools and search/fetch/file execution
- `src/index.ts`: HTTP API server, chat adapters, job control plane, workflow progress mirroring
- `src/workflow-ui-events.ts`: normalized frontend event schema
- `src/job-event-bus.ts`: persisted event bus for job streams
- `src/timeline.ts`: HTML timeline rendering
- `src/workflow-plan.ts`: workflow plan schema parsing and validation
- `src/workflow-runtime.ts`: workflow runtime execution and replan flow
- `src/workflow-graph.ts`: DAG and replan-history view-model generation
- `runtime/jobs/`: persisted job records
- `runtime/logs/`: per-run JSONL logs
- `runtime/command-results/`: tool artifacts

## Supported Tools

- `read_file`
- `write_file`
- `list_files`
- `shell_command`
- `web_search`
- `url_fetch`
- `git_command`
- `http_request`
- `extract_text`
- `parse_json`
- `parse_csv`
- `summarize_artifact`

Notes:

- file paths are resolved relative to the workspace root
- tool artifacts are persisted under `runtime/command-results/`
- `shell_command` prefers PowerShell on Windows and falls back to `cmd.exe`
- `Invoke-WebRequest` and `Invoke-RestMethod` are normalized to reduce interactive behavior

## Configuration

Use `config/example.config.yml` as a template, then copy it to `config/config.yml`.

Edit `config/config.yml`:

```yml
planner:
  base_url: "http://127.0.0.1:8790/v1"
  api_key: "env:PLANNER_API_KEY"
  model: "glm5"

executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "env:EXECUTOR_API_KEY"
  model: "qwen/qwen3-4b-2507"

policy:
  auto_resume_concurrency: 3
```

Put secrets in `.env`:

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
```

## Install And Run

```powershell
npm install
npm run build
npm run config:validate
```

Notes:

- the runtime loads `config/config.yml` by default
- `config/example.config.yml` is only a sample template and is not loaded automatically
- `npm run config:validate` and `npm run doctor` also validate `config/config.yml` unless you pass a custom path

Run a one-off CLI task:

```powershell
node --enable-source-maps dist/index.js "Write a markdown file named notes/todo.md with three deployment tasks."
```

Start the local API service:

```powershell
npm run serve
```

Default service URL:

- `http://127.0.0.1:9898`

Quick health/config self-check:

```powershell
npm run doctor
```

`npm run doctor` now returns a structured runtime diagnostics report, including:

- config load status
- planner/executor model readiness
- task routing load status
- task routing summary
- runtime profile snapshot
- proxy health
- workspace/runtime writable checks
- search provider readiness
- actionable recommendations grouped by failure category
- a top-level passed/failed summary with generation timestamp

## API Surface

Auth:

- `Authorization: Bearer <api_key>` or `X-API-Key`
- default local key: `dual-agent-local`
- override with `DUAL_AGENT_API_KEY`

Standard endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

Job control plane:

- `GET /v1/jobs`
- `GET /v1/jobs/dashboard`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/steps`
- `GET /v1/jobs/:id/artifacts`
- `GET /v1/jobs/:id/runtime-profile`
- `GET /v1/jobs/:id/events`
- `GET /v1/jobs/:id/stream`
- `GET /v1/jobs/:id/timeline`
- `POST /v1/jobs/:id/cancel`
- `POST /v1/jobs/:id/retry`

Browser-friendly built-in pages:

- `GET /jobs/dashboard`
- `GET /jobs/data`
- `GET /jobs/:id`
- `GET /jobs/:id/events`
- `GET /jobs/:id/stream`
- `GET /jobs/:id/timeline`
- `POST /jobs/:id/resume`
- `POST /v1/jobs/:id/approve`
- `POST /v1/jobs/:id/resume`

## Streaming Modes

There are two different streaming experiences:

1. Standard model stream

- use `/v1/chat/completions`, `/v1/responses`, or `/v1/messages`
- stays protocol-compatible with normal OpenAI/Anthropic clients
- by default does not inject raw `workflow.*` SSE events
- can mirror planner/executor progress into normal text deltas for clients like Cherry Studio

2. Workflow stream

- use `/v1/jobs/:id/stream`
- emits normalized workflow events for frontend UIs
- intended for dashboards, timelines, and multi-agent collaboration views
- supports SSE resume with `Last-Event-ID`
- supports replay from `since_seq`
- emits SSE `id:` fields on `job.event` entries

Replay contract:

- `GET /v1/jobs/:id/events?since_seq=N` returns events with `seq > N`
- `GET /v1/jobs/:id/stream?since_seq=N` replays events with `seq > N` before live subscription
- `GET /v1/jobs/:id/stream` with header `Last-Event-ID: N` resumes from `seq > N`
- `job.snapshot` includes `replay.next_seq`, `replay.can_resume_from`, `replay.resumed_from_seq`, and `replay.replayed_count`
- recovery-aware `job.snapshot` payloads also include `follow`, `actions`, and `recovery.auto_resume_status`

You can explicitly opt into raw workflow SSE events on compatible routes with:

- `include_workflow_events: true`
- or header `x-dual-agent-workflow-events: true`

## Async Jobs

`POST /v1/jobs` supports async task creation for frontend clients.

Typical behavior:

- `policy.async = true` returns `202`
- response includes `job_id`, `stream_url`, `events_url`, and `timeline_url`
- the job continues in the background
- clients can subscribe to `/v1/jobs/:id/stream` for live progress

## Frontend Progress UX

The current progress system is designed for both custom frontends and generic clients:

- normalized workflow UI events for `/v1/jobs/:id/events` and `/stream`
- stage-style progress states such as `planning`, `research`, `evidence`, `filtering`, `synthesis`, and `writing`
- aggregated tool summaries so repeated `web_search` or `url_fetch` calls do not flood the UI
- card-style text progress in standard chat streams
- built-in DAG lanes that now render real dependency graphs instead of simple task lists
- superseded workflow lanes and replan history focus interactions inside `/v1/jobs/:id/timeline`
- a built-in runtime analysis panel for verification outcomes, artifact activity, tool activity, and common blockers
- click-to-filter analysis chips that can jump from summary statistics to matching events and related workflow lanes
- shareable timeline URLs that preserve `workflowFocus`, `analysisFilter`, and `analysisValue`
- recovery-aware frontend signals such as `job.redirect`, `snapshot.follow`, `snapshot.actions`, and `snapshot.recovery`

Example mirrored progress in chat streams:

```text
[Step 2 · Research]
Completed 3 search rounds, gathered 30 candidate results, and is filtering trustworthy sources.

[Step 3 · Evidence]
Read 5 saved artifacts and is extracting the key details.
```

## Report/File Output Validation

The runtime now guards against false completion for local deliverables.

If the task says things like:

- "write a markdown report to local"
- "save `report.md`"
- "write `D:\...\report.md`"

then a planner `final` answer is no longer enough. The run only completes if:

- the executor actually performs `write_file`
- and the write target matches the requested output path

This closes the earlier bug where the final answer said a report had been saved even when no file existed on disk.

## Logs And Persistence

Each run produces:

- JSONL trace logs under `runtime/logs/`
- persisted job records under `runtime/jobs/`
- tool artifacts under `runtime/command-results/`

Logs include:

- planner requests and parsed decisions
- executor requests and parsed results
- native tool call start/finish events
- protocol-correction and loop-detection events

## Tests

```powershell
npm run test
```

Targeted suites:

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e-lite
```

## Current Limitations

- team-mode control plane is not finished yet; `/v1/jobs` currently supports `mode: "task"`
- the planner still depends on upstream model reliability
- web search quality depends heavily on provider quality and query quality
- some web pages remain JS-rendered or blocked by `403/401/429`, so degraded evidence synthesis is sometimes necessary
- generic chat clients may still render text progress differently depending on how they treat streamed newlines

## Suggested Client Patterns

For generic clients:

- use `/v1/chat/completions`
- enable `stream: true`
- rely on mirrored text progress

For custom apps:

- create a job with `POST /v1/jobs`
- subscribe to `/v1/jobs/:id/stream`
- fetch `/v1/jobs/:id/events` for replay or refresh
- store the last seen SSE `id` and reconnect with `Last-Event-ID`
- open `/v1/jobs/:id/timeline` for a built-in visualization

## Acknowledgments

- [Linux.do](https://linux.do/)
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/)
