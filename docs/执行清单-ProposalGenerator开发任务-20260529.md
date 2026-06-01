# 【已完成】执行清单：Proposal Generator 开发任务

- 日期：2026-05-29
- 范围：把 `Proposal Generator` 从专项路线下钻成可直接开发、验证、回归的任务清单
- 关联文档：
  - [专项路线-ProposalGenerator-Skill自进化-20260529.md](/d:/Android/dual-agent-orchestrator/docs/专项路线-ProposalGenerator-Skill自进化-20260529.md)
  - [主骨架与专项推进路线-Skill自进化-20260529.md](/d:/Android/dual-agent-orchestrator/docs/主骨架与专项推进路线-Skill自进化-20260529.md)
  - [总排期页-Skill自进化专项路线-20260529.md](/d:/Android/dual-agent-orchestrator/docs/总排期页-Skill自进化专项路线-20260529.md)

## 1. 目标

本清单的目标不是再写一份设计，而是把 `Proposal Generator` 拆成能直接进入迭代开发的任务。

完成后应达到：

1. 不同 reflection 类型有明确 proposal 生成策略。
2. `SKILL.md` 的 `Core Procedure / Scenario Extensions / Appendix` 修改面稳定。
3. `skill.json` 的可改字段有白名单契约。
4. Proposal Generator 有独立回归测试集。

## 2. 当前基线

当前仓库已经具备这些能力：

- 能从 reflection 创建 proposal record。
- 能生成 candidate dir。
- 能为 candidate `SKILL.md` 生成基础双结构。
- 缺失 live `SKILL.md` 时可以 scaffold。
- 已有 `append_appendix / patch_body / patch_verification` 三类 recommended action。

但还缺：

- reflection-to-patch 正式映射矩阵
- 更细的 candidate 段落级改写策略
- `skill.json` 白名单微调策略
- Proposal Generator 专项回归测试

## 3. 任务总览

| 任务 | 优先级 | 目标 | 依赖 |
|---|---:|---|---|
| PG-1 | P0 | 固化 reflection-to-patch 规则矩阵 | 无 |
| PG-2 | P0 | 抽离 Proposal Generator 策略入口 | PG-1 |
| PG-3 | P0 | 强化 `SKILL.md` 结构化改写 | PG-1 |
| PG-4 | P0 | 建立 `skill.json` 白名单 patch policy | PG-1 |
| PG-5 | P1 | 为 candidate 增加差异摘要与理由摘要 | PG-2, PG-3, PG-4 |
| PG-6 | P1 | 建立 Proposal Generator 单元测试集 | PG-2, PG-3, PG-4 |
| PG-7 | P1 | 建立 reflect -> propose 集成回归测试 | PG-5, PG-6 |
| PG-8 | P2 | 评估是否抽成 `src/skill-evolver.ts` | PG-6 之后 |

## 4. 推荐开发顺序

建议严格按这个顺序开工：

1. `PG-1`
2. `PG-2`
3. `PG-3`
4. `PG-4`
5. `PG-6`
6. `PG-5`
7. `PG-7`
8. `PG-8`

原因：

- 先定规则，再改代码。
- 先稳定生成逻辑，再补摘要。
- 先补单元测试，再补集成回归。
- 是否抽模块放最后，避免过早重构。

## 5. 任务明细

## PG-1：固化 reflection-to-patch 规则矩阵

- 优先级：`P0`
- 状态：`done`
- 目标：把当前隐含在代码里的生成逻辑，收口成明确规则矩阵。

### 作用

统一这四类 reflection 的改动面：

- `discovery`
- `optimization`
- `skill_defect`
- `execution_lapse`

### 建议文件

- `docs/专项路线-ProposalGenerator-Skill自进化-20260529.md`
- 可选新增内部注释：
  - `src/index.ts`
  - `src/skill-evolution-store.ts`
  - 或未来的 `src/skill-evolver.ts`

### 交付物

1. 一个明确 matrix：
   - 哪类 reflection 允许改 body
   - 哪类 reflection 允许改 scenario extensions
   - 哪类 reflection 只允许改 appendix
   - 哪类 reflection 可触发 `skill.json` 白名单微调
2. 一套最小 acceptance rules

### 验收

- 规则矩阵能写成清晰表格。
- 研发、审计、验证三侧可以共用同一规则描述。

### 当前落实

- 已新增规则矩阵文档：
  - [规则矩阵-PG1-ReflectionToPatch-20260529.md](/d:/Android/dual-agent-orchestrator/docs/规则矩阵-PG1-ReflectionToPatch-20260529.md)
- 已覆盖：
  - 四类 `reflectionKind` 的主 patch 面
  - `recommendedAction -> patch 面` 映射
  - `skill.json` 白名单/禁改矩阵
  - 对 auditor / validator 的约束意义

### 风险

- 如果矩阵定义过早过细，后续可能要返工。
- 如果矩阵定义过宽，后面 auditor 会被迫兜底。

## PG-2：抽离 Proposal Generator 策略入口

- 优先级：`P0`
- 状态：`done`
- 目标：把 proposal 生成逻辑从分散实现，收口到单一策略入口。

### 作用

当前 proposal 逻辑散落在：

- [src/index.ts](/d:/Android/dual-agent-orchestrator/src/index.ts)
- [src/skill-evolution-store.ts](/d:/Android/dual-agent-orchestrator/src/skill-evolution-store.ts)

需要统一入口，便于后续测试与演进。

### 建议文件

- 新增：
  - `src/skill-evolver.ts`
- 或第一步先内聚到：
  - `src/index.ts`

### 交付物

1. 统一入口函数，例如：
   - `generateSkillEvolutionProposal(...)`
   - `materializeCandidateFromReflection(...)`
2. 让调用方只关心输入输出，不关心具体 patch 分支。

### 验收

- proposal 生成入口单一。
- `index.ts` 里不再承载太多 proposal 分支细节。

### 当前落实

- 已抽离统一入口：
  - [src/skill-evolver.ts](/d:/Android/dual-agent-orchestrator/src/skill-evolver.ts)
- 当前调用入口：
  - `generateSkillEvolutionProposal(...)`
  - `buildStructuredSkillMarkdownCandidate(...)`
  - `buildCandidateManifestContent(...)`
- 当前责任分布：
  - `src/skill-evolver.ts` 负责生成策略
  - `src/skill-evolution-store.ts` 负责 candidate snapshot 落盘
  - `src/index.ts` 负责 control plane 编排

### 风险

- 过早抽模块可能只是搬代码。
- 如果不先做 PG-1，会把不清晰的规则一起抽走。

## PG-3：强化 `SKILL.md` 结构化改写

- 优先级：`P0`
- 状态：`done`
- 目标：让 `SKILL.md` 候选生成从“基础 scaffold + append”升级到“段落级定向改写”。

### 作用

把当前能力从：

- 生成基础 `Core Procedure / Scenario Extensions / Appendix`

升级到：

- 根据 reflection 类型命中正确段落
- 避免把无关内容污染进 body
- 合理使用 `Scenario Extensions`

### 建议文件

- [src/skill-evolution-store.ts](/d:/Android/dual-agent-orchestrator/src/skill-evolution-store.ts)
- 可选新增：
  - `src/skill-evolver.ts`

### 交付物

1. `Core Procedure` 改写策略
2. `Scenario Extensions` 插入策略
3. `Appendix` 追加策略
4. 缺失 live markdown 时的标准 scaffold 模板

### 验收

- `execution_lapse` 默认只改 appendix。
- `skill_defect` 默认落到 core procedure。
- `discovery` 可定向进入 scenario extensions 或 core procedure。

### 当前落实

- 当前 markdown 改写策略已接入：
  - `discovery`
    - 默认命中 `Scenario Extensions`
    - 非 `append_appendix` 时可同时补 `Core Procedure`
    - 会补 `Appendix`
  - `optimization`
    - 默认命中 `Core Procedure`
  - `skill_defect`
    - 默认命中 `Core Procedure`
    - 有 failed checks 时补 `Appendix`
  - `execution_lapse`
    - 只追加 `Appendix`
- 缺失 live `SKILL.md` 时会生成标准双结构 scaffold。

### 风险

- 如果段落插入策略太粗，会破坏已有 markdown 可读性。
- 如果 `Scenario Extensions` 用法不清晰，会沦为第二个 appendix。

## PG-4：建立 `skill.json` 白名单 patch policy

- 优先级：`P0`
- 状态：`done`
- 目标：明确 proposal generator 对 `skill.json` 能改什么、不能改什么。

### 作用

当前 `skill.json` 更偏保守复制，需要形成正式白名单策略。

### 建议文件

- [src/skill-evolution-store.ts](/d:/Android/dual-agent-orchestrator/src/skill-evolution-store.ts)
- [src/skill-auditor.ts](/d:/Android/dual-agent-orchestrator/src/skill-auditor.ts)
- 可选新增：
  - `src/skill-evolver.ts`

### 交付物

1. 白名单字段定义
2. merge 逻辑
3. 非法字段变更的拒绝策略

### 允许范围建议

- `verification.remediation.*`
- `verification.successSignalLabel`
- `verification.artifactLabels`
- `activation.priority`
- 有限 template references

### 默认禁止

- `requiredTools`
- `optionalTools`
- `install.source`
- `execution.strategy`

### 验收

- proposal generator 不能私自扩权。
- auditor 对 generator 输出的误报减少。

### 当前落实

- 当前 generator 已显式发布白名单策略常量：
  - `PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST`
  - `PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY`
- 当前这套 policy 已上提为共享策略层：
  - [src/skill-evolution-policy.ts](/d:/Android/dual-agent-orchestrator/src/skill-evolution-policy.ts)
  - 由 generator / auditor / validator 共同复用
  - 已包含 `Core Procedure / Scenario Extensions / Appendix` 的段落级 patch 面判断
- 当前实际允许生成的 manifest 微调字段：
  - `verification.artifactLabels`
  - `verification.successSignalLabel`
  - `verification.remediation.insufficient`
  - `verification.remediation.failed`
- 当前默认保持稳定、不会由 generator 私自改动：
  - `requiredTools`
  - `optionalTools`
  - `install.source`
  - `execution.strategy`
  - 其他未进入白名单的 manifest 字段
- `execution_lapse` 已被显式禁止触发 manifest 白名单 patch。

### 风险

- 如果白名单过窄，会限制 proposal 有用改动。
- 如果白名单过宽，会提升安全风险。

## PG-5：增加 candidate 差异摘要与理由摘要

- 优先级：`P1`
- 状态：`done`
- 目标：让 proposal 不止有 patch text，还能有更结构化的“改了什么、为什么改”摘要。

### 作用

方便：

- auditor 理解 proposal
- validator 消费 proposal
- dashboard / queue 展示 proposal

### 建议文件

- `src/skill-evolution-types.ts`
- `src/index.ts`
- `src/skill-evolution-store.ts`

### 交付物

1. candidate diff summary
2. patch rationale summary
3. 面向控制面的简化摘要字段

### 验收

- proposal list 不看全文也能理解变更方向。
- timeline / dashboard 能更好展示 evolution 意图。

### 风险

- 摘要字段过多会加重 schema 负担。

## PG-6：建立 Proposal Generator 单元测试集

- 优先级：`P1`
- 状态：`done`
- 目标：给 proposal generator 建一套独立、可回归的单元测试。

### 作用

这是 Proposal Generator 稳定演进的关键。

### 建议文件

- 新增：
  - `test/unit/skill-evolver.test.ts`
- 或扩展：
  - `test/integration/observability.api.test.ts`

### 覆盖建议

1. `execution_lapse` 只改 appendix
2. `skill_defect` 改 body
3. `discovery` 命中 scenario extensions / appendix
4. 缺失 live `SKILL.md` 时 scaffold 正常
5. `skill.json` 非白名单字段不被生成

### 验收

- proposal generator 有独立测试入口。
- 改动生成逻辑时能快速发现回归。

### 当前落实

- 已有独立测试文件：`test/unit/skill-evolver.test.ts`
- 已有独立测试命令：`npm run test:proposal-generator`
- 已覆盖：
  - `execution_lapse` 只追加 appendix
  - `skill_defect` 命中 body / appendix
  - `discovery` 命中 scenario extensions / appendix
  - 缺失 live `SKILL.md` 时 scaffold 正常
  - `skill.json` 白名单外字段保持稳定
  - proposal 摘要字段生成正常

### 风险

- 如果只测 API，不测 candidate 内容，回归价值不够。

## PG-7：建立 reflect -> propose 集成回归测试

- 优先级：`P1`
- 状态：`done`
- 目标：确保从 reflection 到 proposal 的全链路在真实控制面中稳定。

### 作用

覆盖：

- 反射记录解析
- proposal 创建
- candidate 文件落盘
- control plane 输出

### 建议文件

- [test/integration/observability.api.test.ts](/d:/Android/dual-agent-orchestrator/test/integration/observability.api.test.ts)

### 交付物

1. reflect -> propose 成功链路
2. 缺失 markdown 的 scaffold 链路
3. 不同 recommendedAction 的 candidate 内容断言

### 验收

- 集成测试能覆盖 proposal 关键分支。
- 控制面响应与 candidate 文件内容一致。

### 当前落实

- 已覆盖：
  - reflect -> propose 成功链路
  - 缺失 live `SKILL.md` 的 scaffold 链路
  - `skill_defect` 分支的 body / appendix candidate 内容断言
  - `execution_lapse` 分支的 appendix-only candidate 内容断言
  - proposal list / get 的 control plane 响应断言

### 风险

- 如果集成测试只断言 record，不断言 candidate 内容，问题仍可能漏掉。

## PG-8：评估是否抽成 `src/skill-evolver.ts`

- 优先级：`P2`
- 状态：`done`
- 目标：在规则和测试稳定后，再决定是否抽成独立模块。

### 作用

避免过早重构，但为后续演进预留空间。

### 建议文件

- `src/skill-evolver.ts`
- `src/index.ts`
- `src/skill-evolution-store.ts`

### 决策标准

1. proposal 生成逻辑是否已明显超过一个文件可承载范围
2. 是否已有足够独立测试
3. 是否要引入更复杂 rewrite 策略

### 验收

- 若抽离，则职责边界更清晰。
- 若不抽离，则现有入口也足够可维护。

### 当前结论

- 已抽离并保留 `src/skill-evolver.ts` 作为 Proposal Generator 专用模块。
- 当前边界判断为“够用且清晰”，暂不继续拆成更多子模块。
- 责任分布：
  - `src/skill-evolver.ts`
    - proposal 生成
    - `SKILL.md` candidate 改写
    - `skill.json` candidate 生成
    - proposal 摘要生成
  - `src/skill-evolution-store.ts`
    - proposal / reflection / report 持久化
    - candidate snapshot 落盘
  - `src/index.ts`
    - control plane 编排
    - reflect / propose / audit / validate / accept API

### 决策说明

- 满足“已有独立单测 + 集成回归 + 生成逻辑已形成独立关注点”的抽离条件。
- 目前未出现需要再拆 `manifest rewriter / markdown rewriter / summary builder` 三个子模块的复杂度压力。
- 后续若引入更复杂 rewrite 策略，再考虑二次细分。

## 6. 推荐里程碑

## Milestone PG-A

包含：

- `PG-1`
- `PG-2`

出口条件：

- proposal 生成规则与入口统一

## Milestone PG-B

包含：

- `PG-3`
- `PG-4`

出口条件：

- `SKILL.md` 与 `skill.json` 生成策略稳定

## Milestone PG-C

包含：

- `PG-6`
- `PG-5`
- `PG-7`

出口条件：

- Proposal Generator 进入可回归迭代状态

## Milestone PG-D

包含：

- `PG-8`

出口条件：

- 完成模块化评估并做出明确决策

## 7. 验收总条件

Proposal Generator 开发清单可以视为完成，当且仅当：

1. 已有正式 reflection-to-patch 矩阵。
2. `SKILL.md` 三段结构改写可预测。
3. `skill.json` 有白名单微调契约。
4. proposal generator 有独立单元测试。
5. reflect -> propose 集成回归测试覆盖关键分支。

## 7.1 当前对齐结论

截至 2026-05-29，本清单与仓库实现的对齐情况为：

- `PG-1`：已完成
- `PG-2`：已完成
- `PG-3`：已完成
- `PG-4`：已完成
- `PG-5`：已完成
- `PG-6`：已完成
- `PG-7`：已完成
- `PG-8`：已完成

当前更适合继续推进的方向，不再是 Proposal Generator 主体补空白，而是：

1. 把 PG-1/PG-4 规则继续复用到 auditor / validator 的共享策略层。
2. 让 control plane / dashboard 更直接消费 proposal policy 与 validation summary。
3. 只在出现新的 rewrite 复杂度时，再拆更细的 generator 子模块。

## 8. 建议下一步

最建议立刻继续推进的是：

1. 把 `PG-1 / PG-4` 的规则矩阵接成 auditor / validator 可共用的代码级 policy。
2. 把 proposal policy / validation summary 进一步下沉到 control plane 展示层。
3. 仅在出现更复杂 rewrite 需求时，再评估二次模块拆分。
