# 【部分完成】专项路线：Proposal Generator

- 日期：2026-05-29
- 主题：Skill 自进化中的 `Proposal Generator`
- 目标：把当前 v1 的最小安全 proposal 生成，推进到“按 reflection 类型分策略、按 `S_body / S_appendix` 结构编辑、可解释且可验证”的候选生成器
- 上游依赖：
  - `Outcome Capture`
  - `Reflection Classifier`
- 下游影响：
  - `Candidate Materialization`
  - `Auditor Gate`
  - `Deployment Validation`
  - `Observability / Control Plane`

## 1. 问题定义

当前 proposal generation 已经能工作，但仍主要停留在：

- 生成 proposal record
- 生成 patch summary / patch text
- 生成 candidate snapshot
- 对 `SKILL.md` 做有限结构化补写

当前缺口主要不在“有没有 proposal”，而在“proposal 质量是否足够高、是否足够稳定、是否真的体现 reflection 意图”。

## 2. 当前状态

### 2.1 已实现

- 能从 reflection 生成 proposal。
- 能生成 candidate dir。
- 能把 `SKILL.md` 候选文档落成 `Core Procedure / Scenario Extensions / Appendix` 结构。
- 缺失 live `SKILL.md` 时，也能 scaffold candidate markdown。

### 2.2 当前局限

- 仍偏 v1 最小安全改写，不是高质量 skill rewrite。
- `Discovery / Optimization / SkillDefect / ExecutionLapse` 还没有真正分策略生成。
- `skill.json` 的微调策略还不够清晰，更多是保守复制。
- 还没有形成“proposal generation policy”这类明确契约。
- 还没有独立的 proposal quality 回归测试集。

## 3. 专项目标

这个专项不追求“一步到位做成通用智能重写器”，而是分三层推进：

1. 先把规则做清楚。
2. 再把生成质量做稳定。
3. 最后再评估是否引入更独立的 `skill-evolver` 模块或 meta-skill。

## 4. 目标能力拆解

### 4.1 Reflection-to-Patch Mapping

要建立明确映射：

- `discovery`
  - 允许补 `Core Procedure`
  - 允许补 `Scenario Extensions`
  - 允许补 `Appendix`
- `optimization`
  - 主要改 `Core Procedure`
  - 可补少量 `Appendix`
- `skill_defect`
  - 主要改 `Core Procedure`
  - 必要时允许白名单 verification/remediation 微调
- `execution_lapse`
  - 默认只允许 append 到 `Appendix`

### 4.2 S_body / S_appendix Strategy

要把草案中的 `S_body / S_appendix` 约束正式化：

- `Core Procedure` 对应 `S_body`
- `Appendix` 对应 `S_appendix`
- `Scenario Extensions` 作为中间层，承接复用场景，而不是污染稳定 body

### 4.3 skill.json Patch Policy

要建立白名单：

- 允许：
  - verification labels
  - remediation text
  - activation priority
  - template references
- 默认不允许：
  - `requiredTools`
  - `install.source`
  - `execution.strategy`

### 4.4 Proposal Quality Contract

proposal 生成结果至少要满足：

1. 与 reflection 类型一致。
2. 改动范围可解释。
3. 能 materialize 成真实 candidate 文件。
4. 不依赖 auditor 来替 proposal 补基本正确性。

## 5. 分阶段推进

## Phase 1：规则固化

### 目标

把 proposal generation 从“代码里隐含策略”提升为“明确规则”。

### 工作项

1. 建立 reflection-to-patch mapping matrix。
2. 明确 `SKILL.md` 三段结构的修改职责。
3. 明确 `skill.json` 白名单字段。
4. 补 proposal generation 的设计注释与文档入口。

### 验收

- 不同 reflection 类型的 proposal 差异是可预测的。
- `execution_lapse` 不再误改 body。
- `skill_defect` 可以稳定落到 body 改动。

## Phase 2：结构化生成增强

### 目标

把当前“有限 scaffold”提升到“有策略的结构化候选生成”。

### 工作项

1. 对已有 `SKILL.md` 做段落内定向插入，而不是泛化 append。
2. 区分：
   - 新增场景
   - 修正文案
   - 强化验证说明
3. 为 candidate markdown 生成差异摘要。
4. 为 `skill.json` 微调建立更稳定 merge 逻辑。

### 验收

- proposal 对应的 candidate diff 更聚焦。
- 同类 reflection 的 patch 风格一致。
- `SKILL.md` 修改不再轻易污染无关段落。

## Phase 3：质量回归与样本集

### 目标

把 proposal generation 做成可持续迭代的能力，而不是一次性实现。

### 工作项

1. 建立 proposal quality fixtures。
2. 为四类 reflection 各准备正反样本。
3. 增加 candidate content 断言，而不仅是 proposal record 断言。
4. 为高风险 skill 与低风险 skill 分别准备样本。

### 验收

- proposal generator 有专门回归测试集。
- 改一处生成逻辑时能快速发现质量退化。

## Phase 4：评估独立 skill-evolver 形态

### 目标

决定是否要把 generator 升级为独立模块或 meta-skill。

### 可选方向

1. 继续内置在 control plane。
2. 抽成 `src/skill-evolver.ts`。
3. 演进为 `skills/meta.skill_evolver/`。

### 决策标准

- 是否已有足够复杂的生成策略
- 是否需要单独测试和版本化
- 是否需要未来接 LLM-assisted rewrite

## 6. 建议文件与代码落点

- `src/index.ts`
- `src/skill-evolution-store.ts`
- `src/skill-evolution-types.ts`
- `src/skill-auditor.ts`
- `test/integration/observability.api.test.ts`
- 可选新增：
  - `src/skill-evolver.ts`
  - `test/unit/skill-evolver.test.ts`

## 7. 测试策略

### 单元测试

- 按 reflection kind 检查 candidate markdown 的目标段落变化。
- 检查 `execution_lapse` 只改 appendix。
- 检查 `skill_defect` 不会退化成空改动。
- 检查 `skill.json` 仅白名单字段可被调整。

### 集成测试

- 从 reflect -> propose 全链路验证 candidate 输出。
- 验证缺失 live `SKILL.md` 时的 scaffold 行为。
- 验证 proposal 输出可被 auditor / validator 正常消费。

## 8. 风险与边界

### 主要风险

1. proposal overfit 到单个 case。
2. body 与 appendix 职责混乱。
3. `skill.json` 修改面失控。
4. 为了追求“聪明”而降低可预测性。

### 边界

- 本专项不负责真正 replay validation。
- 本专项不负责最终 accept 策略。
- 本专项不默认引入远程 LLM 重写器。

## 9. 完成标志

满足以下条件时，可认为 Proposal Generator 专项进入“稳定 v2”：

1. 四类 reflection 已有明确 patch policy。
2. `SKILL.md` 三段结构修改稳定。
3. `skill.json` 微调有白名单契约。
4. proposal generator 拥有独立回归测试集。
5. auditor 不再频繁承担“替 proposal 发现基础逻辑错误”的职责。

## 10. 下一步建议

这个专项最值得先做的，是：

1. 先写出 mapping matrix。
2. 再补 candidate content 测试。
3. 然后决定是否抽 `src/skill-evolver.ts`。

## 11. PG-8 结论

截至 2026-05-29，`PG-8` 的结论是：

- 保留 `src/skill-evolver.ts` 作为 Proposal Generator 的稳定模块边界。
- 不再把 proposal 生成逻辑回塞到 `src/index.ts`。
- 也暂不继续细拆成更多 proposal 子模块。

原因：

1. proposal 生成、candidate markdown 改写、manifest 白名单生成、摘要生成，已经形成天然同类职责。
2. 现在已有独立单测与 reflect -> propose 集成回归，模块可单独演进。
3. 当前复杂度还没高到必须继续拆分，否则会进入过早结构化。

因此当前推荐做法是：

- `src/skill-evolver.ts` 继续承接 Proposal Generator 规则演进
- `src/skill-evolution-store.ts` 继续承接 snapshot/materialization 持久化
- `src/index.ts` 保持 control plane orchestration，不再承担 candidate 内容后处理
