# 专项路线：Automation Risk Tiering

- 日期：2026-05-29
- 主题：Skill 自进化中的 `Automation Risk Tiering`
- 目标：建立“哪些 skill 可以自动推进到哪一步”的分层策略，避免把所有 skill 一刀切地进入 auto_accept
- 上游依赖：
  - `Proposal Generator`
  - `Auditor Gate`
  - `Deployment Validation`
  - `Observability / Control Plane`
- 下游影响：
  - `auto_reflect`
  - `auto_propose`
  - `auto_audit`
  - `auto_validate`
  - `auto_accept`

## 1. 问题定义

当前自动链已经存在，但还缺硬风险分层。

也就是说，现在的问题不是“能不能自动跑”，而是：

> 哪些 skill 可以自动跑到 proposal，哪些只能自动到 validate，哪些绝不能自动 accept？

如果没有 risk tiering：

- 低风险 skill 会被过度保守处理
- 高风险 skill 会被过早自动化

## 2. 当前状态

### 2.1 已实现

- 已支持：
  - `auto_reflect`
  - `auto_propose`
  - `auto_audit`
  - `auto_validate`
  - `auto_accept`
- 已能通过配置开关控制自动链。

### 2.2 当前局限

- 还没有“仅低风险 skill 允许 auto_accept”的硬约束。
- risk tier 还没有成为配置或代码中的一等对象。
- 控制面还不能直接展示 auto-accept eligibility。
- 高风险 coding skill 暂无内建保护层。

## 3. 专项目标

本专项要解决的是：

1. skill 风险如何定义。
2. 每个风险层级允许自动推进到哪里。
3. 哪些硬信号决定是否允许继续自动推进。

## 4. 风险层级建议

### Tier 1：Low Risk

典型例子：

- `find.workspace_files`
- `find.official_sources`

特点：

- discovery / evidence oriented
- 对 live code 改动影响低
- verification 相对清晰

### Tier 2：Medium Risk

典型例子：

- template / verification / prompt guidance 类 skill

特点：

- 会影响执行路径
- 但不直接改高风险产物

### Tier 3：High Risk

典型例子：

- 直接参与 coding / code modification 的 skill

特点：

- 影响代码修改行为
- 回归成本高
- 需要更强验证与人工审阅

## 5. 自动化边界建议

### Tier 1

可考虑允许：

- `auto_reflect`
- `auto_propose`
- `auto_audit`
- `auto_validate`
- `auto_accept`

前提：

- auditor 通过
- validation 为可信 replay
- 近期无高频失败

### Tier 2

可考虑允许：

- `auto_reflect`
- `auto_propose`
- `auto_audit`
- `auto_validate`

默认不允许：

- `auto_accept`

### Tier 3

可考虑允许：

- `auto_reflect`
- `auto_propose`

视情况允许：

- `auto_audit`

默认不允许：

- `auto_validate` 自动放行后直接 accept
- `auto_accept`

## 6. 分阶段推进

## Phase 1：风险模型固化

### 目标

先把 risk tiering 从口头约束变成正式模型。

### 工作项

1. 定义 risk tier schema。
2. 明确 skill 与 risk tier 的映射方式。
3. 明确每个 tier 的 automation ceiling。
4. 明确需要哪些 gating signals。

### 验收

- 存在正式 risk tier 定义。
- 每个 skill 至少有默认 tier。

## Phase 2：控制面与配置接入

### 目标

让 risk tiering 进入配置与 observability。

### 工作项

1. 在配置中增加 tier-aware automation policy。
2. 在 `/health` 暴露风险与自动化摘要。
3. 在 dashboard / proposal 视图显示 auto-accept eligibility。
4. 在 accepted / rejected history 中保留 automation decision 原因。

### 验收

- risk tier 不再只存在文档里。
- 操作人可以看见 proposal 为什么不能自动推进。

## Phase 3：执行门控接入

### 目标

让自动链真正受 risk tier 控制。

### 工作项

1. 在 auto pipeline 中增加 tier-aware gating。
2. 对高风险 skill 强制人工 accept。
3. 对 repeated failure / unstable replay 加阻断。
4. 对 missing replay confidence 的 proposal 阻止 auto_accept。

### 验收

- 高风险 skill 无法因简单配置误开而直接 auto_accept。
- 低风险 skill 可更顺畅闭环。

## Phase 4：动态风险信号

### 目标

让 risk tier 不只是静态分类，还能受运行表现影响。

### 工作项

1. 引入近期失败率信号。
2. 引入 replay stability 信号。
3. 引入 audit/validation failure cluster 信号。
4. 对异常波动 skill 临时降级自动化权限。

### 验收

- 自动化策略能根据真实运行稳定性动态收紧。

## 7. 建议文件与代码落点

- `src/config.ts`
- `src/config-schema.ts`
- `src/index.ts`
- `src/skill-evolution-types.ts`
- `src/jobs-dashboard.ts`
- `src/timeline.ts`
- `test/unit/config.test.ts`
- `test/integration/observability.api.test.ts`

## 8. 测试策略

### 单元测试

- skill -> risk tier 映射
- tier-aware automation ceiling
- high-risk skill auto_accept blocked
- low-risk skill auto_accept allowed

### 集成测试

- auto pipeline 在不同 tier 下的行为
- `/health` 与 dashboard 暴露 tier 信息
- accept decision 带 automation gating 原因

## 9. 风险与边界

### 主要风险

1. risk tier 过粗，难以覆盖复杂 skill。
2. 只靠静态 tier，忽略运行稳定性。
3. 配置过多，导致策略难理解。
4. 高风险 skill 的人工门槛仍可能被绕开。

### 边界

- 本专项不负责 validator 的真实性建设。
- 本专项依赖可信 auditor 与 validation 信号。
- 本专项重点是“自动推进边界”，不是“proposal 内容质量”。

## 10. 完成标志

满足以下条件时，可认为 Automation Risk Tiering 专项进入“可控自动化 v2”：

1. risk tier 成为正式配置与控制面对象。
2. 每个 tier 有明确 automation ceiling。
3. 高风险 skill 默认无法 auto_accept。
4. 低风险 skill 可在可信验证下自动闭环。

## 11. 下一步建议

最值得先做的是：

1. 先固化 risk tier schema。
2. 再把 tier-aware gating 接到 auto pipeline。
3. 最后再补动态风险信号。
