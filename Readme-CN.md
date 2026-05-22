# Dual Agent Orchestrator（中文说明）

这个项目把「规划模型 + 执行模型」的思路落地成一个可运行的最小骨架（MVP）。

## 设计目标

- `planner`：更强的 Web API 模型，负责理解目标、拆解步骤、收尾回答
- `executor`：本地模型，负责稳定执行（优先使用原生 tool calling）
- `tools`：本地确定性工具，负责实际读写文件、列目录、执行命令

## 项目结构

- `src/config.ts`：加载配置
- `src/prompts.ts`：planner / executor 提示词
- `src/providers/openai-compatible.ts`：OpenAI 兼容接口客户端
- `src/executor-adapter.ts`：executor 输出兜底解析（JSON fallback）
- `src/tools.ts`：工具定义和执行逻辑
- `src/orchestrator.ts`：主流程编排（step loop）
- `src/logger.ts`：按运行生成 JSONL 调试日志
- `src/index.ts`：CLI 入口

## 配置示例

编辑 `config/example.config.yml`：

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

真实密钥写到 `.env`：

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
```

## 已支持工具

- `read_file`
- `write_file`
- `list_files`
- `shell_command`

说明：

- 文件读写限制在本地 `runtime/` 目录
- `shell_command` 在工作区执行，优先尝试 PowerShell，失败后回退到 `cmd.exe`
- `shell_command` 会强制使用非交互 PowerShell，并在 `Invoke-WebRequest` / `Invoke-RestMethod` 缺少 `-UseBasicParsing` 时自动补上

## 运行方式

1. 安装依赖

```powershell
npm install
```

2. 类型检查

```powershell
npm run typecheck
```

3. 首次运行前先校验配置

```powershell
npm run config:validate
```

4. 构建

```powershell
npm run build
```

5. 执行任务

```powershell
node --enable-source-maps dist/index.js "Write a markdown file named notes/todo.md with three deployment tasks."
```

## 本地 API 服务

可以直接启动一个本地 OpenAI 兼容接口服务：

```powershell
npm run serve
```

默认地址：

- `http://127.0.0.1:8787`

快速自检命令：

```powershell
npm run doctor
```

当前已实现端点：

- `GET /v1/models`
- `GET /health`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

当前限制：

- 支持非流式和 SSE 流式 `chat/completions`
- `responses` 支持非流式和 SSE 兼容事件流
- `messages` 支持非流式和 Anthropic 风格事件流
- 任务内容默认取 `messages` 中最后一条 `user` 消息
- 默认对外暴露的模型名为 `dual-agent-orchestrator`
- `/v1/*` 请求需要提供 `Authorization: Bearer <api_key>` 或 `X-API-Key`
- 默认本地 API key 为 `dual-agent-local`
- 可通过设置环境变量 `DUAL_AGENT_API_KEY` 自定义服务端 API key
- `GET /health` 可查看服务状态和 planner 熔断状态
- 当 planner 上游连续失败时，服务会返回更明确的 `503`
- `503` 响应会包含 `Retry-After` 响应头和 JSON 中的 `retry_after`

Planner 可用性保护：

- 服务会统计 planner 的连续失败次数
- 连续失败达到 3 次后，会打开 60 秒熔断窗口
- 在熔断窗口内，依赖 planner 的请求会直接返回 `503`，避免继续打坏上游

## 自定义模型列表与映射

可以通过环境变量 `DUAL_AGENT_MODELS` 配置多个对外模型名，并让它们映射到不同的 planner / executor 组合。

示例：

```powershell
$env:DUAL_AGENT_MODELS='[
  {"id":"dual-agent-orchestrator","owned_by":"dual-agent","description":"默认路由"},
  {"id":"dual-agent-fast","planner_model":"glm5","executor_model":"qwen/qwen3-4b-2507","description":"更快的执行器路由"},
  {"id":"dual-agent-alt","planner_model":"glm5","executor_model":"qwen/qwen3-4b-2507","executor_base_url":"http://127.0.0.1:1234/v1","executor_api_key":"local-key"}
]'
```

每个映射项当前支持这些字段：

- `id`
- `owned_by`
- `description`
- `planner_model`
- `planner_base_url`
- `planner_api_key`
- `executor_model`
- `executor_base_url`
- `executor_api_key`

## 链式样例（read_file -> summarize -> write_file）

示例源文件：

- `runtime/examples/meeting-notes.md`

执行命令：

```powershell
node --enable-source-maps dist/index.js "Read examples/meeting-notes.md, summarize the key points into three bullet items, and write the result to notes/meeting-summary.md."
```

预期流程：

- planner 先下发读取文件
- executor 调用 `read_file`
- planner 基于历史结果生成总结写入步骤
- executor 调用 `write_file` 写入 `runtime/notes/meeting-summary.md`

## shell_command 闭环样例

```powershell
node --enable-source-maps dist/index.js "Use shell_command to list files under runtime/notes, then write the command output into notes/shell-report.md."
```

Shell command 注意事项：

- 尽量使用非交互式命令
- 抓取 HTTP 内容时优先使用 `curl.exe`
- 如果使用 `Invoke-WebRequest` 或 `Invoke-RestMethod`，系统会强制补上 `-UseBasicParsing`

这个样例会走通：

- `shell_command` 获取目录输出
- planner 读取执行历史并下发写入步骤
- `write_file` 将命令输出写入 `runtime/notes/shell-report.md`

## 调试日志

每次运行会在 `runtime/logs/` 下生成一个独立的 `.jsonl` 文件。

日志包含：

- planner 请求与原始响应
- planner 解析后的结构化决策
- executor 请求与原始响应
- 原生 `tool_calls` 或 JSON fallback 解析结果
- 每次工具执行的开始/结束事件

CLI 会在 stderr 打印本次日志路径，便于快速定位单次运行问题。

## 当前状态与限制

已具备：

- 双模型分工
- 原生 tool calling 执行路径（executor）
- JSON fallback 兜底解析
- 本地工具执行
- 按运行日志追踪

仍待增强：

- 工具级重试策略
- 流式执行链路
- 更丰富的状态持久化
- Web 工具扩展
- 更严格的安全策略和参数校验

注意：

- `planner` 所在的上游 Web API 偶发可能出现 500，需要后续增加自动重试
- `shell_command` 的本地化输出在某些环境下可能出现中文编码抖动，不影响执行闭环，但会影响展示文本

## 端到端协议样例

下面这几组样例可直接用于手工验证：

- OpenAI 风格：首轮请求工具调用
- OpenAI 风格：回传 `tool` 结果后继续推理
- Anthropic 风格：首轮 `tool_use`
- Anthropic 风格：回传 `tool_result` 后继续推理

默认假设：

- 服务地址：`http://127.0.0.1:8787`
- API key：`dual-agent-local`
- 模型名：`dual-agent-orchestrator`

### OpenAI 首轮请求

目标：让服务返回标准 `tool_calls`

`curl`：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer dual-agent-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dual-agent-orchestrator",
    "messages": [
      {
        "role": "user",
        "content": "Read notes/todo.md and tell me what is inside."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "Read a local UTF-8 text file.",
          "parameters": {
            "type": "object",
            "properties": {
              "path": { "type": "string" }
            },
            "required": ["path"]
          }
        }
      }
    ]
  }'
```

PowerShell：

```powershell
$body = @{
  model = "dual-agent-orchestrator"
  messages = @(
    @{
      role = "user"
      content = "Read notes/todo.md and tell me what is inside."
    }
  )
  tools = @(
    @{
      type = "function"
      function = @{
        name = "read_file"
        description = "Read a local UTF-8 text file."
        parameters = @{
          type = "object"
          properties = @{
            path = @{ type = "string" }
          }
          required = @("path")
        }
      }
    }
  )
} | ConvertTo-Json -Depth 8

Invoke-WebRequest -UseBasicParsing `
  -Method Post `
  -Uri "http://127.0.0.1:8787/v1/chat/completions" `
  -Headers @{ Authorization = "Bearer dual-agent-local" } `
  -ContentType "application/json; charset=utf-8" `
  -Body $body | Select-Object -ExpandProperty Content
```

预期返回要点：

- `choices[0].finish_reason = "tool_calls"`
- `choices[0].message.tool_calls[0].function.name = "read_file"`

### OpenAI 第二轮回传 tool 结果

假设首轮已经返回：

- `tool_call_id = call_123`
- 参数为：`{"path":"notes/todo.md"}`

客户端执行工具后，把结果作为 `tool` 消息回传：

`curl`：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer dual-agent-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dual-agent-orchestrator",
    "messages": [
      {
        "role": "user",
        "content": "Read notes/todo.md and tell me what is inside."
      },
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "read_file",
              "arguments": "{\"path\":\"notes/todo.md\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "tool_call_id": "call_123",
        "content": "# Deployment Tasks\n\n- [ ] Configure production environment variables"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "Read a local UTF-8 text file.",
          "parameters": {
            "type": "object",
            "properties": {
              "path": { "type": "string" }
            },
            "required": ["path"]
          }
        }
      }
    ]
  }'
```

PowerShell：

```powershell
$body = @{
  model = "dual-agent-orchestrator"
  messages = @(
    @{
      role = "user"
      content = "Read notes/todo.md and tell me what is inside."
    },
    @{
      role = "assistant"
      content = ""
      tool_calls = @(
        @{
          id = "call_123"
          type = "function"
          function = @{
            name = "read_file"
            arguments = "{\"path\":\"notes/todo.md\"}"
          }
        }
      )
    },
    @{
      role = "tool"
      tool_call_id = "call_123"
      content = "# Deployment Tasks`n`n- [ ] Configure production environment variables"
    }
  )
  tools = @(
    @{
      type = "function"
      function = @{
        name = "read_file"
        description = "Read a local UTF-8 text file."
        parameters = @{
          type = "object"
          properties = @{
            path = @{ type = "string" }
          }
          required = @("path")
        }
      }
    }
  )
} | ConvertTo-Json -Depth 10

Invoke-WebRequest -UseBasicParsing `
  -Method Post `
  -Uri "http://127.0.0.1:8787/v1/chat/completions" `
  -Headers @{ Authorization = "Bearer dual-agent-local" } `
  -ContentType "application/json; charset=utf-8" `
  -Body $body | Select-Object -ExpandProperty Content
```

预期返回要点：

- 如果信息足够，返回普通文本答案
- 如果还需要更多工具，可能再次返回新的 `tool_calls`

### Anthropic 首轮请求

目标：让服务返回 `tool_use`

`curl`：

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer dual-agent-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dual-agent-orchestrator",
    "messages": [
      {
        "role": "user",
        "content": "Read notes/todo.md and summarize it."
      }
    ],
    "tools": [
      {
        "name": "read_file",
        "description": "Read a local UTF-8 text file.",
        "input_schema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    ]
  }'
```

PowerShell：

```powershell
$body = @{
  model = "dual-agent-orchestrator"
  messages = @(
    @{
      role = "user"
      content = "Read notes/todo.md and summarize it."
    }
  )
  tools = @(
    @{
      name = "read_file"
      description = "Read a local UTF-8 text file."
      input_schema = @{
        type = "object"
        properties = @{
          path = @{ type = "string" }
        }
        required = @("path")
      }
    }
  )
} | ConvertTo-Json -Depth 8

Invoke-WebRequest -UseBasicParsing `
  -Method Post `
  -Uri "http://127.0.0.1:8787/v1/messages" `
  -Headers @{ Authorization = "Bearer dual-agent-local" } `
  -ContentType "application/json; charset=utf-8" `
  -Body $body | Select-Object -ExpandProperty Content
```

预期返回要点：

- `content[0].type = "tool_use"`
- `stop_reason = "tool_use"`

### Anthropic 第二轮回传 tool_result

假设首轮返回：

- `tool_use.id = toolu_123`
- `tool_use.name = read_file`

客户端执行后，把结果放回 `user.content` 的 `tool_result` 块：

`curl`：

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer dual-agent-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dual-agent-orchestrator",
    "messages": [
      {
        "role": "user",
        "content": "Read notes/todo.md and summarize it."
      },
      {
        "role": "assistant",
        "content": [
          {
            "type": "tool_use",
            "id": "toolu_123",
            "name": "read_file",
            "input": { "path": "notes/todo.md" }
          }
        ]
      },
      {
        "role": "user",
        "content": [
          {
            "type": "tool_result",
            "tool_use_id": "toolu_123",
            "content": "# Deployment Tasks\n\n- [ ] Configure production environment variables"
          }
        ]
      }
    ],
    "tools": [
      {
        "name": "read_file",
        "description": "Read a local UTF-8 text file.",
        "input_schema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    ]
  }'
```

PowerShell：

```powershell
$body = @{
  model = "dual-agent-orchestrator"
  messages = @(
    @{
      role = "user"
      content = "Read notes/todo.md and summarize it."
    },
    @{
      role = "assistant"
      content = @(
        @{
          type = "tool_use"
          id = "toolu_123"
          name = "read_file"
          input = @{ path = "notes/todo.md" }
        }
      )
    },
    @{
      role = "user"
      content = @(
        @{
          type = "tool_result"
          tool_use_id = "toolu_123"
          content = "# Deployment Tasks`n`n- [ ] Configure production environment variables"
        }
      )
    }
  )
  tools = @(
    @{
      name = "read_file"
      description = "Read a local UTF-8 text file."
      input_schema = @{
        type = "object"
        properties = @{
          path = @{ type = "string" }
        }
        required = @("path")
      }
    }
  )
} | ConvertTo-Json -Depth 10

Invoke-WebRequest -UseBasicParsing `
  -Method Post `
  -Uri "http://127.0.0.1:8787/v1/messages" `
  -Headers @{ Authorization = "Bearer dual-agent-local" } `
  -ContentType "application/json; charset=utf-8" `
  -Body $body | Select-Object -ExpandProperty Content
```

预期返回要点：

- 如果信息足够，返回 `content[].type = "text"`
- `stop_reason = "end_turn"`
- 如果还需要工具，也可能再次返回新的 `tool_use`
