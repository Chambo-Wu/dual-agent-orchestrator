# Dual Agent Orchestrator 中文说明

Dual Agent Orchestrator 是一套本地优先的 `planner + executor` 多模型协作运行时，当前提供：

- OpenAI 兼容聊天接口
- Anthropic 风格 `messages` 接口
- 面向长任务的 job 控制面
- 面向前端的实时 workflow 事件流
- 内置 job / goal 的 dashboard 与 timeline 页面

> **当前定位**
>
> Dual Agent Orchestrator 已从最初的 planner / executor 双模型协作原型，演进为一个本地优先、可扩展、高度可观测的 Agent Workflow Runtime。当前系统已具备 job / workflow / goal 控制面、skill 运行与验证链路；Goal Mode v1 已完成收口，后续重点转向 Skill 自进化 V2 的质量、可信度、治理与自动化边界。

English documentation: [README-EN.md](./README-EN.md)

## 文档入口

- [文档索引 / 导航页](./docs/文档索引-导航页-20260529.md)
- [开发者入门指南](./docs/开发者入门-架构与开发指南-20260613.md)
- [Demo 操作引导：用户端可视化体验](./docs/Demo操作引导-用户端可视化体验-20260602.md)
- [项目主要里程碑](./docs/里程碑-项目主要功能实现-20260530.md)
- [Skill 自进化 V2 规划](./docs/规划-Skill自进化V2-20260601.md)
- [V2 实测报告](./docs/V2实测报告-3任务设计与优化方向-20260601.md)

## 角色协同说明

项目早期可以概括为围绕 `planner + executor` 两个核心角色构建，但当前实现已经不再只是双角色运行时，而是支持多角色协同：

- `planner`：负责理解目标、拆解步骤、审计进展、决定重试，并生成最终答案
- `executor`：负责文件 I/O、shell、搜索、抓取等确定性工具工作
- `verifier`：负责检查输出是否真实、充分、符合约束
- `team agents`：team mode 下按角色路由的协同 agent，可参与分解、执行、评审与汇总

默认情况下，最简单的部署仍然是一个 `planner` 加一个 `executor`。但当前运行时已经支持：

- team mode 多 agent 协同执行
- 按角色路由模型与 agent
- verifier 角色接入验证主链
- approval gate、resume / retry、可恢复控制面

## Claude Code 入口

`/dao-run <任务>` 与 `/dao-exec <任务>` 是 Claude Code 里的薄入口，目标是把任务交给本地 `/v1/jobs` 控制面，而不是让 Claude Code 把它当成本地文件编辑任务。命令会通过 `node dist/index.js dao-run "<任务>"` 创建 async job，并返回 job id 与 timeline CTA。

如果服务未启动，先运行：

```powershell
npm run serve:restart:9898
```

## Skill 自进化成熟度

当前仓库中的 Skill 自进化能力已经从 v1 控制面基础能力，推进到 V2 的产品化、治理与自动化边界收口。

- 已落地：skill-aware outcome summary、reflection record、proposal / audit / validate / accept / reject API、timeline / dashboard / health 观测链路、基于配置开关的第一版自动闭环
- 已落地：skill reflection 与 skill evolution 生命周期事件已经进入 `/events`、`/stream` 与 replay 契约
- 已落地：Deployment Validation 已具备 deterministic isolated manifest replay、candidate workflow materialization、manual runtime replay validation、runtime replay result taxonomy，以及默认关闭的自动 pipeline runtime replay opt-in 开关 `skill_evolution.runtime_replay_in_auto_pipeline`
- 已落地：V2 proposal quality metadata、auto-accept eligibility contract、Ops queue filters、stuck-state / next-action summary、accepted history rollback link、auditor remediation hints、cross-file consistency、dynamic risk failure clusters、recovery policy 与统一 automation gate summary
- 默认保持保守：`auto_validate`、`auto_accept` 与自动 pipeline runtime replay 默认关闭；低风险试点自动 validate 需要显式配置 `low_risk_pilot_skills` allowlist，且不会放宽 auto-accept
- V2 实测轻收口：近期只收口 `crossFileConsistency` 精度与 auditor capability matching 测试；reflection-only taxonomy / reasonCode 作为后续观察项；baseline-free auto-accept readiness 已评估但不采纳
- 暂不建议广泛自治放开：自动 accept 仍受配置、风险分层、动态风险、稳定性、validation readiness 与 audit evidence 共同约束

## 里程碑

| 日期 | 里程碑 | 主要功能实现 |
| --- | --- | --- |
| 2026-05-26 | Workflow 控制面稳定化 | Job dashboard / timeline 恢复文档、可恢复事件流、阶段 3 操作清单、workflow 观测约定。 |
| 2026-05-27 | 前端恢复状态与 CTA 契约 | recovery state 语义、retry / resume / cancel CTA 行为、stream replay 预期、前端 workflow 状态契约。 |
| 2026-05-28 | Goal Mode 与 Skill 基础层规划 | Goal mode 执行规划、任务拆解方向、skill-aware planner / install 设计收口、旧任务清理。 |
| 2026-05-29 | Skill 自进化 v1 控制面 | outcome capture、reflection record、proposal generator、auditor gate、deployment validation、decision / rollback、Ops summary、SKILL.md 结构治理、dynamic risk 基础。 |
| 2026-05-30 | Runtime Replay Validation checkpoint | deterministic isolated manifest replay、replay job events、candidate workflow materialization、manual `stage=executed` validation report、自动 pipeline runtime replay opt-in、readiness / auto-accept gate 更新。 |
| 2026-06-13 | dao-run 鲁棒性与桌面端基础 | 修复 dao-run CLI 静默失败、添加 PreToolUse hook 保护 CLAUDE.md、修复构建竞态。新增 Electron 桌面端基础、skill auditor 风险分层、全面测试覆盖。 |
| 2026-06-13b | 代码库优化与治理加固 | 从 index.ts 提取 CLI/Doctor（减少 576 行）、修复 crossFileConsistency 精度、改进 auditor capability matching 增加 token-level 回退、添加 insufficient_evidence reasonCode、对齐 CLAUDE.md 与实现、清理 docs/（26 份归档，新增开发者指南）、扩展 E2E 测试、添加 agents/README 与 timeline.ts 重构说明。构建通过，223/223 单元测试全绿。 |
| 2026-06-13c | 架构拆分：路由层四模块化 | 提取 `src/server/skill-evolution-routes.ts`（715行/13 handler）、`goal-routes.ts`（452行/11 handler）、`job-routes.ts`（1052行/17 handler）、`chat-routes.ts`（821行/3 handler+7 builder）。index.ts 7531→5586行。构建通过，223/223 测试全绿。 |
系统围绕两个模型角色构建：

- `planner`：更强的规划模型，负责理解目标、拆解步骤、审计进展、决定重试，并生成最终答案
- `executor`：更便宜或更本地化的执行模型，负责文件 I/O、shell、搜索、抓取等确定性工具工作

默认情况下，配置仍然是一个 `planner` 加一个 `executor`。同时，运行时已经支持兼容式多模型扩展：

- 保留原有顶层 `planner` / `executor` 配置
- 可选地在 `models` 下注册更多模型
- 可选地通过 `model_routing.planner_candidates` 和 `model_routing.executor_candidates` 声明候选队列
- 旧配置会自动归一化为 `planner.default` 和 `executor.default`
- 支持两套 executor 准入方式：主动探测式诊断，以及运行时惰性筛选

当前实现同时支持：

- 通过 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 直接作为聊天接口使用
- 通过 `/v1/jobs` 作为一等任务执行入口使用

## 当前状态

项目现在已经是一套可运行的编排服务，而不只是 CLI 原型。当前代码库具备：

- OpenAI / Anthropic 风格聊天接口
- 异步 job 创建与持久化 job 记录
- task mode 与 team mode 执行
- planner / executor 迭代历史、task runs、artifacts 与 verification 结果
- SSE 实时 workflow 事件流
- workflow plan 解析、校验与执行
- runtime DAG 摘要与 replan 历史
- 浏览器 job / goal dashboard 与 timeline 页面
- Cherry Studio 友好的进度镜像
- 文件写入校验，避免“模型说已保存，但磁盘并未落盘”
- 检索类步骤的多模型惰性 warmup：首个真实搜索/抓取步骤可以顺带完成候选 executor 的准入筛选

## 架构

- `src/orchestrator.ts`：planner / executor 主循环、协议修正、证据检查、executor 轮换与惰性筛选
- `src/tools.ts`：本地工具与搜索 / 抓取 / 文件执行
- `src/workflow-runtime.ts`：workflow 执行与 replan 流程
- `src/workflow-plan.ts`：workflow plan schema 解析与校验
- `src/index.ts`：HTTP 路由装配 + 核心执行（5586行）
- `src/server/`：路由模块
  - `shared.ts`：共享 HTTP 工具
  - `skill-evolution-routes.ts`：Skill Evolution API（715行）
  - `goal-routes.ts`：Goal CRUD（452行）
  - `job-routes.ts`：Job CRUD + Stream（1052行）
  - `chat-routes.ts`：Chat/Responses/Messages（821行）
- `src/cli/`：CLI 入口
  - `entry.ts`：main、server、task/team/dao-run 执行器
  - `doctor.ts`：配置诊断
- `src/goals-dashboard.ts`：goal dashboard 渲染
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

- 文件路径默认相对 `workspace root` 解析
- 工具产物默认落到 `runtime/command-results/`
- Windows 下 `shell_command` 优先使用 PowerShell

## 配置

可以先以 `config/example.config.yml` 为模板，再复制成 `config/config.yml`。

最小示例：

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

把密钥放进 `.env`：

```env
PLANNER_API_KEY=your-planner-api-key
EXECUTOR_API_KEY=your-executor-api-key
SEARCH_API_KEY=optional-search-api-key
```

说明：

- 运行时默认加载 `config/config.yml`
- `config/example.config.yml` 只是模板，不会自动加载
- `npm run config:validate` 与 `npm run doctor` 默认会校验 `config/config.yml`

### 多模型配置

推荐启用方式：

1. 先保留现有 `planner` / `executor` 配置不动
2. 再按需在 `models` 下注册额外模型
3. 最后在 `model_routing` 中声明候选队列

示例：

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

兼容规则：

- 只有顶层 `planner` / `executor` 的旧配置仍然可直接运行
- 旧配置会自动归一化到 `planner.default` / `executor.default`
- 运行时物化仍从路由队列里的第一个 executor 候选开始
- team mode 里的 per-agent 路由仍然有效，它和全局 executor 候选池是两层不同能力

### 健康检查与模型准入

当前 executor 候选有两套准入路径，不同入口行为不同：

- CLI `task` / `team`：执行前仍会先做一轮轻量主动探测
- `GET /health`：也会做主动探测，并返回这轮探测的诊断结果
- `POST /v1/jobs`：不再默认先做一轮完整 preflight probe
- 对检索型 executor 步骤，首个真实 `web_search` / `url_fetch` 步骤可以并发试投所有候选 executor；能正确响应的模型会被保留为后续备选队列

当前行为：

- 目前只有 `executor` 候选池接入了这套健康 / 准入逻辑
- 主动探测使用最小化 chat-completions 请求
- 惰性筛选使用首个真实检索请求作为准入信号
- 健康、成功 warmup 的候选会保留在执行队伍中
- 不健康、禁用、坏 JSON、无响应或协议异常的候选会被排除
- 如果在当前策略下所有 executor 候选都失败，会提前失败

当全部 executor 候选不可用时，当前契约是：

- 运行时会抛出 `NoHealthyExecutorError`
- job 失败事件会带 `failure_category: "environment_failure"`
- job 失败事件还会带 `healthy_executor_ids` 与 `executor_health_results`
- 同步 `POST /v1/jobs` 当前会返回 HTTP `500`

### `doctor`、`/health`、`/v1/models` 的区别

这三个入口职责不同：

- `npm run doctor`：偏配置诊断，显示候选队列、可写性、路由摘要和建议项；不会做实时逐模型探测
- `GET /health`：偏主动探测诊断。现在返回：
  - `executor.configured_candidates`
  - `executor.active_probe.*`
  - `executor.runtime_lazy_selection`
  其中 `runtime_lazy_selection` 只是说明性字段，用来告诉调用方“运行时惰性筛选存在，但这里不是持久缓存结果”
- `GET /v1/models`：偏 API 暴露层的模型路由元数据，不是实时健康结果

## 安装与运行

```powershell
npm install
npm run build
npm run config:validate
```

运行一次 CLI 任务：

```powershell
node --enable-source-maps dist/index.js "Write a markdown file named notes/todo.md with three deployment tasks."
```

启动本地服务：

```powershell
npm run serve
```

默认地址：

- `http://127.0.0.1:9898`

推荐先检查：

- jobs dashboard：`http://127.0.0.1:9898/jobs/dashboard`
- goals dashboard：`http://127.0.0.1:9898/goals/dashboard`
- health：`http://127.0.0.1:9898/health`

桌面控制台：

```powershell
npm run desktop
```

Desktop UI 会启动内置本地 API，并嵌入执行、Jobs、Goals、Skill Ops 与 Health 页面。`模型` 页可以直接编辑常用模型路由、`config/config.yml` 与 `.env` 中的 `PLANNER_API_KEY`、`EXECUTOR_API_KEY`、`SEARCH_API_KEY`、`EXECUTOR_REMOTE_API_KEY`，保存后会重启内置服务，适合首次配置和新手体验。

快速自检：

```powershell
npm run doctor
```

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

Goal 控制面：

- `GET /v1/goals`
- `GET /v1/goals/data`
- `GET /v1/goals/dashboard`
- `POST /v1/goals`
- `GET /v1/goals/:id`
- `GET /v1/goals/:id/events`
- `GET /v1/goals/:id/timeline`
- `POST /v1/goals/:id/run-next`
- `POST /v1/goals/:id/retry`
- `POST /v1/goals/:id/resume`
- `POST /v1/goals/:id/review`

浏览器内置页面：

- `GET /jobs/dashboard`
- `GET /jobs/data`
- `GET /jobs/:id`
- `GET /jobs/:id/events`
- `GET /jobs/:id/stream`
- `GET /jobs/:id/timeline`
- `POST /jobs/:id/resume`
- `GET /goals/dashboard`
- `GET /goals/data`
- `GET /goals/:id`
- `GET /goals/:id/events`
- `GET /goals/:id/timeline`

## 多模型使用提示

- `GET /health` 是主动探测型实时健康入口
- `GET /v1/models` 更适合查看对客户端暴露的路由信息
- `POST /v1/jobs` 现在更偏向运行时惰性 executor 准入，而不是一律先做完整探测
- CLI `task` / `team` 入口仍然保留显式 preflight probe

## 流式模式

当前有两类不同的流式体验：

1. 标准模型流

- 使用 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`
- 保持与常规 OpenAI / Anthropic 客户端的协议兼容
- 默认不会直接注入原始 `workflow.*` SSE 事件
- 可以把 planner / executor 进度镜像为普通文本增量，方便 Cherry Studio 等通用客户端显示

2. Workflow 流

- 使用 `/v1/jobs/:id/stream`
- 面向前端 UI 输出归一化 workflow 事件
- 适合 dashboard、timeline 与协作视图
- 支持通过 `Last-Event-ID` 恢复 SSE 连接
- 支持从 `since_seq` 回放
- 在 `job.event` 条目中输出 SSE `id:` 字段

回放契约：

- `GET /v1/jobs/:id/events?since_seq=N` 返回 `seq > N` 的事件
- `GET /v1/jobs/:id/stream?since_seq=N` 会先回放 `seq > N` 的事件，再进入实时订阅
- `GET /v1/jobs/:id/stream` 携带请求头 `Last-Event-ID: N` 时，会从 `seq > N` 继续
- `job.snapshot` 包含 `replay.next_seq`、`replay.can_resume_from`、`replay.resumed_from_seq` 与 `replay.replayed_count`
- 具备恢复语义的 `job.snapshot` 还会包含 `follow`、`actions` 与 `snapshot.recovery`

兼容路由可以显式开启原始 workflow SSE 事件：

- `include_workflow_events: true`
- 或请求头 `x-dual-agent-workflow-events: true`

## 异步 Jobs

`POST /v1/jobs` 支持为前端客户端创建异步 job。

典型行为：

- `policy.async = true` 返回 `202`
- 响应包含 `job_id`、`stream_url`、`events_url` 与 `timeline_url`
- job 会在后台继续执行
- 客户端可以订阅 `/v1/jobs/:id/stream` 获取实时进度

## 前端进度体验

当前进度系统同时服务于自定义前端与通用聊天客户端：

- `/v1/jobs/:id/events` 与 `/stream` 提供归一化 workflow UI 事件
- 阶段式进度状态包括 `planning`、`research`、`evidence`、`filtering`、`synthesis` 与 `writing`
- 聚合工具摘要，避免重复 `web_search` 或 `url_fetch` 调用刷屏
- 标准聊天流中提供卡片式文本进度
- 内置 DAG lanes，展示真实依赖图，而不是简单任务列表
- `/v1/jobs/:id/timeline` 支持 superseded workflow lanes 与 replan history 聚焦交互
- 内置 runtime analysis 面板，用于查看验证结果、artifact 活动、工具活动与常见阻塞点
- analysis chips 支持点击筛选，并跳转到匹配事件与关联 workflow lanes
- timeline URL 可保留 `workflowFocus`、`analysisFilter` 与 `analysisValue`
- 支持 `job.redirect`、`snapshot.follow`、`snapshot.actions` 与 `snapshot.recovery` 等恢复感知前端信号
- `/jobs/dashboard` 可在浏览器中查看持久化 jobs，无需手动设置认证头
- `/goals/dashboard` 可在浏览器中查看持久化 goals，并暴露 goal-mode 续跑控制

聊天流中的镜像进度示例：

```text
[Step 2 | Research]
Completed 3 search rounds, gathered 30 candidate results, and is filtering trustworthy sources.

[Step 3 | Evidence]
Read 5 saved artifacts and is extracting the key details.
```

## 报告 / 文件输出校验

运行时会防止本地交付物的“假完成”。

如果任务包含类似要求：

- "write a markdown report to local"
- "save `report.md`"
- "write `D:\...\report.md`"

那么仅有 planner 的 `final` 答复已经不够。只有满足以下条件，任务才会完成：

- executor 实际执行了 `write_file`
- 写入目标与请求的输出路径匹配

## 日志与持久化

每次运行都会产生：

- `runtime/logs/` 下的 JSONL trace 日志
- `runtime/jobs/` 下的持久化 job 记录
- `runtime/command-results/` 下的工具产物

日志包含：

- planner 请求与解析后的决策
- executor 请求与解析后的结果
- 原生工具调用的开始 / 完成事件
- 协议修正、恢复与循环检测事件

## 测试

```powershell
npm run test
```

定向测试：

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e-lite
```

## 已知边界

- 浏览器 dashboard 当前仍以一次列表响应加载数据；极大的 job 历史后续适合增加分页
- 目前只有 executor 候选池接入了健康筛选；planner 候选池还没有同级别准入逻辑
- `npm run doctor` 不做实时逐模型探测；要看主动 probe 结果请用 `/health`
- `/health` 里的 `runtime_lazy_selection` 目前是说明性字段，不是服务器持久缓存
- planner 仍依赖上游模型自身可靠性
- web search 质量高度依赖 provider 质量与查询质量
- 部分网页仍可能因为 JS 渲染或 `403/401/429` 受限，因此证据综合有时会降级
- 通用聊天客户端对流式换行的处理不同，文本进度显示可能仍有差异

## 推荐客户端模式

通用客户端：

- 使用 `/v1/chat/completions`
- 开启 `stream: true`
- 依赖镜像文本进度

自定义应用：

- 通过 `POST /v1/jobs` 创建 job
- 订阅 `/v1/jobs/:id/stream`
- 通过 `/v1/jobs/:id/events` 做回放或刷新
- 存储最后看到的 SSE `id`，并用 `Last-Event-ID` 重连
- 打开 `/v1/jobs/:id/timeline` 查看内置可视化
- 使用 `/jobs/dashboard` 查看零配置浏览器 job 视图
- 使用 `/goals/dashboard` 查看零配置浏览器 goal 视图
- 打开 `/v1/goals/:id/timeline` 查看 goal-mode 执行可视化

## 致谢

- [Linux.do](https://linux.do/)
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/)
