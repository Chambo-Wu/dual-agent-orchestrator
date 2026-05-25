# Dual Agent Orchestrator

Dual Agent Orchestrator is a generic `planner + executor` runtime for multi-model task execution. It exposes:

- OpenAI-compatible chat APIs
- Anthropic-style `messages` APIs
- a job-oriented control plane for long-running work
- realtime workflow progress streams for frontend clients

Chinese documentation: [Readme-CN.md](./Readme-CN.md)

## Overview

The system is built around two model roles:

- `planner`: a stronger model that understands the goal, breaks work into steps, audits progress, decides retries, and produces final answers
- `executor`: a cheaper or more local model that performs deterministic tool work such as reading files, writing files, searching, and fetching URLs

The current implementation supports both:

- direct chat-style use through `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`
- first-class task jobs through `/v1/jobs`

## Current Status

This is no longer just a CLI skeleton. The current codebase includes:

- async job creation with persistent job records
- planner/executor step history and artifacts
- realtime workflow event streaming over SSE
- HTML timeline rendering for jobs
- Cherry Studio-friendly progress mirroring inside standard chat streams
- protocol compatibility guards for OpenAI-style and Anthropic-style clients
- stronger file-write validation so the system cannot claim a report was saved unless `write_file` actually succeeded

## Architecture

- `src/orchestrator.ts`: planner/executor loop, protocol correction, evidence checks, file-write validation
- `src/tools.ts`: native tools and search/fetch/file execution
- `src/index.ts`: HTTP API server, chat adapters, job control plane, workflow progress mirroring
- `src/workflow-ui-events.ts`: normalized frontend event schema
- `src/job-event-bus.ts`: persisted event bus for job streams
- `src/timeline.ts`: HTML timeline rendering
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
- open `/v1/jobs/:id/timeline` for a built-in visualization

## Acknowledgments

- [Linux.do](https://linux.do/) — Where possible begins
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/) — 百万亿Token 创造者激励计划
