# 专项路线：Deployment Validation

- 日期：2026-05-29
- 主题：Skill 自进化中的 `Deployment Validation`
- 目标：把当前 v1 的 candidate-aware heuristic validation，推进到真正可信的 baseline / candidate replay 验证体系
- 上游依赖：
  - `Proposal Generator`
  - `Candidate Materialization`
  - `Auditor Gate`
- 下游影响：
  - `Decision / Rollback`
  - `Automation Risk Tiering`
  - `Observability / Control Plane`

## 1. 问题定义

当前最大的可信度缺口不是“有没有 validate API”，而是：

> 现在还不能充分证明 candidate skill 的改动，真的被注入执行并带来了改善。

也就是说，当前 validation 更像“基于 candidate 文件的非回归启发式判断”，而不是“真实执行对比”。

## 2. 当前状态

### 2.1 已实现

- 已有 `validate` API。
- 已有 `SkillDeploymentValidationReport`。
- 已对比：
  - `candidateSelected`
  - `candidateVerified`
  - baseline / candidate artifact count
  - baseline / candidate failed checks
- 已能阻止明显未改善 proposal 进入 accepted。

### 2.2 当前局限

- 还不是真正 isolated replay。
- baseline input 选择规则还不够正式。
- candidate 注入独立 runtime 的链路还没有。
- `silent_bypass` 还没作为强指标进入验证门槛。
- research skill 与 coding skill 还没有分层验证策略。

## 3. 专项目标

这个专项的目标不是让 validate 更“复杂”，而是让 validate 更“可信”。

核心目标分三层：

1. 证明 candidate 被真实执行了。
2. 证明 candidate 没有比 baseline 更差。
3. 在 baseline 不通过时，证明 candidate 有明确改善。

## 4. 目标能力拆解

### 4.1 Baseline Replay Contract

要明确：

- 哪个 job / case 被选作 replay baseline。
- replay 输入来自哪里。
- baseline 与 candidate 是否使用同一输入。
- 哪些 artifact / verification 结果被计入对比。

### 4.2 Candidate Runtime Injection

要建立明确能力：

- candidate skill 从 proposal dir 注入到隔离 runtime。
- 不覆盖 live `skills/`。
- 可让 runtime 在 candidate skill 上独立执行。

### 4.3 Comparison Contract

对比维度至少应包含：

1. `candidateSelected`
2. `candidateVerified`
3. `silentBypassSignal`
4. artifact completeness
5. failed checks
6. missing requirements
7. replay-time execution evidence

### 4.4 Risk-Tiered Validation

不同 skill 类型要区分：

- 低风险 discovery / research skill
- 高风险 coding / code-modifying skill

高风险 skill 的 validation 不能只看 artifact count 增减。

## 5. 分阶段推进

## Phase 1：验证契约固化

### 目标

先把 validation 的语义说清楚，再升级执行链。

### 工作项

1. 明确 baseline 选择规则。
2. 明确 candidate 改善判据。
3. 明确哪些 comparison 字段属于硬门槛，哪些属于参考信号。
4. 把 `silent_bypass` 纳入 validation contract。

### 验收

- validation report 的语义边界清晰。
- baseline/candidate 的来源可解释。
- 不同失败原因能区分“未执行到 candidate”和“执行了但未改善”。

## Phase 2：Isolated Replay 骨架

### 目标

建立 candidate skill 注入隔离 runtime 的最小执行链。

### 工作项

1. 增加 candidate runtime materialization 入口。
2. 让 replay 明确使用 candidate 目录。
3. 记录 replay job id / runtime source / selected skill source。
4. 在 validation report 中显式标记 replay provenance。

### 验收

- candidate skill 可在隔离路径被执行。
- validation report 能证明“本次 candidate 确实被用到了”。

## Phase 3：真实 baseline/candidate 对跑

### 目标

从“单边 candidate 评估”升级为“baseline 与 candidate 对跑对比”。

### 工作项

1. 同一输入跑 baseline。
2. 同一输入跑 candidate。
3. 统一汇总 verification、artifacts、events。
4. 形成结构化 comparison report。

### 验收

- baseline 与 candidate 的对比来自真实执行，而非仅文件差异。
- validation 失败时能指出是：
  - candidate 未选中
  - candidate 未验证通过
  - candidate 无明显改善
  - candidate 引入回归

## Phase 4：Skill-Type Aware Validation

### 目标

让验证逻辑与 skill 风险类型匹配。

### 工作项

1. 为 research / discovery 类 skill 定义轻量 improvement contract。
2. 为 coding 类 skill 定义更强 non-regression contract。
3. 引入分层 acceptance criteria。
4. 让 validator 能输出 risk-tier aware summary。

### 验收

- 低风险 skill 不被过度阻塞。
- 高风险 skill 不因弱信号而误通过。

## Phase 5：自动化接入前的最终收口

### 目标

让 validation 成为 auto-accept 的可靠门槛。

### 工作项

1. 为 auto_accept 输出更硬的 validation readiness 信号。
2. 增加 replay instability 检测。
3. 增加 candidate flakiness 统计。
4. 与风险分层策略对齐。

### 验收

- auto_accept 不再只依赖启发式 comparison。
- validator 能成为自动化放开的主要安全门。

## 6. 建议文件与代码落点

- `src/skill-deployment-validator.ts`
- `src/skill-evolution-types.ts`
- `src/skill-evolution-store.ts`
- `src/index.ts`
- `src/skill-runtime.ts`
- `src/workflow-runtime.ts`
- 可选新增：
  - `src/skill-replay-runtime.ts`
  - `test/integration/skill-deployment-validator.test.ts`

## 7. 测试策略

### 单元测试

- baseline selection 规则测试
- candidate improvement 判定测试
- `silent_bypass` 对 validation 结果的影响测试
- risk-tier 对 validation contract 的影响测试

### 集成测试

- baseline 与 candidate 同输入对跑
- candidate 注入隔离 runtime
- candidate 改善时通过
- candidate 变差时失败
- candidate 未实际被选中时失败

### 回归测试

- 防止 validator 退回只看文件差异
- 防止高风险 skill 被弱信号误判通过

## 8. 风险与边界

### 主要风险

1. replay 成本过高，拖慢控制面。
2. replay 与真实线上运行语义不一致。
3. baseline case 选取失真，导致验证误导。
4. 高风险 skill 的验证标准仍然偏弱。

### 边界

- 本专项不负责 proposal 生成质量本身。
- 本专项不直接决定 accept policy，但会为 accept policy 提供硬信号。
- 本专项不默认追求全量历史 job 全部可 replay。

## 9. 完成标志

满足以下条件时，可认为 Deployment Validation 专项进入“可信 v2”：

1. candidate skill 可被注入隔离 runtime。
2. baseline / candidate 使用同一 replay 输入。
3. validation report 可证明 candidate 被真实执行。
4. `silent_bypass` 已进入硬性判断。
5. 高低风险 skill 有不同 validation contract。

## 10. 下一步建议

这个专项最值得先做的，是：

1. 先写 baseline replay contract。
2. 再落 candidate runtime injection 最小骨架。
3. 然后补 baseline/candidate 对跑集成测试。
