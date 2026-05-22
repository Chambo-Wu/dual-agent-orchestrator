# Dual Agent Orchestrator

This project turns the planner + executor idea into a minimal runnable skeleton.

中文文档: [Readme-CN.md](./Readme-CN.md)

## Design

- `planner`: a stronger model behind a web API, focused on understanding, planning, and final answers
- `executor`: a local model with native tool calling, focused on stable structured execution
- `tools`: deterministic local tools for reading, writing, listing files, and running shell commands

## Layout

- `src/config.ts`: loads the example YAML-like config
- `src/prompts.ts`: planner and executor prompt templates
- `src/providers/openai-compatible.ts`: OpenAI-compatible chat client
- `src/executor-adapter.ts`: normalizes reasoning-heavy executor output into stable JSON
- `src/tools.ts`: local tool registry and execution
- `src/orchestrator.ts`: step loop that connects planner and executor
- `src/index.ts`: CLI entry

## Example config

Edit `config/example.config.yml`:

```yml
planner:
  base_url: "http://127.0.0.1:8790/v1"
  api_key: "env:PLANNER_API_KEY"
  model: "glm5"

executor:
  base_url: "http://192.168.156.232:1234/v1"
  api_key: "env:EXECUTOR_API_KEY"
  model: "qwen/qwen3-4b-2507"
```

Put the real values in `.env`:

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
```

## Supported tools

- `read_file`
- `write_file`
- `list_files`
- `shell_command`

File IO is restricted to the local `runtime/` directory.
Shell commands run in the current project workspace, try PowerShell first and fall back to `cmd.exe`, with a timeout guard.
PowerShell is started in non-interactive mode. For `Invoke-WebRequest` and `Invoke-RestMethod`, the tool auto-adds `-UseBasicParsing` when it is missing to reduce server-side prompts.

## Run

1. Install dependencies:

```powershell
npm install
```

2. Typecheck:

```powershell
npm run typecheck
```

3. Validate config before first run:

```powershell
npm run config:validate
```

4. Run:

```powershell
npm run build
node --enable-source-maps dist/index.js "Write a markdown file named notes/todo.md with three deployment tasks."
```

## Local API service

Start a local OpenAI-compatible service:

```powershell
npm run serve
```

Default address:

- `http://127.0.0.1:8787`

Quick config self-check:

```powershell
npm run doctor
```

Supported endpoints:

- `GET /v1/models`
- `GET /health`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

Current notes:

- both non-streaming and SSE streaming chat completions are supported
- `/v1/responses` supports non-streaming and SSE-compatible event streaming
- `/v1/messages` supports non-streaming and Anthropic-style event streaming
- the service derives the task from the last `user` message
- the exposed model id defaults to `dual-agent-orchestrator`
- requests to `/v1/*` require `Authorization: Bearer <api_key>` or `X-API-Key`
- the default local API key is `dual-agent-local`
- set `DUAL_AGENT_API_KEY` to use a custom API key
- `GET /health` returns service status and planner circuit-breaker state
- if the planner upstream fails repeatedly, the service opens a planner circuit breaker and returns `503`
- `503` responses include `Retry-After` and a JSON `retry_after` field

Planner availability protection:

- planner failures are counted consecutively
- after 3 consecutive planner failures, the circuit opens for 60 seconds
- during the cooldown window, planner-backed routes return `503` immediately instead of repeatedly hitting the upstream

## Custom model mapping

You can expose multiple model ids through `/v1/models` by setting `DUAL_AGENT_MODELS` as a JSON array.

Example:

```powershell
$env:DUAL_AGENT_MODELS='[
  {"id":"dual-agent-orchestrator","owned_by":"dual-agent","description":"Default route"},
  {"id":"dual-agent-fast","planner_model":"glm5","executor_model":"qwen/qwen3-4b-2507","description":"Fast local executor route"},
  {"id":"dual-agent-alt","planner_model":"glm5","executor_model":"qwen/qwen3-4b-2507","executor_base_url":"http://127.0.0.1:1234/v1","executor_api_key":"local-key"}
]'
```

Supported override fields per exposed model:

- `id`
- `owned_by`
- `description`
- `planner_model`
- `planner_base_url`
- `planner_api_key`
- `executor_model`
- `executor_base_url`
- `executor_api_key`

## Chained example

This sample exercises a real `read_file -> summarize -> write_file` workflow.

Source file:

- `runtime/examples/meeting-notes.md`

Run:

```powershell
node --enable-source-maps dist/index.js "Read examples/meeting-notes.md, summarize the key points into three bullet items, and write the result to notes/meeting-summary.md."
```

Expected behavior:

- planner asks for a read step first
- executor reads the source file
- planner uses the read result to request a summary file write
- executor writes `runtime/notes/meeting-summary.md`

## Current scope

This is an MVP skeleton, not a production agent system yet.

What it already demonstrates:

- dual model configuration
- planner / executor separation
- structured JSON contracts
- deterministic local tool execution
- native tool-calling executor integration with JSON fallback
- executor output normalization for reasoning-heavy local models
- a stricter executor prompt tuned for smaller local models such as qwen3-4b
- a basic `shell_command` tool for real command execution tasks
- per-run JSONL logs for planner, executor, and tool execution under `runtime/logs/`

What is still missing:

- retries per tool call
- streaming support
- richer memory / state persistence
- web tools
- validation and guardrails

## Debug logs

Each CLI run writes a JSONL log file under `runtime/logs/`.

The log includes:

- planner request and raw response
- parsed planner decision
- executor request and raw response
- native `tool_calls` or JSON-fallback parsing result
- each tool execution start and finish event

The CLI prints the log path to stderr after each run so you can inspect a single trace quickly.

## Shell command task loop

Example prompt for a code-task style loop:

```powershell
node --enable-source-maps dist/index.js "Use shell_command to list files under runtime/notes, then write the command output into notes/shell-report.md."
```

Shell command note:

- prefer non-interactive commands
- prefer `curl.exe` for HTTP fetches when possible
- if you use `Invoke-WebRequest` or `Invoke-RestMethod`, the tool will force `-UseBasicParsing`

## End-to-end protocol examples

Default assumptions:

- base URL: `http://127.0.0.1:8787`
- API key: `dual-agent-local`
- model: `dual-agent-orchestrator`

### OpenAI tool call, first round

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer dual-agent-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dual-agent-orchestrator",
    "messages": [
      { "role": "user", "content": "Read notes/todo.md and tell me what is inside." }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "Read a local UTF-8 text file.",
          "parameters": {
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
          }
        }
      }
    ]
  }'
```

Expected:

- `finish_reason = "tool_calls"`
- `message.tool_calls[0].function.name = "read_file"`

### OpenAI tool result, second round

Send the original user message, the assistant `tool_calls`, and then a `tool` role message containing the tool result.

Expected:

- either a final assistant text answer
- or another `tool_calls` response if another tool is needed

### Anthropic tool_use, first round

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer dual-agent-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dual-agent-orchestrator",
    "messages": [
      { "role": "user", "content": "Read notes/todo.md and summarize it." }
    ],
    "tools": [
      {
        "name": "read_file",
        "description": "Read a local UTF-8 text file.",
        "input_schema": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    ]
  }'
```

Expected:

- `content[0].type = "tool_use"`
- `stop_reason = "tool_use"`

### Anthropic tool_result, second round

Send:

- original user message
- assistant `tool_use`
- a follow-up `user.content[]` block with `type = "tool_result"`

Expected:

- either a final text response with `stop_reason = "end_turn"`
- or another `tool_use` if more tools are needed
