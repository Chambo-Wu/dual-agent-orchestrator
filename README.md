# Dual Agent Orchestrator

**本地优先、多模型协同的 Agent Workflow 运行时。简配即用，纵深可扩展。**

[English](./README-EN.md) · [文档导航](./docs/文档索引-导航页-20260529.md) · [开发者指南](./docs/开发者入门-架构与开发指南-20260613.md)

---

## 一句话说清

将强模型（规划）和便宜模型（执行）拆分为独立角色，通过异步 Job 控制面和可恢复工作流引擎，让本地模型也能稳定完成多步骤复杂任务。

---

## 为什么选择它

| 需求 | 常见痛点 | 本项目的做法 |
|---|---|---|
| 本地模型能力不足 | 单模型执行多步任务容易丢失上下文或偏离目标 | Planner 拆解→Executor 执行→Verifier 校验，每步有据可查 |
| 任务中断无法恢复 | 断电/崩溃后只能重来 | Job 粒度的 resume/retry，事件流可 replay |
| 多模型管理复杂 | 换模型要改代码 | YAML 配置候选队列，运行时健康检查自动剔除不可用模型 |
| 长任务看不到进度 | 黑盒等待 | 实时 SSE 事件流 + 浏览器 Dashboard/Timeline |
| 文件写入不可靠 | "模型说已保存"但磁盘空 | 内置落盘校验，未成功写入不报告完成 |

---

## 核心概念

```
用户任务 → Planner（拆解步骤，审计进展）
              ↓
         Executor（文件 I/O、Shell、搜索、抓取等确定性工具）
              ↓
         Verifier（检查输出真实性、充分性、合规性）
              ↓
         Job 控制面（持久化、可恢复、可观测）
```

### 多层协同模式

| 模式 | 适用场景 | 角色参与 |
|---|---|---|
| Task | 单步实现类任务 | Planner + Executor |
| Team | 多角色协同（分解→执行→评审→汇总） | Planner + 多个 Worker + Reviewer |
| Goal | 目标导向自动拆解 | Goal Planner + Workflow Engine |
| Workflow | 预定义 DAG 执行 | 按 Plan Schema 自动调度 |

### 关键设计决策

- **本地优先**：模型跑在本地，数据不出机器
- **协议兼容**：同时暴露 OpenAI Chat、Anthropic Messages、Responses API 三种接口形态
- **Job 一等公民**：每个任务持久化为 Job，支持跨进程 resume/retry/replan
- **Skill 自进化**：从执行结果中学习，生成改进提案，经审计→验证→决策闭环
- **保守自治**：自动 accept/validate 默认关闭，需显式配置 allowlist 并由多层风险约束

---

## 技术栈

```
语言：      TypeScript（strict mode）
运行时：    Node.js ≥ 20
构建：      tsc
测试：      node:test（223 单元测试 + 集成 + E2E）
配置：      YAML（多模型候选队列、策略开关）
桌面端：    Electron（基础可用）
Agent 层：  Claude Code CLI 入口（/dao-run、/dao-exec）
```

---

## 架构一览

```
HTTP 层
├── /v1/chat/completions    OpenAI 兼容聊天
├── /v1/messages             Anthropic 风格聊天
├── /v1/responses            OpenAI Responses API
├── /v1/jobs/*               Job CRUD + 事件流 + Timeline
├── /v1/goals/*              Goal CRUD + Dashboard
├── /v1/skills/*             Skill 管理
├── /v1/skill-evolution/*    Skill 自进化控制面
└── /health, /jobs/dashboard  运维面板

执行引擎
├── src/orchestrator.ts       Planner/Executor 主循环
├── src/workflow-runtime.ts   Workflow DAG 执行与 Replan
├── src/team.ts               Team Mode 多 Agent 协同
└── src/tools.ts              12 个内置工具

Skill 自进化
├── src/skill-evolver.ts           Proposal 生成
├── src/skill-auditor.ts           Auditor Gate
├── src/skill-deployment-validator.ts   部署验证
├── src/skill-evolution-store.ts   持久化层
└── src/skill-replay-runtime.ts    Replay 执行
```

---

## 30 秒上手

```powershell
git clone <repo>
npm install
npm run build

# 复制配置模板
copy config\example.config.yml config\config.yml

# 编辑 config.yml 填入你的模型地址
# 编辑 .env 填入 API Key

# 启动服务
npm run serve
# → http://127.0.0.1:9898

# 或直接 CLI 执行单次任务
node dist/index.js "写一个 markdown 文件 notes/plan.md，列出三个优化方向"
```

打开浏览器：
- Jobs Dashboard：`http://127.0.0.1:9898/jobs/dashboard`
- Goals Dashboard：`http://127.0.0.1:9898/goals/dashboard`
- Health Check：`http://127.0.0.1:9898/health`

---

## 里程碑

| 日期 | 里程碑 |
|---|---|
| 2026-05-26 | Workflow 控制面稳定化 |
| 2026-05-29 | Skill 自进化 v1 完整闭环 |
| 2026-05-30 | Runtime Replay 确定验证 |
| 2026-06-13 | dao-run 鲁棒性 + Electron 桌面端 + 审计分层 |
| 2026-06-13b | 代码库优化：index.ts 模块化、crossFileConsistency 精度、审计匹配改进、文档清理 |

---

## 致谢

- [Linux.do](https://linux.do/)
- [Xiaomi MiMo Orbit](https://100t.xiaomimimo.com/)
