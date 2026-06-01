# 【部分完成】专项路线：Observability / Control Plane

- 日期：2026-05-29
- 主题：Skill 自进化中的 `Observability / Control Plane`
- 目标：把 skill 自进化从“已有 API 和事件”推进到“可运营、可治理、可追踪、可决策”的完整控制面
- 上游依赖：
  - `Outcome Capture`
  - `Reflection Classifier`
  - `Proposal Generator`
  - `Auditor Gate`
  - `Deployment Validation`
  - `Decision / Rollback`
- 下游影响：
  - 运维治理
  - proposal 审批效率
  - 自动化风险控制

## 1. 问题定义

当前已经有：

- proposal / audit / validate / accept / reject API
- events / stream / timeline / dashboard / `/health`

但这些能力仍主要是“能看见”，还不是“能运营”。

现在缺的不是接口数量，而是：

1. 是否有专门面向操作人的 evolution 视角。
2. 是否能快速回答“卡在哪里、为什么卡、该先处理什么”。
3. 是否能支撑后续自动化分层放开。

## 2. 当前状态

### 2.1 已实现

- reflection 与 skill evolution 生命周期事件已接入。
- `/events` / `/stream` 已能 replay。
- timeline 已能展示 skill reflection / skill evolution 事件。
- dashboard 与 `/health` 已暴露基础汇总。

### 2.2 当前局限

- 没有专门的 proposal queue 管理视图。
- 没有 accepted history 运营视图。
- 没有 rollback guide 展示入口。
- `/health` 对 skill evolution 的积压、风险、老化信息还不够细。
- 缺少 proposal funnel 与 stuck-state 监控。

## 3. 专项目标

本专项的目标不是继续“加字段”，而是建立一层真正可运营的控制面：

1. 面向开发者，可查单个 proposal 的生命周期。
2. 面向维护者，可看整体 funnel 与积压。
3. 面向自动化，可输出风险和 readiness 信号。

## 4. 目标能力拆解

### 4.1 Proposal Queue View

需要能回答：

- 当前有哪些 proposal 在 `draft / auditing / validated / rejected / accepted`
- 哪些 proposal 卡得最久
- 哪些 skill 最近频繁出现 proposal

### 4.2 Accepted History / Rollback View

需要能回答：

- 某个 skill 最近接受过哪些 proposal
- live skill 最近一次被谁、因为什么接受
- rollback snapshot 在哪里
- 是否存在标准恢复路径

### 4.3 Funnel / Aging / Failure Distribution

需要能回答：

- proposed -> audited -> validated -> accepted 转化率
- audit fail / validation fail 的主因分布
- 哪些 proposal 长时间没有进入下一阶段

### 4.4 Health / Safety Signals

需要输出：

- proposal count
- audit failed count
- validation failed count
- accepted count
- last proposal time
- stuck proposals
- aging buckets
- top risky skills

## 5. 分阶段推进

## Phase 1：控制面信息模型收口

### 目标

先统一 evolution 控制面的信息模型，避免后续 UI 与 API 各自生长。

### 工作项

1. 统一 proposal summary shape。
2. 明确 dashboard list item 需要哪些 evolution 字段。
3. 明确 `/health` 应提供哪些聚合字段。
4. 明确 timeline 与 proposal queue 的职责边界。

### 验收

- evolution summary 能被 API、dashboard、timeline 共用。
- 控制面字段不再分散重复定义。

## Phase 2：Proposal Queue / History 视图

### 目标

提供专门的 evolution 管理视图，而不是完全依赖 timeline。

### 工作项

1. 增加 proposal queue 页面或数据接口。
2. 增加 accepted history 视图。
3. 增加 proposal detail 视图入口。
4. 为 rollback snapshot 暴露可见路径与说明。

### 验收

- 不打开单个 job timeline，也能管理 proposal。
- 操作人能快速找到最近 accepted proposal 与 rollback 信息。

## Phase 3：Funnel / Aging / Failure Analytics

### 目标

让 evolution control plane 能解释“为什么没推进”。

### 工作项

1. 增加 proposal funnel 指标。
2. 增加 aging buckets。
3. 增加 audit fail / validation fail reason 分类统计。
4. 增加 per-skill evolution activity 统计。

### 验收

- dashboard 能展示 evolution 漏斗。
- 能快速看出卡点集中在哪个阶段。

## Phase 4：Automation Readiness Signals

### 目标

为后续自动 accept / risk tiering 提供控制面信号。

### 工作项

1. 暴露 skill-level risk / stability summary。
2. 暴露 proposal readiness / auto-accept eligibility。
3. 对高风险 skill 明确标记人工审阅要求。
4. 增加 stuck automation / repeated failure 提示。

### 验收

- 控制面可直接支撑分层自动化策略。
- 高风险 skill 不会被 UI 误导成“可放心自动接受”。

## 6. 建议文件与代码落点

- `src/index.ts`
- `src/jobs-dashboard.ts`
- `src/dashboard.ts`
- `src/timeline.ts`
- `src/workflow-ui-events.ts`
- `test/unit/dashboard-ui.test.ts`
- `test/unit/config.test.ts`
- `test/integration/observability.api.test.ts`

## 7. 测试策略

### 单元测试

- evolution summary 渲染
- proposal funnel 渲染
- accepted history summary 渲染
- `/health` evolution 聚合字段

### 集成测试

- proposal list / detail API
- events / stream replay consistency
- dashboard evolution 区块展示
- accepted / rejected 后的历史可见性

## 8. 风险与边界

### 主要风险

1. 控制面字段持续膨胀，模型不统一。
2. timeline 与专门 queue 视图职责重叠。
3. funnel 只显示数量，不显示原因，运营价值有限。
4. 控制面过早绑定具体 UI 形态。

### 边界

- 本专项不负责 proposal 内容质量。
- 本专项不负责 validator 本身的真实性。
- 本专项重点是“治理可见性”，不是“生成能力”。

## 9. 完成标志

满足以下条件时，可认为 Observability / Control Plane 专项进入“运营可用 v2”：

1. 存在专门 proposal queue 视图或等价接口。
2. 存在 accepted history / rollback guide 可见入口。
3. dashboard 能展示 proposal funnel 与 aging。
4. `/health` 能输出 evolution 风险与积压摘要。

## 10. 下一步建议

最值得先做的是：

1. 先统一 evolution summary schema。
2. 再补 proposal queue / accepted history。
3. 最后补 funnel 与 automation readiness。
