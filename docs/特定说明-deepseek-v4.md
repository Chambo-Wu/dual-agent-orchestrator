# 【历史归档】特定说明：deepseek-v4

> 文档状态：特定集成说明，旧版能力快照。
>
> 本文面向特定模型接入与一次性项目说明，不是面向读者的主入口文档。
> 若需了解当前推荐用法、默认端口、控制面接口与兼容行为，请优先阅读 [README](../README.md) 和 [Readme-CN](../Readme-CN.md)。
> 文中关于 “MVP 骨架 / 不是生产级 agent 系统” 的描述属于早期状态；当前项目已具备 job / workflow / goal / skill evolution 控制面。

● 这是 Dual Agent Orchestrator，一个将 Planner（规划器）+ Executor（执行器）模式实现为可运行骨架的 TypeScript 项目。

  核心设计

  - Planner（规划器）：更强的模型，通过 Web API 调用，负责理解任务、制定计划和生成最终答案
  - Executor（执行器）：本地模型，具备原生 tool calling 能力，负责稳定、结构化地执行具体步骤
  - Tools：确定性的本地工具，包括文件读写、文件列表和 Shell 命令执行

  技术栈

  - 语言：TypeScript (ES2022 + NodeNext 模块)
  - 依赖：零运行时依赖，仅用 @types/node 和 typescript 做开发依赖
  - 协议：OpenAI-compatible API，同时提供 /v1/chat/completions、/v1/responses 和 /v1/messages（Anthropic 风格）三种端点

  工作流程

  1. 用户输入自然语言任务
  2. Planner 理解任务，拆解为步骤，决定调用哪个工具
  3. Executor 执行工具调用（read_file / write_file / list_files / shell_command）
  4. Planner 根据执行结果决定下一步，或生成最终答案
  5. 循环直到任务完成

  项目结构

  ┌────────────────────────────────────┬─────────────────────────────────────┐
  │                文件                │                职责                 │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/config.ts                      │ 加载 YAML 配置                      │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/prompts.ts                     │ Planner 和 Executor 的 prompt 模板  │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/providers/openai-compatible.ts │ OpenAI 兼容的对话客户端             │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/executor-adapter.ts            │ 将 Executor 的推理输出规范化为 JSON │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/tools.ts                       │ 本地工具注册和执行                  │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/orchestrator.ts                │ 连接 Planner 和 Executor 的步骤循环 │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ src/index.ts                       │ CLI 入口和本地 API 服务             │
  ├────────────────────────────────────┼─────────────────────────────────────┤
  │ config/example.config.yml          │ 模型配置示例                        │
  └────────────────────────────────────┴─────────────────────────────────────┘

  特色功能

  - 本地 API 服务：npm run serve 启动 http://127.0.0.1:9898，对外暴露标准 OpenAI/Anthropic 兼容接口
  - Circuit breaker：Planner 上游连续失败 3 次后自动熔断 60 秒，返回 503
  - 自定义模型映射：通过 DUAL_AGENT_MODELS 环境变量暴露多个模型 ID
  - JSONL 日志：每次运行在 runtime/logs/ 下记录 Planner、Executor 和工具执行的完整 trace
  - 安全隔离：文件 IO 限制在 runtime/ 目录内，Shell 命令有超时保护

  当前定位

  这是一个 MVP 骨架，不是生产级 agent 系统。已实现双模型配置、Planner/Executor 分离、结构化 JSON
  契约、确定性工具执行，但还缺少重试机制、流式支持、持久化记忆、Web 工具和安全护栏等功能。
