# Dual Agent Orchestrator

Dual Agent Orchestrator is a local-first `planner + executor` runtime for multi-model task execution. It combines:

- OpenAI-compatible chat APIs
- Anthropic-style `messages` APIs
- a job-oriented control plane for long-running work
- realtime workflow streams for frontend clients
- built-in browser pages for job dashboards and timelines

Chinese documentation: [Readme-CN.md](./Readme-CN.md)

Additional project planning docs:

- [Roadmap And Implementation Checklist](./docs/%E8%B7%AF%E7%BA%BF%E5%9B%BE-%E5%88%86%E9%98%B6%E6%AE%B5%E6%8C%81%E7%BB%AD%E6%8E%A8%E8%BF%9B%E4%B8%8E%E5%AE%9E%E6%96%BD%E6%B8%85%E5%8D%95-20260526.md)
- [Frontend Recovery Status And CTA Contract](./docs/%E5%89%8D%E7%AB%AF%E6%81%A2%E5%A4%8D%E7%8A%B6%E6%80%81%E4%B8%8ECTA%E5%AF%B9%E6%8E%A5-20260527.md)

## Overview

The runtime is built around two model roles:

- `planner`: the stronger model that understands the goal, breaks work into steps, audits progress, decides retries, and produces final answers
- `executor`: the cheaper or more local model that performs deterministic tool work such as file I/O, shell commands, search, and URL fetching

By default, those roles are configured as one `planner` and one `executor`. The runtime now also supports a compatible multi-model extension:

- keep the legacy top-level `planner` and `executor` fields
- optionally register additional models under `models`
- optionally define candidate queues with `model_routing.planner_candidates` and `model_routing.executor_candidates`
- automatically normalize legacy config into `planner.default` and `executor.default`
- support both explicit probe diagnostics and runtime lazy executor admission

The current implementation supports both:

- direct chat-style use through `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`
- first-class jobs through `/v1/jobs`

## Current Status

This is now a working orchestration service rather than a CLI skeleton. The current codebase includes:

- OpenAI-compatible and Anthropic-style chat endpoints
- async job creation with persistent job records
- task-mode and team-mode job execution
- planner/executor iteration history, task runs, artifacts, and verification results
- realtime workflow event streaming over SSE
- workflow-plan parsing, validation, and runtime execution
- runtime DAG summaries with active and superseded workflow lanes
- workflow replan history preserved in job responses
- structured verification checks carried through job responses, events, and the timeline UI
- restart recovery with auto-resume, queue metadata, redirect/follow semantics, and CTA actions
- built-in browser dashboard and timeline pages
- Cherry Studio-friendly progress mirroring inside standard chat streams
- protocol compatibility guards for OpenAI-style and Anthropic-style clients
- file-write validation so the system cannot claim a report was saved unless `write_file` actually succeeded
- lazy multi-model executor warmup for retrieval-heavy steps, so the first real search/fetch request can double as candidate admission

## Terminology

Use these terms consistently across the runtime, API, UI, and planning docs:

- `job`: the top-level execution record managed through `/v1/jobs`
- `workflow`: a structured execution plan attached to a job; may be replaced by runtime `replan`
- `task`: a node inside a workflow plan, such as `write`, `search`, `fetch`, `verify`, or `synthesize`
- `task run`: the persisted runtime record for a task execution inside a job
- `step`: a planner/executor iteration or an event-level progression marker; not the same thing as a `task`
- `artifact`: a concrete output produced by tools or task execution and persisted for later verification or consumption
- `verifier`: the verification layer that checks whether outputs are real, valid, and sufficient
- `retry`: rerun the same job or task intent again
- `resume`: continue from an interrupted or blocked job through the control plane
- `replan`: replace or adjust the active workflow after failure or new information
- `replay`: re-read persisted events from `/events` or `/stream` using `since_seq` or `Last-Event-ID`

## Architecture

- `src/orchestrator.ts`: planner/executor loop, protocol correction, evidence checks, and file-write validation
- `src/tools.ts`: native tools plus search/fetch/file execution
- `src/index.ts`: HTTP API server, chat adapters, job control plane, and browser routes
- `src/workflow-ui-events.ts`: normalized frontend event schema
- `src/job-event-bus.ts`: persisted event bus for job streams
- `src/timeline.ts`: HTML timeline rendering
- `src/jobs-dashboard.ts`: browser dashboard rendering
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

Minimal example:

```yml
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "env:PLANNER_API_KEY"
  model: "GLM-5"

executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "env:EXECUTOR_API_KEY"
  model: "qwen/qwen3-4b-2507"

policy:
  auto_resume_concurrency: 3
  task_routing_path: "config/task-routing.yml"
```

Put secrets in `.env`:

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
SEARCH_API_KEY=optional-search-api-key
```

Notes:

- the runtime loads `config/config.yml` by default
- `config/example.config.yml` is a sample template and is not loaded automatically
- `npm run config:validate` and `npm run doctor` validate `config/config.yml` unless you pass a custom path

### Multi-model configuration

The recommended rollout path is:

1. Keep your existing `planner` and `executor` blocks unchanged.
2. Add optional extra models under `models`.
3. Add candidate queues under `model_routing`.

Example:

```yml
planner:
  base_url: "http://127.0.0.1:8080/v1"
  api_key: "env:PLANNER_API_KEY"
  model: "GLM-5"

executor:
  base_url: "http://127.0.0.1:1234/v1"
  api_key: "env:EXECUTOR_API_KEY"
  model: "qwen/qwen3-4b-2507"

models:
  planner_backup:
    role: "planner"
    base_url: "http://127.0.0.1:8081/v1"
    api_key: "env:PLANNER_API_KEY"
    model: "GLM-5-Air"
  executor_local:
    role: "executor"
    base_url: "http://127.0.0.1:1235/v1"
    api_key: "env:EXECUTOR_API_KEY"
    model: "qwen/qwen3-8b"
    enabled: true
  executor_remote:
    role: "executor"
    base_url: "https://example-gateway.invalid/v1"
    api_key: "env:EXECUTOR_REMOTE_API_KEY"
    model: "deepseek-chat"
    enabled: true

model_routing:
  planner_candidates: ["planner.default", "planner_backup"]
  executor_candidates: ["executor.default", "executor_local", "executor_remote"]
```

Compatibility rules:

- old configs with only top-level `planner` and `executor` still work
- legacy config is normalized into `planner.default` and `executor.default`
- runtime materialization still begins from the first routed executor candidate
- team-mode per-agent routing still works and remains a separate layer from the global executor candidate queue

### Health checks and candidate admission

In multi-model mode, executor admission now depends on the surface you are using.

- CLI `task` / `team` still run explicit lightweight executor probes before execution starts
- `GET /health` also runs explicit live probes and reports those results as diagnostics
- HTTP job execution (`POST /v1/jobs`) does not always spend a full preflight probe round anymore
- retrieval-heavy executor steps can lazily warm all executor candidates in parallel on the first real `web_search` / `url_fetch` step and keep only the candidates that actually respond correctly

Current behavior:

- only `executor` candidates are health-filtered today
- explicit probes use a minimal chat-completions request
- lazy runtime warmup uses the first real retrieval request as the admission signal
- healthy or successfully warmed candidates are kept in the execution queue
- unhealthy, disabled, malformed, or non-responsive candidates are excluded
- if every executor candidate fails under the active strategy, execution fails early

Failure contract when all executor candidates are unavailable:

- the run fails early with `NoHealthyExecutorError`
- job failure events include `failure_category: "environment_failure"`
- job failure events also include `healthy_executor_ids` and `executor_health_results`
- synchronous `POST /v1/jobs` failures currently return HTTP `500`

### What each diagnostic surface shows

Use the three surfaces differently:

- `npm run doctor`: config-oriented diagnostics, candidate queue visibility, writable checks, routing summary, and recommendations. It does not run live per-model probes.
- `GET /health`: explicit live probe diagnostics. This includes `executor.configured_candidates`, `executor.active_probe.*`, and a descriptive `executor.runtime_lazy_selection` block so callers do not confuse active probes with runtime lazy admission state. It returns `503` with `status: "degraded"` when the explicit probe finds no healthy executor.
- `GET /v1/models`: exposed API route metadata. This is the client-facing model routing view, not a live health report.

## Install And Run

```powershell
npm install
npm run build
npm run config:validate
```

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

Recommended first browser checks:

- dashboard: `http://127.0.0.1:9898/jobs/dashboard`
- health: `http://127.0.0.1:9898/health`

Quick health/config self-check:

```powershell
npm run doctor
```

`npm run doctor` returns a structured runtime diagnostics report, including:

- config load status
- planner/executor model readiness
- executor candidate queue summary
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
- `POST /v1/jobs/:id/approve`
- `POST /v1/jobs/:id/resume`

Browser-friendly built-in pages:

- `GET /jobs/dashboard`
- `GET /jobs/data`
- `GET /jobs/:id`
- `GET /jobs/:id/events`
- `GET /jobs/:id/stream`
- `GET /jobs/:id/timeline`
- `POST /jobs/:id/resume`

Notes for multi-model users:

- `GET /health` is the primary live-health endpoint
- `GET /v1/models` shows exposed route metadata and active planner/executor mapping
- `POST /v1/jobs` now prefers runtime lazy executor admission for retrieval-heavy work instead of unconditional up-front probing
- CLI `task` / `team` entrypoints still use explicit preflight probing

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
- intended for dashboards, timelines, and collaboration views
- supports SSE resume with `Last-Event-ID`
- supports replay from `since_seq`
- emits SSE `id:` fields on `job.event` entries

Replay contract:

- `GET /v1/jobs/:id/events?since_seq=N` returns events with `seq > N`
- `GET /v1/jobs/:id/stream?since_seq=N` replays events with `seq > N` before live subscription
- `GET /v1/jobs/:id/stream` with header `Last-Event-ID: N` resumes from `seq > N`
- `job.snapshot` includes `replay.next_seq`, `replay.can_resume_from`, `replay.resumed_from_seq`, and `replay.replayed_count`
- recovery-aware `job.snapshot` payloads also include `follow`, `actions`, and `snapshot.recovery`

You can explicitly opt into raw workflow SSE events on compatible routes with:

- `include_workflow_events: true`
- or header `x-dual-agent-workflow-events: true`

## Async Jobs

`POST /v1/jobs` supports async job creation for frontend clients.

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
- built-in DAG lanes that render real dependency graphs instead of simple task lists
- superseded workflow lanes and replan history focus interactions inside `/v1/jobs/:id/timeline`
- a built-in runtime analysis panel for verification outcomes, artifact activity, tool activity, and common blockers
- click-to-filter analysis chips that can jump from summary statistics to matching events and related workflow lanes
- shareable timeline URLs that preserve `workflowFocus`, `analysisFilter`, and `analysisValue`
- recovery-aware frontend signals such as `job.redirect`, `snapshot.follow`, `snapshot.actions`, and `snapshot.recovery`
- a browser-friendly `/jobs/dashboard` that summarizes persisted jobs without requiring manual auth headers

Example mirrored progress in chat streams:

```text
[Step 2 | Research]
Completed 3 search rounds, gathered 30 candidate results, and is filtering trustworthy sources.

[Step 3 | Evidence]
Read 5 saved artifacts and is extracting the key details.
```

## Report/File Output Validation

The runtime guards against false completion for local deliverables.

If the task says things like:

- "write a markdown report to local"
- "save `report.md`"
- "write `D:\...\report.md`"

then a planner `final` answer is no longer enough. The run only completes if:

- the executor actually performs `write_file`
- and the write target matches the requested output path

## Logs And Persistence

Each run produces:

- JSONL trace logs under `runtime/logs/`
- persisted job records under `runtime/jobs/`
- tool artifacts under `runtime/command-results/`

Logs include:

- planner requests and parsed decisions
- executor requests and parsed results
- native tool call start/finish events
- protocol-correction, recovery, and loop-detection events

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

- browser dashboard data is still loaded as one list response; very large job histories will benefit from future pagination
- some integration tests around restart recovery still need cleanup to fully match the newer auto-resume behavior
- executor candidate health filtering is implemented, but planner candidate health filtering is not yet wired into the same admission path
- `npm run doctor` does not perform live async per-model probing; use `/health` for real-time executor pool status
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
- use `/jobs/dashboard` when you want a zero-setup browser view of persisted jobs

## Acknowledgments

- [Linux.do](https://linux.do/)
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/)
