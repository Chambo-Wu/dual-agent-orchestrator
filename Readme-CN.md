# Dual Agent Orchestrator 中文说明

Dual Agent Orchestrator 是一套通用的 `planner + executor` 多模型协作运行时，当前已经同时提供：

- OpenAI 兼容聊天接口
- Anthropic 风格 `messages` 接口
- 面向长任务的 job 控制面
- 面向前端展示的实时 workflow 事件流

English documentation: [README.md](./README.md)

## 当前状态

项目已经不再只是一个 CLI 原型，当前代码库已经具备：

- 异步 job 创建与持久化
- planner / executor 步骤历史、artifact 与运行日志
- `/v1/jobs/:id/events` 与 `/v1/jobs/:id/stream` 实时事件流
- `/v1/jobs/:id/timeline` 内置时间线页面
- `workflow_plan` 的解析、校验与 runtime 执行
- workflow DAG 摘要输出，支持 active / superseded lane
- runtime replan 历史保留与前端消费
- timeline 内置 dependency graph 视图，而不只是任务列表
- timeline 内置 replan 与 graph 的聚焦联动
- 面向 Cherry Studio 等通用聊天客户端的进度镜像
- 防止“模型声称已写文件，但磁盘实际上没有落盘”的写入校验

里程碑上可以认为：

- Milestone C 已经基本收口
- 下一阶段更适合归入 Milestone D，重点会是 workflow UX、可观测性和更深的前端交互

## 核心结构

- `src/orchestrator.ts`：planner / executor 主循环
- `src/index.ts`：HTTP API、job 控制面、事件与响应组装
- `src/tools.ts`：本地工具、搜索、抓取、文件执行
- `src/workflow-plan.ts`：workflow plan schema 解析与校验
- `src/workflow-runtime.ts`：workflow runtime 执行与 replan
- `src/workflow-graph.ts`：DAG / superseded lane / replan history 视图数据生成
- `src/workflow-ui-events.ts`：面向前端的标准化事件
- `src/timeline.ts`：timeline HTML 与 DAG 交互视图
- `runtime/jobs/`：持久化 job 记录
- `runtime/logs/`：每次运行的 JSONL 日志
- `runtime/command-results/`：工具产物

## 当前前端能力

当前前端进度展示分成两层：

1. 通用聊天客户端

- 可通过 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 获取标准协议输出
- 可把内部 workflow 进度镜像成更友好的文本流

2. 自定义前端 / 任务面板

- 可通过 `/v1/jobs/:id/stream` 订阅标准化 workflow 事件
- 可通过 `/v1/jobs/:id/events` 做刷新与回放
- 可通过 `/v1/jobs/:id/timeline` 直接查看内置可视化

其中 timeline 页面已经支持：

- DAG lane 展示
- 真实 dependency graph 边渲染
- 当前任务高亮
- hover 依赖链高亮
- superseded workflow 独立 lane
- replan history 与 graph 联动聚焦

## 安装与运行

```powershell
npm install
npm run build
npm run config:validate
```

启动本地服务：

```powershell
npm run serve
```

默认地址：

- `http://127.0.0.1:9898`

## 测试

```powershell
npm run test
```

按类别运行：

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e-lite
```

## 下一步方向

接下来的重点更偏向 Milestone D：

- 继续增强 workflow timeline / DAG / replan 的前端体验
- 增加更细粒度的 replan、artifact、verifier 可观测性
- 扩展 team-mode 与更复杂的 workflow task 类型
