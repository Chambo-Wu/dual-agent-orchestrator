# 专项路线：Auditor Gate

- 日期：2026-05-29
- 主题：Skill 自进化中的 `Auditor Gate`
- 目标：把当前 v1 auditor 从“基础安全门”推进到“面向风险分层、结构约束、跨文件一致性”的稳定审计层
- 上游依赖：
  - `Proposal Generator`
  - `Candidate Materialization`
- 下游影响：
  - `Deployment Validation`
  - `Decision / Rollback`
  - `Automation Risk Tiering`

## 1. 问题定义

当前 auditor 已能拦住明显危险 proposal，但它还主要是 v1 静态与策略检查。

真正的下一步问题是：

1. proposal 质量提升后，auditor 是否还能给出稳定、清晰的约束。
2. 不同风险 skill 是否应使用同一套 audit 强度。
3. markdown 与 manifest 是否需要更细粒度一致性检查。

## 2. 当前状态

### 2.1 已实现

- manifest schema 校验
- markdown 结构校验
- tool scope escalation 校验
- install source escalation 校验
- runtime strategy escalation 校验
- secret / leakage 检查
- patch scope 检查
- reflection-to-patch consistency
- executable verification contract 检查

### 2.2 当前局限

- markdown 检查仍偏存在性校验。
- 缺少跨文件一致性校验。
- 没有按 skill 风险等级区分 audit policy。
- 对 verification 变更还没有更细约束。
- 对 changelog / provenance / candidate metadata 尚未纳入审计。

## 3. 专项目标

本专项要把 auditor 变成：

1. proposal generator 的硬边界。
2. deployment validation 之前的策略门。
3. 自动 accept 之前的低成本安全筛子。

## 4. 目标能力拆解

### 4.1 Structure-Aware Markdown Audit

从“有没有 `Core Procedure / Appendix`”升级到：

- body 是否改到了不该改的位置
- `execution_lapse` 是否只触达 appendix
- `Scenario Extensions` 是否被合理使用

### 4.2 Manifest Change Policy

按字段类型区分：

- 完全禁止
- 白名单允许
- 高风险需人工审阅

### 4.3 Cross-File Consistency Audit

需要检查：

- `skill.json` 描述是否与 `SKILL.md` 明显漂移
- verification 变更是否与 markdown guidance 相匹配
- activation / template 变更是否有足够说明

### 4.4 Risk-Tiered Audit

不同 risk tier 对 proposal 的容忍度不同：

- 低风险 discovery skill
- 中风险 template / verification skill
- 高风险 coding skill

## 5. 分阶段推进

## Phase 1：审计契约固化

### 目标

把现有 auditor 的规则从“代码实现”收口成“策略契约”。

### 工作项

1. 列出 audit check catalog。
2. 为每个 check 标注风险级别与失败后果。
3. 统一 audit failure summary 结构。
4. 明确哪些 check 是硬失败，哪些可配置。

### 验收

- auditor checks 有明确目录。
- audit report 可稳定解释失败原因。

## Phase 2：结构感知审计增强

### 目标

让 auditor 真正理解 `SKILL.md` 双结构。

### 工作项

1. 强化 body / appendix 目标段落审计。
2. 增加 `Scenario Extensions` 合规检查。
3. 增加 reflection kind 对应修改面审计。
4. 增加空改动 / 虚假改动检测。

### 验收

- `execution_lapse` 改 body 会被稳定拒绝。
- 结构化 proposal 的错误改写能被 auditor 捕获。

## Phase 3：跨文件一致性与 verification 审计

### 目标

把 auditor 从单文件检查推进到候选整体一致性检查。

### 工作项

1. 检查 markdown 与 manifest 描述是否一致。
2. 检查 verification contract 变更是否有对应说明。
3. 检查 remediation copy 是否与 failure mode 相符。
4. 为 activation priority / template reference 变更加备注审计。

### 验收

- proposal 不再能靠“改一个文件骗过另一个文件”的方式通过审计。

## Phase 4：Risk-Tier Aware Audit

### 目标

让 audit policy 支持未来自动化分层。

### 工作项

1. 建立 skill risk tier -> audit profile 映射。
2. 高风险 skill 增加更严格 check。
3. 低风险 skill 保持轻量但不失守。
4. 输出 human review required 信号。

### 验收

- auditor 已能为 auto_accept 提供清晰 gating 信号。

## 6. 建议文件与代码落点

- `src/skill-auditor.ts`
- `src/skill-evolution-types.ts`
- `src/skill-manifest-schema.ts`
- `src/skill-evolution-store.ts`
- `test/integration/observability.api.test.ts`
- 可选新增：
  - `test/unit/skill-auditor.test.ts`

## 7. 测试策略

### 单元测试

- reflection-to-patch consistency
- body / appendix 误改检测
- manifest 白名单 / 黑名单字段检测
- cross-file consistency 检测

### 集成测试

- 安全 proposal audit pass
- tool scope escalation fail
- runtime strategy escalation fail
- markdown 结构错位 fail
- verification drift fail

## 8. 风险与边界

### 主要风险

1. auditor 过度复杂化，维护成本高。
2. proposal generator 升级后，auditor 规则滞后。
3. 高风险 skill 与低风险 skill 使用同一强度导致误阻塞。
4. 审计报告可读性下降。

### 边界

- auditor 不负责证明 candidate 真能改善执行。
- auditor 负责“能不能进入验证”，不是“是否最终接受”。

## 9. 完成标志

满足以下条件时，可认为 Auditor Gate 专项进入“稳定 v2”：

1. audit check catalog 完整清晰。
2. markdown 双结构有结构感知审计。
3. 存在跨文件一致性审计。
4. 存在 risk-tier aware audit policy。

## 10. 下一步建议

最值得先做的是：

1. 先写 check catalog。
2. 再补双结构结构感知审计。
3. 最后接 risk-tier aware gating。
