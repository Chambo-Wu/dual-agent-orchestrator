# Dual Agent Orchestrator 中文说明

Dual Agent Orchestrator 是一套通用的 `planner + executor` 多模型协作运行时，当前已经同时提供：

- OpenAI 兼容聊天接口
- Anthropic 风格 `messages` 接口
- 面向长任务的一等 `job` 控制面
- 面向前台展示的实时工作流事件流

English documentation: [README.md](./README.md)

## 当前能做什么

系统围绕两个模型角色工作：

- `planner`：更强的模型，负责理解目标、拆解步骤、审核阶段结果、决定是否重试，以及输出最终结论
- `executor`：更便宜或更本地的模型，负责调用确定性工具完成实际执行

当前代码已经不再只是一个 CLI 骨架，而是具备了以下能力：

- 异步 `job` 创建与持久化
- planner / executor 步骤历史、artifact、运行日志
- `/v1/jobs/:id/events` 与 `/v1/jobs/:id/stream` 实时事件流
- `/v1/jobs/:id/timeline` 可视化时间线页面
- 兼容 Cherry Studio 这类标准聊天客户端的进度镜像
- 防止“口头说已写文件，但实际没落盘”的文件写入校验

## 架构概览

- `src/orchestrator.ts`：主编排循环、协议修正、证据校验、写文件校验
- `src/tools.ts`：本地工具与搜索/抓取/文件执行
- `src/index.ts`：HTTP 服务、聊天接口适配、job 控制面、进度镜像
- `src/workflow-ui-events.ts`：前台标准化事件 schema
- `src/job-event-bus.ts`：job 事件总线与持久化
- `src/timeline.ts`：时间线 HTML 渲染
- `runtime/jobs/`：job 持久化记录
- `runtime/logs/`：每次运行的 JSONL 日志
- `runtime/command-results/`：工具产物

## 已支持工具

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

说明：

- 文件路径相对工作区根目录解析
- 工具产物默认保存到 `runtime/command-results/`
- Windows 下 `shell_command` 优先 PowerShell，失败后回退 `cmd.exe`
- `Invoke-WebRequest` / `Invoke-RestMethod` 会做非交互兼容处理

## 配置

编辑 `config/example.config.yml`：

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

真实密钥写入 `.env`：

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
```

## 安装与启动

```powershell
npm install
npm run build
npm run config:validate
```

执行单次 CLI 任务：

```powershell
node --enable-source-maps dist/index.js "Write a markdown file named notes/todo.md with three deployment tasks."
```

启动本地 API 服务：

```powershell
npm run serve
```

默认地址：

- `http://127.0.0.1:9898`

快速自检：

```powershell
npm run doctor
```

## API 能力

鉴权方式：

- `Authorization: Bearer <api_key>` 或 `X-API-Key`
- 默认本地 key：`dual-agent-local`
- 可通过 `DUAL_AGENT_API_KEY` 覆盖

标准接口：

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

Job 控制面：

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

## 两种流式体验

当前有两条不同的实时链路：

### 1. 标准聊天流

适用于：

- Cherry Studio
- OpenAI 兼容客户端
- Anthropic 风格客户端

特点：

- 保持协议兼容
- 默认不会把原始 `workflow.*` SSE 事件混进标准流
- 可以把 planner / executor 的关键进度镜像成普通文本 delta

### 2. 工作流事件流

适用于：

- 自定义前端
- 时间线 / 协作可视化页面
- 任务监控面板

特点：

- 使用 `/v1/jobs/:id/stream`
- 返回标准化 UI 事件
- 可配合 `/v1/jobs/:id/events` 做历史回放

如果你确实要在兼容接口里拿原始工作流 SSE 事件，可以显式开启：

- 请求体 `include_workflow_events: true`
- 或头 `x-dual-agent-workflow-events: true`

## 异步 Job

`POST /v1/jobs` 已支持异步任务启动。

典型行为：

- 当 `policy.async = true` 时返回 `202`
- 响应会带上 `job_id`
- 同时返回 `stream_url`、`events_url`、`timeline_url`
- 前端可以立刻订阅 `/v1/jobs/:id/stream`

## 前台进度展示

当前前台进度能力分两层：

### 自定义前台

使用标准化事件：

- `/v1/jobs/:id/events`
- `/v1/jobs/:id/stream`
- `/v1/jobs/:id/timeline`

### 通用聊天前台

对于 Cherry Studio 这种只消费标准聊天流的客户端，当前已经支持把内部流程镜像成更友好的摘要文本，而不是只显示转圈。

当前文本会尽量收敛成卡片式摘要，例如：

```text
[步骤 2 · 检索中]
已完成 3 轮搜索，累计找到 30 条候选结果，正在筛选可信来源。

[步骤 3 · 取证中]
已读取 5 份过程资料，正在提炼其中的关键信息。
```

另外还做了两层降噪：

- 重复 `web_search` / `url_fetch` 会被聚合，不会刷满整屏日志
- 底层技术语句会被翻译成更面向用户的文案

## 文件写入校验

当前系统已经修复了一个关键问题：

过去如果用户要求“生成报告并写入本地”，planner 可能直接在最终回答里说“已写入”，但磁盘上其实没有文件。

现在这类任务会被强制校验：

- 如果目标里明确要求输出本地文件
- 那么只有真正发生 `write_file`
- 且写入路径匹配目标文件
- 才允许任务进入完成态

也就是说，“说写了”已经不够，必须“真的写了”。

## 日志与持久化

每次运行会留下三类关键数据：

- `runtime/logs/`：JSONL 运行日志
- `runtime/jobs/`：job 持久化记录
- `runtime/command-results/`：工具产物

日志内容包括：

- planner 请求与解析结果
- executor 请求与解析结果
- 工具调用开始/结束
- 协议修正
- loop 检测
- 任务状态变化

## 测试

运行全部测试：

```powershell
npm run test
```

按类型运行：

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e-lite
```

## 当前限制

- `POST /v1/jobs` 目前主要支持 `mode: "task"`，team 模式控制面还没有完全补齐
- planner 的稳定性仍依赖上游模型
- 搜索质量受 provider 与 query 质量影响较大
- 一些网页仍会遇到 JS 渲染、`403/401/429` 等限制，因此有时只能退化到基于已有 artifact 的总结
- 不同聊天客户端对流式换行的渲染策略不同，表现可能仍略有差异

## 推荐接入方式

如果你接的是通用客户端：

- 用 `/v1/chat/completions`
- 打开 `stream: true`
- 使用文本进度镜像

如果你接的是自定义前台：

- 用 `POST /v1/jobs`
- 订阅 `/v1/jobs/:id/stream`
- 刷新时读 `/v1/jobs/:id/events`
- 需要可视化时直接打开 `/v1/jobs/:id/timeline`

## 致谢

- [Linux.do](https://linux.do/) — Where possible begins
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/) — 百万亿Token 创造者激励计划
