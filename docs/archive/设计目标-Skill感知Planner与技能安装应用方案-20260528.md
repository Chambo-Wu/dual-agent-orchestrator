# 【部分完成】Skill 感知 Planner 与技能安装应用方案

- 日期：2026-05-28
- 范围：在现有 `intent router + route policy + workflow plan` 基础上，引入可安装、可选择、可观测的 `skill` 层
- 状态：设计稿；前置依赖中的 intent/runtime 基线已部分落地，skill 主链尚未开始实现

## 0.1 2026-05-29 清理结论

这份文档目前仍有参考价值，但应视为“skill 主链设计稿”，不是当前主任务清单。

按当前仓库现状，可归类为：

- 已完成的前置基线
  - `intent router`
  - `intent-dispatch`
  - `direct-answer`
  - `research-runtime`
  - `coding-runtime`
  - route / workflow / verification / timeline 主链
- 已落地的 skill 主链能力
  - `skill-registry`
  - `skill-installer`
  - `skill-runtime`
  - builtin skill manifests
  - `selectedSkill / candidateSkills`
  - skill install observability
  - skill-aware timeline detail
- 仍未完成的 skill 深化能力
  - skill 自进化
  - proposal / auditor / deployment validation
  - `SKILL.md` 双结构治理

因此：

1. 本文关于“skill 基础层如何接入”的大方向，已大体完成或已被代码吸收。
2. 后续不建议继续从本文派生新的基础 skill 任务。
3. skill 线后续规划，应以后续两份文档为主：
   - [`集成设计草案-Skill自进化接入本仓库-20260529.md`](./集成设计草案-Skill自进化接入本仓库-20260529.md)
   - [`执行清单-Skill自进化集成任务拆解-20260529.md`](./执行清单-Skill自进化集成任务拆解-20260529.md)

## 0. 2026-05-29 现状校对补记

本方案写于 2026-05-28，默认前提是“顶层任务分拣与多执行模式还处于设计中”。对照当前仓库，该前提需要修正为：

- 已落地的前置基线
  - `src/intent-router.ts`
  - `src/intent-dispatch.ts`
  - `src/direct-answer.ts`
  - `src/research-runtime.ts`
  - `src/coding-runtime.ts`
  - `src/index.ts` 已在真实入口接入 intent route 与 dispatch
- 已具备的可复用能力
  - `coding` 已有分阶段 runtime，可作为 skill runtime 的重要集成目标
  - `research` 已有显式 runtime，可作为 `find.official_sources` 一类 skill 的宿主路径
  - `workflow_plan`、`verification`、dashboard/timeline 已有较完整主链
- 尚未开始的部分
  - `src/skill-types.ts`
  - `src/skill-registry.ts`
  - `src/skill-installer.ts`
  - `src/skill-runtime.ts`
  - `src/skill-prompts.ts`
  - `skills/` 目录与 builtin skill manifests
  - `PlannerOutput.skill`
  - 任意 skill 级 observability 字段

因此，skill 方案当前不是“替代未完成的 intent/runtime 设计”，而是建立在现有任务分拣 v1 之上的下一层能力建设。

## 1. 目标

当前系统已经具备三层基础能力：

1. 顶层任务分拣
   - `direct_answer`
   - `research`
   - `goal`
   - `coding`
2. 中层执行约束
   - `task-routing.yml`
   - `RoutePolicy`
3. 底层执行内核
   - `planner + executor`
   - `workflow_plan`
   - `tool registry`

但 planner 目前仍主要依赖：

- 关键词分流
- planner prompt 自己临场决定步骤
- executor 依据通用工具集执行

这导致一个稳定性问题：

- planner 知道任务属于 research 或 coding
- 但并不知道“这一类任务最应该调用哪种成熟套路”
- 每次都要重新发明一次局部流程

因此本方案的目标不是继续单纯增强 planner prompt，而是给 planner 一个新的中间能力层：

- 先识别任务意图
- 再匹配最合适的 `skill`
- 必要时安装 skill
- 最后按 skill 的执行模板运行

一句话概括：

> planner 从“任务调度器”升级为“技能编排器”。

## 2. 设计原则

### 2.1 skill 不是工具别名

skill 不是简单暴露一组工具名。

skill 至少应当绑定：

- 适用任务意图
- 推荐执行模板
- 推荐工具序列
- 可选安装来源
- 成功验证标准

因此 skill 更接近：

- capability bundle
- execution template
- domain-specific runtime contract

### 2.2 先规则匹配，再 planner 选择

不建议一开始让模型全权决定 skill。

推荐顺序：

1. rule-based 初筛 skill 候选
2. planner 在候选集内选择
3. runtime 校验 skill 是否存在、是否可安装、是否允许自动启用
4. fallback 到原有 route

这样可以保留稳定性，并把 skill 选择纳入可控范围。

### 2.3 v1 不做不受控远程执行

v1 不建议直接支持：

- 任意远程脚本下载执行
- 任意 npm/pip 安装后立即运行
- 任意 skill 访问生产敏感资源

v1 建议只支持：

- `builtin`
- `local_dir`

可选地为 v2 预留：

- `git`
- `package`

## 3. 新增层次

建议把执行结构明确为四层：

1. `intent`
   - 任务大类
   - 例如 `coding`、`research`
2. `skill`
   - 领域套路
   - 例如 `find.code_symbol`
3. `route policy`
   - 底层工具约束
   - 例如 `preferredTools`、`requireEvidenceBeforeFinal`
4. `workflow/runtime`
   - 实际执行步骤

关系如下：

```text
user goal
  -> intent router
  -> skill matcher
  -> planner skill selection
  -> skill runtime / workflow template
  -> executor tools
  -> verification
```

## 4. skill 数据模型

建议新增：

- `src/skill-types.ts`

核心类型建议如下：

```ts
export type SkillIntent =
  | "find"
  | "research"
  | "coding"
  | "data_analysis"
  | "file_ops"
  | "goal_planning";

export type SkillInstallSource =
  | "builtin"
  | "local_dir"
  | "git"
  | "package";

export type SkillExecutionStrategy =
  | "prompt_template"
  | "workflow_template"
  | "custom_runtime";

export interface SkillManifest {
  id: string;
  version: string;
  title: string;
  description: string;

  intents: SkillIntent[];
  keywords: string[];

  requiredTools: string[];
  optionalTools?: string[];

  install: {
    source: SkillInstallSource;
    location: string;
    entry?: string;
    checksum?: string;
  };

  activation: {
    mode: "always" | "intent_match" | "planner_selected";
    priority: number;
  };

  execution: {
    strategy: SkillExecutionStrategy;
    templateId?: string;
    runtimeEntry?: string;
  };

  verification?: {
    requiredArtifacts?: string[];
    successSignal?: string;
  };
}

export interface InstalledSkillRecord {
  id: string;
  version: string;
  installedAt: string;
  source: SkillInstallSource;
  location: string;
  enabled: boolean;
  checksum?: string;
}

export interface SkillMatchResult {
  skillId: string;
  score: number;
  reasons: string[];
  source: "rule" | "planner";
}
```

## 5. planner 输出扩展

建议在现有 planner 输出上增加 skill 决策字段，而不是重新定义一套大协议。

例如新增：

```ts
export interface PlannerSkillDecision {
  skill_id?: string;
  skill_action?: "use_installed" | "install_then_use" | "skip_skill";
  skill_reason?: string;
}
```

并将其并入 `PlannerOutput`：

```ts
export interface PlannerOutput {
  goal: string;
  status: "need_executor" | "workflow" | "final" | "clarify";
  reasoning_summary: string;
  next_step: string;
  audit: {
    verdict: "not_applicable" | "approved" | "retry" | "blocked";
    notes: string;
  };
  skill?: PlannerSkillDecision;
  workflow_plan?: WorkflowPlan;
  executor_request?: PlannerExecutorRequest;
  final_answer?: string;
  clarification_question?: string;
  decision_text?: string;
}
```

这样 planner 可以明确表达：

- 选中了哪个 skill
- 是否需要安装
- 为什么选它

示例：

```json
{
  "status": "workflow",
  "reasoning_summary": "The task requires structured repository discovery before editing.",
  "next_step": "use repository symbol discovery skill",
  "audit": {
    "verdict": "approved",
    "notes": "A builtin skill exists for this coding task."
  },
  "skill": {
    "skill_id": "find.code_symbol",
    "skill_action": "use_installed",
    "skill_reason": "The user asked to locate concrete code entrypoints before making changes."
  },
  "workflow_plan": {
    "...": "..."
  }
}
```

## 6. Skill Registry 设计

建议新增：

- `src/skill-registry.ts`

职责：

1. 发现 builtin skills
2. 发现 local_dir skills
3. 查询已安装技能
4. 基于任务内容给出候选技能
5. 返回 skill manifest

建议接口：

```ts
export interface SkillRegistry {
  listAvailable(): Promise<SkillManifest[]>;
  listInstalled(): Promise<InstalledSkillRecord[]>;
  getManifest(skillId: string): Promise<SkillManifest | null>;
  getInstalled(skillId: string): Promise<InstalledSkillRecord | null>;
  match(goal: string, intentKind: string): Promise<SkillMatchResult[]>;
}
```

建议匹配输入：

- `userGoal`
- `intentRoute.kind`
- 可选的 workspace 信号
  - 是否包含 `src/`
  - 是否包含指定扩展名
  - 是否出现 URL/官网/对比/发布 等词

匹配方式建议：

1. `intent` 先过滤
2. `keywords` 加权
3. 若是 coding 场景，可加 workspace 结构信号
4. 输出前 1-3 个候选

## 7. Skill Installer 设计

建议新增：

- `src/skill-installer.ts`

职责：

1. 安装 skill
2. 校验 skill manifest
3. 记录 installed registry
4. 控制允许的安装来源

建议接口：

```ts
export interface SkillInstaller {
  install(skillId: string): Promise<InstalledSkillRecord>;
  validate(manifest: SkillManifest): Promise<void>;
}
```

建议 v1 安装策略：

- `builtin`
  - 视为天然可用
  - 可不写入安装记录，或首次使用时写入 enabled 记录
- `local_dir`
  - 从配置目录或约定目录读 manifest
  - 校验后写入安装记录
- `git/package`
  - v1 先不启用

建议配置：

```yml
skills:
  enabled: true
  auto_install: false
  builtin_dir: "skills"
  install_dir: "runtime/skills"
  allow_sources: ["builtin", "local_dir"]
```

`auto_install` 建议默认关掉。

## 8. Skill Runtime 设计

建议新增：

- `src/skill-runtime.ts`

skill runtime 的职责不是直接替代 orchestrator，而是把 skill 变成可执行的模板。

建议支持三种执行方式：

### 8.1 prompt_template

适合：

- 简单 `find`
- 简单 `research`

做法：

- 给 planner/executor 注入 skill-specific prompt block
- 不需要新 runtime 分支

### 8.2 workflow_template

适合：

- 结构化调研
- 结构化代码定位
- 文件定位与验证

做法：

- 由 skill 直接提供一份 workflow plan 模板
- runtime 将模板参数化后执行

### 8.3 custom_runtime

适合：

- 非常稳定且高价值的套路
- 需要定制逻辑

例如：

- `find.code_symbol`
- `find.integration_points`

做法：

- 由 runtime 调用 skill 的专用执行器

## 9. builtin skill 建议

v1 最值得先做 4 个内置 skill。

### 9.1 `find.code_symbol`

用途：

- coding 场景
- 找函数、类、路由、配置入口

触发信号：

- `fix` / `debug` / `implement`
- 出现 `src/`、文件名、函数名、API 路径

推荐执行模板：

1. `rg --files`
2. `rg -n "<symbol or keyword>"`
3. 读取命中的少量文件
4. 输出最相关入口清单

推荐工具：

- `list_files`
- `read_file`
- `shell_command`

### 9.2 `find.official_sources`

用途：

- research 场景
- 找官网、官方文档、主仓库、发布页

触发信号：

- `official`
- `latest`
- `release`
- `source`
- `documentation`

推荐执行模板：

1. `web_search`
2. `url_fetch`
3. 去重与主域名筛选
4. 输出 primary sources

推荐工具：

- `web_search`
- `url_fetch`
- `read_file`

### 9.3 `find.workspace_files`

用途：

- file/data 场景
- 快速定位目标文件、schema、相邻配置

推荐工具：

- `list_files`
- `read_file`
- `shell_command`

### 9.4 `find.integration_points`

用途：

- 架构场景
- 找事件入口、持久化层、API 接口、UI 消费点

推荐工具：

- `list_files`
- `read_file`
- `shell_command`

## 10. `find` skill 示例 manifest

### 10.1 `find.code_symbol`

```json
{
  "id": "find.code_symbol",
  "version": "0.1.0",
  "title": "Code Symbol Discovery",
  "description": "Locate the most relevant code symbols, entrypoints, routes, and config definitions before editing.",
  "intents": ["coding"],
  "keywords": ["fix", "debug", "implement", "route", "function", "class", "module", "src/", ".ts", ".js"],
  "requiredTools": ["list_files", "read_file", "shell_command"],
  "install": {
    "source": "builtin",
    "location": "skills/find.code_symbol"
  },
  "activation": {
    "mode": "intent_match",
    "priority": 100
  },
  "execution": {
    "strategy": "workflow_template",
    "templateId": "find_code_symbol_v1"
  },
  "verification": {
    "requiredArtifacts": ["symbol_hits", "file_excerpt"],
    "successSignal": "at_least_one_relevant_entrypoint"
  }
}
```

### 10.2 `find.official_sources`

```json
{
  "id": "find.official_sources",
  "version": "0.1.0",
  "title": "Official Source Discovery",
  "description": "Find official sources such as docs, repositories, release notes, and primary documentation.",
  "intents": ["research"],
  "keywords": ["official", "latest", "release", "source", "documentation", "repo", "github"],
  "requiredTools": ["web_search", "url_fetch", "read_file"],
  "install": {
    "source": "builtin",
    "location": "skills/find.official_sources"
  },
  "activation": {
    "mode": "intent_match",
    "priority": 100
  },
  "execution": {
    "strategy": "workflow_template",
    "templateId": "find_official_sources_v1"
  },
  "verification": {
    "requiredArtifacts": ["search_results", "primary_source_summary"],
    "successSignal": "at_least_two_non_empty_primary_sources"
  }
}
```

## 11. 与现有模块的集成点

### 11.1 与 `intent-router.ts`

集成方式：

- `intent router` 仍然负责顶层四分流
- `skill matcher` 在 route 之后执行
- 当前补记：
  - 这一前提已成立，skill 无需再承担顶层 intent 判断职责
  - 更推荐把 `skill matcher` 放在 `intent-dispatch` 之前，形成 `route -> skill match -> runtime dispatch` 的链路

建议新增：

```ts
interface IntentExecutionPlan {
  intent: IntentRouteResult;
  candidateSkills: SkillMatchResult[];
  selectedSkillId?: string;
}
```

### 11.2 与 `orchestrator.ts`

集成方式：

- `buildPlannerMessages(...)` 增加可用 skill 列表
- planner 可返回 `skill` 字段
- runtime 读取 `planner.skill`

当前补记：

- 这里需要优先确认 `types.ts` 中 `PlannerOutput` 扩展方式，避免与现有 `workflow_plan`、`verification`、event replay 结构冲突
- 推荐先做“可选 skill 字段 + 兼容旧 planner 输出”的渐进式扩展，而不是一次性改写 planner contract

新增 prompt block 示例：

```txt
Available skills:
- find.code_symbol: use for locating repository entrypoints before editing
- find.official_sources: use for locating official docs, repos, and release notes

If one skill clearly fits the task, prefer selecting it instead of inventing a raw ad-hoc workflow.
```

### 11.3 与 `workflow_plan`

skill 可以输出两种东西：

1. planner 继续自由生成 `workflow_plan`
2. skill 直接提供 `workflow_template`

v1 更推荐第二种场景先用于 `find` skill。

当前补记：

- 鉴于仓库已经有成熟 `workflow_plan` 执行链，skill v1 最适合优先走 `workflow_template`
- 不建议 v1 一开始引入复杂 `custom_runtime` 注册机制；可先把少量 builtin skill 编译成 workflow 模板

### 11.4 与 observability

建议在以下位置新增字段：

- job / plan
  - `selectedSkill`
- event meta
  - `skill_id`
  - `skill_action`
  - `skill_install_status`
- `/health`
  - `skills.enabled`
  - `skills.installed_count`
  - `skills.builtin_count`
- dashboard / timeline
  - 显示 route 之外的 skill

当前补记：

- 现有 observability 已覆盖 `intent_route`、verification checks、workflow timeline
- skill 观测建议沿用同一套元数据形态，不另起一套事件协议
- 优先补充：
  - `selected_skill`
  - `skill_match_candidates`
  - `skill_action`
  - `skill_install_status`

## 12. 最小落地顺序

建议按以下顺序实现。

### 第一阶段：静态内置 skill

1. 新增 `src/skill-types.ts`
2. 新增 `src/skill-registry.ts`
3. 注册 2 个 builtin skill
   - `find.code_symbol`
   - `find.official_sources`

当前建议：

- 这一阶段现在可以直接开始
- 且应严格限定为“注册与匹配”，不要同时引入安装与执行

目标：

- skill 可被发现
- skill 可被匹配
- 不涉及安装逻辑

### 第二阶段：planner 感知 skill

1. 扩展 planner prompt
2. 扩展 `PlannerOutput.skill`
3. runtime 能读取 `skill_id`

当前建议：

- 这一阶段开始前，先补 `PlannerOutput` 兼容扩展方案与回放/事件链检查

目标：

- planner 能明确表达 skill 决策

### 第三阶段：skill runtime

1. 新增 `src/skill-runtime.ts`
2. 先支持 `workflow_template`
3. 把 2 个 builtin skill 跑通

当前建议：

- v1 应优先复用现有 `workflow_plan` runtime
- `skill-runtime.ts` 只负责把 manifest/template 转成现有 workflow 输入

目标：

- `find` skill 可真正执行

### 第四阶段：安装机制

1. 新增 `src/skill-installer.ts`
2. 先支持 `builtin` 和 `local_dir`
3. 增加安装记录

当前建议：

- 安装机制应明确晚于 registry / planner contract / builtin workflow 跑通
- 若前面几步尚未稳定，不建议提前引入 `local_dir` 安装

目标：

- skill 不只是内置常量，而是运行时能力对象

### 第五阶段：可观测性

1. skill 选择进入 events
2. skill 状态进入 `/health`
3. dashboard / timeline 展示 skill

## 13. v1 明确不做

v1 不建议包含：

- 任意远程 git 拉取并执行 skill
- skill 沙箱执行器
- 跨 skill memory 图谱
- 复杂 skill 版本冲突解决
- skill 市场与签名体系

这些都属于后续扩展。

## 13.1 基于当前仓库的推荐推进顺序

结合 2026-05-29 的代码现状，skill 线最稳妥的推进顺序建议调整为：

1. 建立类型与静态注册
   - `src/skill-types.ts`
   - `src/skill-registry.ts`
   - 两个 builtin manifests
2. 补 planner contract
   - 扩展 `PlannerOutput.skill`
   - planner prompt 注入 skill 候选
3. 打通 workflow_template
   - `src/skill-runtime.ts`
   - `find.code_symbol`
   - `find.official_sources`
4. 接入观测
   - events
   - `/health`
   - dashboard / timeline
5. 最后再考虑安装机制
   - `builtin`
   - `local_dir`

这样排序的原因是：

- 当前仓库最成熟的是 route + runtime + workflow + verification，而不是安装分发
- skill 的核心价值首先来自“更稳定地选择成熟套路”，不是“更快安装外部包”
- 若先做 installer，容易把问题带偏到分发与安全，而不是提升 planner/runtime 的稳定性

## 14. 推荐的代码骨架

建议新增文件：

- `src/skill-types.ts`
- `src/skill-registry.ts`
- `src/skill-installer.ts`
- `src/skill-runtime.ts`
- `src/skill-prompts.ts`

建议新增目录：

- `skills/find.code_symbol/skill.json`
- `skills/find.official_sources/skill.json`
- `skills/templates/find_code_symbol_v1.json`
- `skills/templates/find_official_sources_v1.json`

## 15. 结论

最推荐的落地方式不是：

- 继续把 planner prompt 写得更长
- 或者让 planner 完全自由决定所有步骤

而是：

1. 保留 `intent router`
2. 在其后加入 `skill matcher`
3. 让 planner 学会选择 skill
4. 让 runtime 根据 skill 套用稳定模板

这样做的收益：

- planner 更稳定
- coding / research 任务套路更可复用
- 能逐步沉淀领域能力
- skill 选择与安装进入可观测和可验证范围

对于当前仓库，最适合作为 v1 起点的是：

1. `find.code_symbol`
2. `find.official_sources`

它们都能明显增强 planner 在“面对不同用户任务时”的实际能力，而且与当前的 intent 分流、workflow 执行、dashboard/timeline 观测链路天然兼容。

补充判断：

- 当前最合适的 skill 切入点不是 goal，而是 `coding` 与 `research` 的高频查找型套路
- 因为这两条 runtime 已经存在，skill 可以以较低风险嵌入进去
- `goal mode` 仍应单独推进，不建议在其尚未落地前把 skill 与 goal 深度耦合
