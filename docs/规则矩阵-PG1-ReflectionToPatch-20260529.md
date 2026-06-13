> **DEPRECATED**: 本文档已完成历史使命，当前请参考 [规划-Skill自进化V2-20260601.md](./规划-Skill自进化V2-20260601.md) 或 [文档索引](./文档索引-导航页-20260529.md)。

# 【已完成】规则矩阵：PG-1 Reflection-to-Patch

- 日期：2026-05-29
- 范围：Proposal Generator 的 `PG-1`
- 目标：把 `SkillReflectionRecord -> Proposal Patch` 的映射规则正式化，作为后续 proposal 生成、auditor、validator 的共同契约
- 关联文档：
  - [执行清单-ProposalGenerator开发任务-20260529.md](/d:/Android/dual-agent-orchestrator/docs/执行清单-ProposalGenerator开发任务-20260529.md)
  - [专项路线-ProposalGenerator-Skill自进化-20260529.md](/d:/Android/dual-agent-orchestrator/docs/专项路线-ProposalGenerator-Skill自进化-20260529.md)
  - [集成设计草案-Skill自进化接入本仓库-20260529.md](/d:/Android/dual-agent-orchestrator/docs/集成设计草案-Skill自进化接入本仓库-20260529.md)

## 1. 作用

这份矩阵解决的是一个很核心的问题：

> 当 reflection 已经被判成某一类时，proposal 到底允许改哪里、推荐改哪里、绝不能改哪里？

如果这层不明确，后面会出现三种问题：

1. Proposal Generator 产出不稳定。
2. Auditor 被迫替 proposal generator 兜底。
3. Validator 很难判断 candidate 是否真的命中改进目标。

## 2. 基本原则

所有 patch 生成都必须遵循以下原则：

1. 先改 `SKILL.md`，后考虑 `skill.json`。
2. 先改最小目标段落，不跨段落泛化扩写。
3. `Core Procedure` 对应 `S_body`。
4. `Appendix` 对应 `S_appendix`。
5. `Scenario Extensions` 只承接“可复用但非主流程”的场景，不替代主流程。
6. `skill.json` 只能做白名单字段微调，不能扩权。

## 3. 目标修改面定义

## 3.1 文档层

- `Core Procedure`
  - 稳定主流程
  - 高频、通用、基础步骤
- `Scenario Extensions`
  - 条件触发的复用场景
  - 特定模式下的补充执行路径
- `Appendix`
  - pitfalls
  - reminders
  - evidence expectations
  - execution-lapse 风格补充

## 3.2 Manifest 层

允许白名单微调：

- `verification.artifactLabels`
- `verification.successSignalLabel`
- `verification.remediation.insufficient`
- `verification.remediation.failed`
- `activation.priority`
- 有限 template references

默认禁止：

- `requiredTools`
- `optionalTools`
- `install.source`
- `execution.strategy`
- `execution.runtimeEntry`

## 4. Reflection-to-Patch 主矩阵

| Reflection Kind | 推荐动作 | Core Procedure | Scenario Extensions | Appendix | skill.json 白名单微调 | 默认目标 |
|---|---|---|---|---|---|---|
| `discovery` | 扩充可复用场景 | 可改 | 优先可改 | 可补 | 谨慎允许 | 先 `Scenario Extensions`，再视情况补 `Core Procedure` |
| `optimization` | 优化主流程 | 优先可改 | 可选 | 可补 | 谨慎允许 | 先 `Core Procedure` |
| `skill_defect` | 修正文档/契约缺陷 | 优先可改 | 可选 | 可补 | 必要时允许 | 先 `Core Procedure`，必要时补 verification/remediation |
| `execution_lapse` | 补执行提醒 | 禁止 | 默认禁止 | 优先可改 | 默认禁止 | 只改 `Appendix` |

## 5. 每类 reflection 的详细规则

## 5.1 `discovery`

### 定义

skill 成功了，而且验证通过，但暴露出了一个值得沉淀的新场景、新套路或新证据模式。

### 目标

把“新发现”沉淀成可复用 guidance，而不是重写主流程。

### 允许改动

- `Scenario Extensions`
  - 首选
- `Core Procedure`
  - 仅当新发现已经足够通用，适合进入稳定主流程
- `Appendix`
  - 可补提醒或证据要求
- `skill.json`
  - 仅在需要补充 verification labels / remediation copy 时谨慎允许

### 默认策略

1. 先尝试写入 `Scenario Extensions`
2. 如果该场景明显属于所有类似任务的稳定步骤，再提升到 `Core Procedure`
3. 如果只是易忘提示，写入 `Appendix`

### 禁止事项

- 不因为一次成功案例就大规模重写主流程
- 不把单次案例细节硬编码到 `Core Procedure`

## 5.2 `optimization`

### 定义

skill 成功了，而且验证通过，但执行过程低效、绕路、重试多、证据组织差。

### 目标

优化主流程顺序、表达和证据组织，而不是追加零散注释。

### 允许改动

- `Core Procedure`
  - 首选
- `Scenario Extensions`
  - 仅在优化仅适用于特定条件时可用
- `Appendix`
  - 可补一条简短 reminder
- `skill.json`
  - 可谨慎补 remediation / verification labels，但不应成为主改动面

### 默认策略

1. 优先改 `Core Procedure`
2. 如果优化只适用于某类上下文，放进 `Scenario Extensions`
3. Appendix 只做提醒，不承载主优化逻辑

### 禁止事项

- 把核心优化内容只写进 `Appendix`
- 用大量例外说明替代主流程优化

## 5.3 `skill_defect`

### 定义

skill 被实际使用了，但当前 skill contract 仍然无法稳定满足 verification，且失败不是因为“忘了按 skill 做”。

### 目标

修正 skill 本身的 procedure 或 verification/remediation contract。

### 允许改动

- `Core Procedure`
  - 首选
- `Scenario Extensions`
  - 当 defect 仅在特定子场景触发时可用
- `Appendix`
  - 可补 known failure pattern
- `skill.json`
  - 必要时允许白名单微调：
    - remediation text
    - verification labels
    - activation priority
    - 有限 template reference

### 默认策略

1. 先改 `Core Procedure`
2. 如果 defect 是条件式问题，再补 `Scenario Extensions`
3. 仅在 procedure 修正仍不足以表达时，才微调 `skill.json`

### 禁止事项

- 不允许借“修 defect”扩大工具权限
- 不允许通过降低 verification 强度伪造成功
- 不允许把主 defect 只写成 appendix note

## 5.4 `execution_lapse`

### 定义

skill 本身看起来未必错，主要问题是执行过程中漏做关键步骤、漏抓 artifact、漏 readback、漏 primary-source 检查。

### 目标

补执行提醒与证据要求，而不是修改主流程 contract。

### 允许改动

- `Appendix`
  - 唯一默认改动面

### 谨慎允许

- 无

### 默认策略

1. 只追加 `Appendix`
2. 明确写出：
   - 容易遗漏的步骤
   - 必须出现的 evidence
   - readback / verification reminders

### 默认禁止

- 改 `Core Procedure`
- 改 `Scenario Extensions`
- 改 `skill.json`

### 例外条件

只有在后续人工复盘明确发现当前分类误判，不应为 `execution_lapse` 时，才允许转入其他 patch 策略。

## 6. RecommendedAction 到 patch 面的映射

| recommendedAction | 允许 patch 面 | 默认 patch 面 | 禁止 patch 面 |
|---|---|---|---|
| `append_appendix` | `Appendix` | `Appendix` | `Core Procedure`、`skill.json` |
| `patch_body` | `Core Procedure`、`Scenario Extensions`、有限 `Appendix` | `Core Procedure` | 默认不改 `skill.json` |
| `patch_verification` | 白名单 `skill.json`、有限 `Core Procedure` | `skill.json` 白名单字段 | 扩权字段、runtime escalation |
| `no_change` | 无 | 无 | 所有 patch 面 |

## 7. Patch 级别规则

## 7.1 Patch Scope Rule

proposal 生成应遵循“最小有效修改”：

1. 先改单段落
2. 再改同文件多段落
3. 最后才考虑 markdown + manifest 联动

默认不应直接生成“多文件大改 proposal”。

## 7.2 Patch Promotion Rule

信息写入位置遵循：

1. 单次易忘提醒 -> `Appendix`
2. 可复用条件场景 -> `Scenario Extensions`
3. 稳定高频主步骤 -> `Core Procedure`

## 7.3 Patch Escalation Rule

当 proposal 同时想修改：

- `Core Procedure`
- `Appendix`
- `skill.json`

必须满足：

1. reflection 类型不是 `execution_lapse`
2. patch reason 可解释
3. auditor 可以机械验证其合法性

## 8. skill.json 微调矩阵

| 字段 | discovery | optimization | skill_defect | execution_lapse |
|---|---|---|---|---|
| `verification.artifactLabels` | 谨慎允许 | 谨慎允许 | 允许 | 禁止 |
| `verification.successSignalLabel` | 谨慎允许 | 谨慎允许 | 允许 | 禁止 |
| `verification.remediation.insufficient` | 谨慎允许 | 允许 | 允许 | 禁止 |
| `verification.remediation.failed` | 谨慎允许 | 允许 | 允许 | 禁止 |
| `activation.priority` | 谨慎允许 | 谨慎允许 | 谨慎允许 | 禁止 |
| template references | 谨慎允许 | 谨慎允许 | 谨慎允许 | 禁止 |
| `requiredTools` | 禁止 | 禁止 | 禁止 | 禁止 |
| `install.source` | 禁止 | 禁止 | 禁止 | 禁止 |
| `execution.strategy` | 禁止 | 禁止 | 禁止 | 禁止 |

## 9. 生成器默认决策顺序

Proposal Generator 在收到 reflection 后，默认按以下顺序决策：

1. 识别 `reflectionKind`
2. 读取 `recommendedAction`
3. 决定主 patch 面：
   - appendix
   - body
   - verification
4. 决定是否需要 `Scenario Extensions`
5. 决定是否触发 `skill.json` 白名单微调
6. 生成 candidate markdown / manifest
7. 生成 patch summary / rationale summary

## 10. 对 auditor 和 validator 的约束意义

这份矩阵不是只给 Proposal Generator 用的。

它同时意味着：

### 对 auditor

- 可以检查 reflection 与 patch 面是否一致
- 可以检查 `execution_lapse` 是否越界改 body
- 可以检查 `skill_defect` 是否违规触发扩权 manifest 变更

### 对 validator

- 可以判断 candidate 是否真的在修目标问题
- 可以区分：
  - 目标命中但无改善
  - 连目标 patch 面都没命中

## 11. PG-1 验收条件

PG-1 可视为完成，当且仅当：

1. 四类 reflection 都有明确 patch policy。
2. `recommendedAction -> patch 面` 有明确映射。
3. `skill.json` 白名单矩阵明确。
4. Proposal Generator、Auditor、Validator 都可引用同一套规则。

## 12. 下一步建议

PG-1 完成后，建议立刻进入：

1. `PG-2`
   - 抽统一 proposal generator 策略入口
2. `PG-3`
   - 把 `SKILL.md` 段落级改写正式接上这套矩阵
3. `PG-4`
   - 把 `skill.json` 白名单 patch policy 接进实现
