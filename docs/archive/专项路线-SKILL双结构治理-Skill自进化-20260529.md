# 【部分完成】专项路线：SKILL.md 双结构治理

- 日期：2026-05-29
- 主题：Skill 自进化中的 `SKILL.md` 双结构治理
- 目标：把全量可演化 skill 的 `SKILL.md` 收口到稳定的双结构约定，使 proposal、auditor、validator 都有统一可依赖的编辑对象
- 上游依赖：
  - skill 基础目录治理
- 下游影响：
  - `Proposal Generator`
  - `Candidate Materialization`
  - `Auditor Gate`
  - `Deployment Validation`

## 1. 问题定义

现在最大的基础设施缺口之一不是逻辑代码，而是文档结构不统一。

如果 skill 的 `SKILL.md` 没有统一结构，那么：

- proposal generator 无法稳定按段落编辑
- auditor 只能做弱检查
- validator 很难判断 candidate 改动是否真的命中目标区域

所以双结构治理是整个自进化链条的“文档地基”。

## 2. 当前状态

### 2.1 已实现

- candidate `SKILL.md` 已支持：
  - `Core Procedure`
  - `Scenario Extensions`
  - `Appendix`
- 没有 live `SKILL.md` 时也能 scaffold candidate。
- auditor 已检查 `Core Procedure / Appendix` 是否存在。

### 2.2 当前局限

- 不是所有 live skill 都已有稳定双结构。
- 不同 skill 文风与段落职责仍可能不一致。
- `Scenario Extensions` 还没有成为真正受控中间层。
- 缺少全量治理计划与迁移标准。

## 3. 专项目标

本专项目标是把 `SKILL.md` 从“自由文本说明”提升为“受控、可编辑、可审计的 skill contract 文档”。

## 4. 目标结构

建议统一为：

```md
# Skill: <skill_id>

## Core Procedure
...

## Scenario Extensions
...

## Appendix
...
```

映射关系：

- `Core Procedure`
  - 对应 `S_body`
- `Appendix`
  - 对应 `S_appendix`
- `Scenario Extensions`
  - 作为受控中间层，承接可复用场景

## 5. 段落职责约束

### 5.1 Core Procedure

用于：

- 稳定主步骤
- 高频、通用、基础动作

不用于：

- 单次案例注释
- 局部异常碎片

### 5.2 Scenario Extensions

用于：

- 重复出现但非所有场景通用的可复用模式
- 有条件触发的特殊分支

不用于：

- 替代主流程
- 累积随意 appendix note

### 5.3 Appendix

用于：

- pitfalls
- reminders
- evidence expectations
- execution-lapse style补充

不用于：

- 重新定义主流程

## 6. 分阶段推进

## Phase 1：结构约定固化

### 目标

先把双结构约定形成正式标准。

### 工作项

1. 统一 heading 命名。
2. 明确三段职责说明。
3. 补 README / 中文文档说明。
4. 为新 skill 模板默认采用该结构。

### 验收

- 新增或更新 skill 时有明确模板可遵循。

## Phase 2：现有 skill 全量盘点

### 目标

盘点哪些 skill 已符合、部分符合、不符合。

### 工作项

1. 建立 skill inventory。
2. 为每个 skill 标记：
   - compliant
   - partial
   - missing
3. 列出迁移优先级。

### 验收

- 全量 skill 的双结构状态一目了然。

## Phase 3：分批迁移

### 目标

按风险分层推进现有 skill 的 `SKILL.md` 治理。

### 优先级建议

1. 低风险 discovery / research skill
2. 中风险 workflow/template skill
3. 高风险 coding skill

### 工作项

1. 为缺失 `SKILL.md` 的 skill 补模板。
2. 为已有但结构不统一的 skill 重构段落。
3. 保留语义，不做无必要内容发散。
4. 为每个迁移 skill 记录 changelog。

### 验收

- 首批低风险 skill 全量符合双结构。
- proposal generator 能稳定命中目标段落。

## Phase 4：治理自动化

### 目标

把双结构治理从“人工约定”升级为“工具约束”。

### 工作项

1. 在 auditor 中强化结构职责检查。
2. 在模板生成中默认写入标准结构。
3. 增加 lint / check 脚本或等价校验。
4. 对不合规 skill 发出控制面提醒。

### 验收

- 不合规 `SKILL.md` 会被尽早发现，而不是等 proposal 时才暴露。

## 7. 建议文件与代码落点

- `skills/*/SKILL.md`
- `README.md`
- `Readme-CN.md`
- `src/skill-auditor.ts`
- `src/skill-evolution-store.ts`
- 可选新增：
  - `scripts/check-skill-markdown-structure.*`

## 8. 测试与检查策略

### 文档检查

- heading 是否齐全
- heading 名称是否统一
- 空段落是否存在

### 代码测试

- auditor 对缺失结构的响应
- candidate scaffold 行为
- proposal 生成对结构化 skill 的稳定性

## 9. 风险与边界

### 主要风险

1. 迁移过程中误改 skill 语义。
2. 为统一结构而引入过度模板化文本。
3. 高风险 coding skill 的语义重构成本过高。

### 边界

- 本专项主要是结构治理，不追求重写 skill 内容本身。
- 不要求一次性把所有 skill 全量改完。

## 10. 完成标志

满足以下条件时，可认为 SKILL 双结构治理专项进入“基础完备 v2”：

1. 有正式双结构标准。
2. 有全量 skill 合规盘点。
3. 首批低风险 skill 已全部迁移。
4. auditor / generator 已能稳定依赖该结构。

## 11. 下一步建议

最值得先做的是：

1. 先列 skill inventory。
2. 再迁移低风险 skill。
3. 最后把结构检查前移到日常治理里。
