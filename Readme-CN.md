# Dual Agent Orchestrator 中文说明

Dual Agent Orchestrator 是一套本地优先的 `planner + executor` 多模型协作运行时，当前提供：

- OpenAI 兼容聊天接口
- Anthropic 风格 `messages` 接口
- 面向长任务的 job 控制面
- 面向前端的实时 workflow 事件流
- 内置 dashboard 与 timeline 页面

English documentation: [README.md](./README.md)

## 概览

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
- 浏览器 dashboard 与 timeline 页面
- Cherry Studio 友好的进度镜像
- 文件写入校验，避免“模型说已保存，但磁盘并未落盘”
- 检索类步骤的多模型惰性 warmup：首个真实搜索/抓取步骤可以顺带完成候选 executor 的准入筛选

## 架构

- `src/orchestrator.ts`：planner / executor 主循环、协议修正、证据检查、executor 轮换与惰性筛选
- `src/tools.ts`：本地工具与搜索 / 抓取 / 文件执行
- `src/index.ts`：HTTP API、chat adapter、job 控制面、浏览器路由
- `src/workflow-runtime.ts`：workflow 执行与 replan 流程
- `src/workflow-plan.ts`：workflow plan schema 解析与校验
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

- dashboard：`http://127.0.0.1:9898/jobs/dashboard`
- health：`http://127.0.0.1:9898/health`

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
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/events`
- `GET /v1/jobs/:id/stream`
- `GET /v1/jobs/:id/timeline`
- `POST /v1/jobs/:id/cancel`
- `POST /v1/jobs/:id/retry`
- `POST /v1/jobs/:id/approve`
- `POST /v1/jobs/:id/resume`

## 多模型使用提示

- `GET /health` 是主动探测型实时健康入口
- `GET /v1/models` 更适合查看对客户端暴露的路由信息
- `POST /v1/jobs` 现在更偏向运行时惰性 executor 准入，而不是一律先做完整探测
- CLI `task` / `team` 入口仍然保留显式 preflight probe

## 已知边界

- 目前只有 executor 候选池接入了健康筛选；planner 候选池还没有同级别准入逻辑
- `npm run doctor` 不做实时逐模型探测；要看主动 probe 结果请用 `/health`
- `/health` 里的 `runtime_lazy_selection` 目前是说明性字段，不是服务器持久缓存
