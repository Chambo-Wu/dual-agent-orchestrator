# Dual Agent Orchestrator 中文说明

Dual Agent Orchestrator 是一套通用的 `planner + executor` 多模型协作运行时，当前同时提供：

- OpenAI 兼容聊天接口
- Anthropic 风格 `messages` 接口
- 面向长任务的 job 控制面
- 面向前端展示的实时 workflow 事件流

English documentation: [README.md](./README.md)

相关规划文档：

- [路线图-分阶段持续推进与实施清单-20260526.md](./docs/路线图-分阶段持续推进与实施清单-20260526.md)

## 概览

系统围绕两个模型角色构建：

- `planner`：更强的规划模型，负责理解目标、拆分步骤、审计进展、决定 retry/replan，并生成最终答案
- `executor`：更便宜或更本地化的执行模型，负责读写文件、搜索、抓取、解析等确定性工具工作

当前实现同时支持：

- 通过 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 直接作为聊天接口使用
- 通过 `/v1/jobs` 作为一等任务运行时使用

## 统一术语

以下术语建议在 runtime、API、前端和规划文档中保持一致：

- `job`：通过 `/v1/jobs` 管理的顶层执行记录
- `workflow`：挂在 job 上的结构化执行计划；运行中可被 `replan`
- `task`：workflow 中的节点，例如 `write`、`search`、`fetch`、`verify`、`synthesize`
- `task run`：task 在 job 内的一次持久化执行记录
- `step`：planner / executor 的一步迭代，或事件中的阶段标记；不等同于 `task`
- `artifact`：由工具或 task 执行产出的可持久化结果，用于验证或后续消费
- `verifier`：system-first 的验证层，用来判断输出是否真实、有效、充分
- `retry`：对同一任务意图重新执行
- `resume`：通过控制面继续一个中断或 blocked 的 job
- `replan`：在失败或新信息出现后替换或调整 active workflow
- `replay`：通过 `/events` 或 `/stream` 结合 `since_seq` / `Last-Event-ID` 重放持久化事件

## 当前状态

项目已经不再只是一个 CLI 原型。当前代码库已经具备：

- 异步 job 创建与持久化记录
- planner / executor 迭代历史、task run 与 artifact
- 基于 SSE 的实时 workflow 事件流
- job 的 HTML timeline 页面
- workflow plan 的解析、校验与 runtime 执行
- 显式 workflow DAG 摘要，支持 active / superseded lane
- runtime replan 历史保留与前端消费
- 内置 dependency graph 可视化，而不只是任务列表
- timeline 中的 replan 与 graph 聚焦联动
- 面向 Cherry Studio 等通用客户端的进度镜像
- 更强的文件写入校验，避免“模型说已保存，但磁盘并未落盘”

里程碑上可以认为：

- Milestone C 已经在 runtime 与 UI contract 层面基本收口
- 下一阶段重点更偏向 Milestone D：workflow UX、可观测性与更深入的前端交互

## 核心结构

- `src/orchestrator.ts`：planner / executor 主循环、协议修正、证据检查、文件写入校验
- `src/tools.ts`：本地工具与搜索 / 抓取 / 文件执行
- `src/index.ts`：HTTP API、job 控制面、事件流与响应组装
- `src/workflow-ui-events.ts`：面向前端的标准化事件 schema
- `src/job-event-bus.ts`：job 事件总线与持久化
- `src/timeline.ts`：timeline HTML 渲染
- `src/workflow-plan.ts`：workflow plan schema 解析与校验
- `src/workflow-runtime.ts`：workflow runtime 执行与 replan 流程
- `src/workflow-graph.ts`：DAG 与 replan history 视图模型
- `runtime/jobs/`：持久化 job 记录
- `runtime/logs/`：每次运行的 JSONL 日志
- `runtime/command-results/`：工具产物

## 支持的工具

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

- 文件路径默认相对 workspace root 解析
- 工具产物会落到 `runtime/command-results/`
- Windows 上 `shell_command` 优先使用 PowerShell，必要时回退到 `cmd.exe`

## 配置

可以先把 `config/example.config.yml` 作为模板，再复制为 `config/config.yml`。

示例：

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

把密钥放进 `.env`：

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
```

## 安装与运行

```powershell
npm install
npm run build
npm run config:validate
```

说明：

- 默认加载 `config/config.yml`
- `config/example.config.yml` 只是示例，不会自动加载
- `npm run config:validate` 与 `npm run doctor` 默认也会检查 `config/config.yml`

运行一次性 CLI 任务：

```powershell
node --enable-source-maps dist/index.js "Write a markdown file named notes/todo.md with three deployment tasks."
```

启动本地服务：

```powershell
npm run serve
```

默认地址：

- `http://127.0.0.1:9898`

快速自检：

```powershell
npm run doctor
```

`doctor` 现在会输出结构化 runtime diagnostics，至少包含：

- 配置加载状态
- task routing 加载状态
- runtime profile 快照
- proxy health
- workspace / runtime 可写性检查
- search provider 配置存在性

## API 面

认证：

- `Authorization: Bearer <api_key>` 或 `X-API-Key`
- 本地默认 key：`dual-agent-local`
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

## Streaming 模式

当前有两种不同的流式体验：

1. 标准模型流

- 使用 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`
- 保持与常规 OpenAI / Anthropic 客户端协议兼容
- 默认不会插入原始 `workflow.*` SSE 事件
- 可把 planner / executor 进度镜像成普通文本增量，方便 Cherry Studio 一类客户端消费

2. Workflow 流

- 使用 `/v1/jobs/:id/stream`
- 输出标准化 workflow 事件
- 面向 dashboard、timeline 和多代理协作前端
- 支持通过 `Last-Event-ID` 做 SSE 续传
- 支持通过 `since_seq` 做历史回放
- `job.event` 会带 SSE `id:`

Replay contract：

- `GET /v1/jobs/:id/events?since_seq=N` 返回 `seq > N` 的事件
- `GET /v1/jobs/:id/stream?since_seq=N` 会先回放 `seq > N` 的历史事件，再进入实时订阅
- `GET /v1/jobs/:id/stream` 配合 header `Last-Event-ID: N` 时，会从 `seq > N` 继续
- `job.snapshot` 会带 `replay.next_seq`、`replay.can_resume_from`、`replay.resumed_from_seq`、`replay.replayed_count`

如果需要，也可以在兼容路由上显式开启原始 workflow SSE：

- `include_workflow_events: true`
- 或 header `x-dual-agent-workflow-events: true`

## Async Jobs

`POST /v1/jobs` 支持面向前端客户端的异步任务创建。

典型行为：

- `policy.async = true` 返回 `202`
- 响应里会包含 `job_id`、`stream_url`、`events_url`、`timeline_url`
- job 会在后台继续执行
- 客户端可订阅 `/v1/jobs/:id/stream` 获取实时进展

## 前端进度 UX

当前进度系统同时面向自定义前端和通用客户端：

- `/v1/jobs/:id/events` 与 `/stream` 的标准化 workflow UI 事件
- `planning`、`research`、`evidence`、`filtering`、`synthesis`、`writing` 等阶段化状态
- 聚合过的工具摘要，避免重复 `web_search` / `url_fetch` 事件淹没前端
- 标准聊天流里的卡片式文本进度
- timeline 内置 DAG lane，并渲染真实 dependency graph
- timeline 中的 superseded workflow lane 与 replan history 聚焦联动
- 内置 runtime analysis 面板，可查看 verification 结果、artifact 活动、tool 活动和常见 blocker
- 支持点击分析项直接筛选对应事件，并联动相关 workflow lane
- 支持通过 URL 持久化 `workflowFocus`、`analysisFilter`、`analysisValue`，便于分享同一定位视图

标准聊天流中的进度镜像示例：

```text
[Step 2 · Research]
Completed 3 search rounds, gathered 30 candidate results, and is filtering trustworthy sources.

[Step 3 · Evidence]
Read 5 saved artifacts and is extracting the key details.
```

## 报告 / 文件输出校验

现在 runtime 会防止本地交付物出现“假完成”。

如果任务里出现这类目标：

- “写一份 markdown 报告到本地”
- “保存到 `report.md`”
- “写到 `D:\...\report.md`”

那么 planner 的 `final` 文本已经不够。只有当：

- executor 实际执行了 `write_file`
- 且写入目标与请求路径匹配

任务才会真正完成。

## 日志与持久化

每次运行都会产出：

- `runtime/logs/` 下的 JSONL trace 日志
- `runtime/jobs/` 下的持久化 job 记录
- `runtime/command-results/` 下的工具产物

日志内容包括：

- planner 请求与解析后的决策
- executor 请求与解析后的结果
- 原生工具调用的开始 / 结束事件
- 协议修正与 loop detection 事件

## 测试

```powershell
npm run test
```

可单独运行：

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e-lite
```

## 当前限制

- team-mode 控制面尚未完全收口；`/v1/jobs` 当前仍主要支持 `mode: "task"`
- planner 依然会受到上游模型稳定性的影响
- web search 质量很依赖 provider 与 query 质量
- 一些网页仍可能因为 JS 渲染或 `403/401/429` 受限，只能退化成证据摘要
- 通用聊天客户端对流式换行的渲染方式仍可能不同

## 建议的客户端使用方式

对通用客户端：

- 使用 `/v1/chat/completions`
- 开启 `stream: true`
- 消费镜像后的文本进度

对自定义前端：

- 先通过 `POST /v1/jobs` 创建 job
- 订阅 `/v1/jobs/:id/stream`
- 通过 `/v1/jobs/:id/events` 做 replay / refresh
- 保存最近一次收到的 SSE `id`，断线后用 `Last-Event-ID` 继续
- 直接打开 `/v1/jobs/:id/timeline` 查看内置可视化

## 致谢

- [Linux.do](https://linux.do/)
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/)
