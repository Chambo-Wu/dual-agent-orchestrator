# 【部分完成】SKILL 双结构 Inventory 与检查方案

- 日期：2026-05-29
- 范围：Subagent C / S3-2 `SKILL.md` 双结构治理设计
- 边界：本方案只定义 inventory 与 check 行为，不迁移现有 skills 内容，不修改 `skills/*` 文件
- 目标：让 live skills 的 `SKILL.md` 状态可盘点、可检查、可分批迁移，并为 Proposal Generator v2 与 Auditor Gate v2 提供统一结构契约

## 1. 当前事实

当前仓库 builtin skills：

| skill id | manifest | live `SKILL.md` | 初始判定 |
|---|---|---:|---|
| `find.official_sources` | `skills/find.official_sources/skill.json` | 缺失 | `missing` |
| `find.workspace_files` | `skills/find.workspace_files/skill.json` | 缺失 | `missing` |
| `find.integration_points` | `skills/find.integration_points/skill.json` | 缺失 | `missing` |
| `find.code_symbol` | `skills/find.code_symbol/skill.json` | 缺失 | `missing` |

补充说明：

- 当前 Proposal Generator 已能在 candidate 侧 scaffold `SKILL.md`。
- Auditor v1 已能检查 candidate 中的 `Core Procedure / Appendix` 等基础结构。
- live skills 尚未建立全量 `SKILL.md` 双结构治理，因此本阶段先产出 inventory/check 设计。

## 2. 目标结构

live `SKILL.md` 的目标结构统一为：

```md
# Skill: <skill_id>

## Core Procedure

## Scenario Extensions

## Appendix
```

段落职责：

- `Core Procedure`：稳定主流程、通用步骤、必须执行的基本动作。
- `Scenario Extensions`：有条件触发的复用分支，不能替代主流程。
- `Appendix`：pitfalls、reminders、evidence expectations、执行疏漏补充。

## 3. Inventory 字段

建议 inventory 输出一条记录对应一个 skill：

| 字段 | 类型 | 说明 |
|---|---|---|
| `skillId` | string | 来自 `skill.json.id`，缺失时用目录名兜底 |
| `skillDir` | string | skill 目录相对路径 |
| `manifestPath` | string | `skill.json` 相对路径 |
| `markdownPath` | string/null | `SKILL.md` 相对路径，缺失则为 null |
| `manifestExists` | boolean | 是否存在 manifest |
| `markdownExists` | boolean | 是否存在 `SKILL.md` |
| `status` | enum | `compliant` / `partial` / `missing` |
| `riskTierHint` | enum | `low` / `medium` / `high`，用于迁移排序 |
| `intents` | string[] | 来自 manifest `intents` |
| `requiredTools` | string[] | 来自 manifest `requiredTools` |
| `executionStrategy` | string/null | 来自 manifest `execution.strategy` |
| `hasCoreProcedure` | boolean | 是否存在标准 heading |
| `hasScenarioExtensions` | boolean | 是否存在标准 heading |
| `hasAppendix` | boolean | 是否存在标准 heading |
| `emptySections` | string[] | 存在但内容为空的标准段落 |
| `nonStandardHeadings` | string[] | 可能承载流程语义的非标准 heading |
| `manifestMarkdownDriftHints` | string[] | manifest 与 markdown 明显漂移的提示 |
| `recommendedAction` | enum | `scaffold` / `restructure` / `review_only` / `none` |
| `notes` | string[] | 人工备注或检查器解释 |

## 4. 合规判定

### compliant

满足全部条件：

1. `skill.json` 存在且能解析。
2. `SKILL.md` 存在。
3. 包含标准 heading：`Core Procedure`、`Scenario Extensions`、`Appendix`。
4. 三个标准段落均非空。
5. 没有明显把主流程写入 `Appendix`、把一次性案例写入 `Core Procedure` 的结构漂移信号。
6. `skill.json.title / description / requiredTools / verification` 与 `SKILL.md` 没有明显语义冲突。

### partial

满足至少一个条件：

1. `SKILL.md` 存在，但缺少一个或多个标准 heading。
2. 标准 heading 存在，但存在空段落。
3. 文档结构接近目标结构，但 heading 名称不统一。
4. 内容可迁移，但段落职责混用，需要人工 review 后重排。
5. manifest 与 markdown 有轻微漂移，需要记录但不阻断迁移。

### missing

满足任一条件：

1. skill 目录存在 `skill.json`，但没有 `SKILL.md`。
2. `SKILL.md` 存在但无法读取。
3. markdown 内容几乎为空，无法判断结构。

当前 builtin skills 初始均属于 `missing`，推荐先 scaffold，再进入人工 review。

## 5. 建议 Check 脚本行为

建议后续新增 `scripts/check-skill-markdown-structure.*` 或等价 npm script，行为如下：

1. 扫描 skill 根目录。
   - 默认扫描 `skills/*`。
   - 后续可扩展扫描配置中的 builtin/local skill directories。
2. 对每个目录读取 `skill.json`。
   - manifest 缺失：记录为 inventory issue，但不纳入本轮 live skill 迁移清单。
   - manifest JSON 解析失败：check 失败。
3. 检查 `SKILL.md`。
   - 缺失：`status = missing`，`recommendedAction = scaffold`。
   - 存在：解析 Markdown headings，检查三段结构。
4. 输出两种格式。
   - human readable table：用于本地人工检查。
   - JSON inventory：用于 dashboard/auditor/proposal generator 消费。
5. 退出码建议。
   - `0`：全部 `compliant`。
   - `1`：存在 `partial` 或 `missing`。
   - `2`：manifest 无法解析、路径不可读等工具级错误。
6. 支持迁移期间的非阻断模式。
   - `--warn-only`：始终退出 `0`，但输出 issue。
   - `--json`：只输出 JSON。
   - `--include-partial`：列出 partial 的详细 heading 与空段落信息。
7. 不自动改写文件。
   - check 脚本只报告，不 scaffold、不重排、不格式化。

## 6. 首批低风险迁移顺序

排序原则：

1. research/discovery skill 优先。
2. 只读、找证据、找文件的 skill 优先。
3. coding intent 且直接影响编辑路径的 skill 后置。
4. required tools 越少、越少涉及 shell 行为，风险越低。

推荐首批顺序：

| 顺序 | skill id | 风险 | 原因 |
|---:|---|---|---|
| 1 | `find.official_sources` | low | research intent，主要是官方来源发现，迁移为结构文档的行为风险最低 |
| 2 | `find.workspace_files` | low-medium | coding intent，但职责是只读发现 workspace 文件，适合第二批 scaffold |
| 3 | `find.integration_points` | medium | 涉及边界和调用路径判断，结构迁移需保留推理顺序 |
| 4 | `find.code_symbol` | medium | 更接近代码编辑前置能力，主流程语义不能被重排丢失 |

首批迁移只建议做结构 scaffold 与语义搬运，不新增能力、不改 manifest、不改变 activation/verification。

## 7. 与 Proposal Generator 的关系

Proposal Generator v2 应消费 inventory/check 结果：

- `missing`：优先生成 scaffold candidate，不直接修改 live skill。
- `partial`：生成段落级 restructure candidate，并标记需要人工 review。
- `compliant`：允许按 reflection 类型定向修改目标段落。
- `riskTierHint = medium/high`：降低自动化推进级别，避免自动 accept。

段落映射建议：

- `skill_defect`：主要落到 `Core Procedure`，必要时补 `Appendix`。
- `execution_lapse`：默认落到 `Appendix`，不污染主流程。
- `missing_scenario`：优先落到 `Scenario Extensions`。
- `verification_gap`：优先落到 `Appendix` 或 manifest verification 相关候选变更。

## 8. 与 Auditor Gate 的关系

Auditor Gate v2 应把 inventory/check 结果前移为审计输入：

- 对 `missing` live skill：candidate 必须包含标准 scaffold，且不能声称已完成 live migration。
- 对 `partial` live skill：candidate 的结构重排必须保持原有语义，并给出 changelog/provenance。
- 对 `compliant` live skill：检查 patch 是否只修改允许段落。
- 对 medium/high 风险 skill：增加 section responsibility check 与 cross-file consistency check。

建议新增或强化的 audit checks：

| check | 作用 |
|---|---|
| `markdown_three_section_contract` | 检查三段 heading 与非空内容 |
| `markdown_section_responsibility` | 检查内容是否落在合理段落 |
| `markdown_manifest_consistency` | 检查 manifest 与 markdown 明显漂移 |
| `markdown_migration_provenance` | 检查结构迁移是否记录来源与变更摘要 |
| `markdown_patch_scope` | 检查 proposal 是否只改允许段落 |

## 9. 后续落地步骤

1. 新增 check 脚本，只读扫描并输出 inventory。
2. 将当前四个 builtin skills 记录为 `missing`。
3. 按迁移顺序为 `find.official_sources` 先生成 scaffold candidate。
4. 人工 review scaffold 语义，再迁移低风险 skill。
5. 将 check 结果接入 auditor/proposal generator，再考虑 dashboard 提醒。

## 10. 验收标准

本设计完成后的下一阶段验收：

1. 有稳定 inventory schema。
2. `compliant / partial / missing` 判定规则明确。
3. check 脚本行为和退出码明确。
4. 当前 builtin skills 的初始状态可解释。
5. 首批低风险迁移顺序明确。
6. Proposal Generator 与 Auditor Gate 的消费关系明确。
