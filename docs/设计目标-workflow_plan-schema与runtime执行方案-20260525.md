> 文档状态：设计目标，请先阅读 README
>
> 本文描述 `workflow_plan` 的目标 schema、运行时执行模型与渐进式落地方案。
> 它面向当前 `dual-agent-orchestrator` 代码库，尽量复用现有 `runTask`、`runTeam`、`TaskQueue`、`Scheduler`、`job/events` 基础设施，而不是另起炉灶。

# workflow_plan schema 与 runtime 执行方案

- 日期：2026-05-25
- 目标：让 `planner` 从“下一步调度器”升级为“工作流设计者”，在 runtime 约束内拥有更大的编排自由度
- 适用范围：单任务编排、多 worker 协作、验证与综合、审批、人机混合流程、可恢复作业

---

## 1. 背景与目标

当前系统的核心形态仍是：

- `planner -> executor -> planner -> executor`
- planner 主要输出：
  - `status`
  - `executor_request`
  - `final_answer`

这套协议足以支撑：

- 简单单线任务
- 受控 research / file / shell 编排
- 基础 retry / loop detection / approval

但它限制了 planner 的表达能力：

- 不能原生表达并行分支
- 不能声明 verifier / synthesizer 这样的额外角色
- 不能表达 finish condition
- 不能把“先搜官方，再补对比，再汇总，再落盘”一次性描述为可执行 DAG
- runtime 只能通过“多轮下一步”来间接模拟复杂工作流

本方案的核心目标是：

1. 让 planner 输出 `workflow_plan`
2. 让 runtime 执行 `workflow_plan`
3. 保持强校验、强约束、可回退
4. 与现有单线 orchestrator 共存

也就是说，不是完全放飞 planner，而是：

- 自由在 schema 内
- 灵活在 runtime 约束下

---

## 2. 设计原则

### 2.1 Planner 负责设计，Runtime 负责约束

planner 可以设计工作流，但 runtime 必须负责：

- schema 校验
- DAG 校验
- 工具权限校验
- 角色校验
- 并发上限
- 步数与预算控制
- 错误处理与恢复

### 2.2 新协议与旧协议兼容

planner 输出保持二选一：

1. 旧模式：
```json
{
  "status": "need_executor",
  "executor_request": { ... }
}
```

2. 新模式：
```json
{
  "status": "workflow",
  "workflow_plan": { ... }
}
```

这样可以渐进迁移，不需要一次性切换全系统。

### 2.3 Workflow 只表达受支持的节点类型

planner 不能发明 runtime 不认识的节点类型。

第一版只支持：

- `search`
- `fetch`
- `read`
- `write`
- `extract`
- `transform`
- `verify`
- `synthesize`
- `approval`
- `delegate`

### 2.4 任意时刻可降级回单线模式

如果 `workflow_plan` 不合法、超预算、或某类节点当前未实现：

- runtime 可以拒绝该 plan
- 要求 planner 重出
- 或降级为当前 `executor_request` 单步执行模式

---

## 3. planner 输出协议

## 3.1 顶层 schema

```json
{
  "status": "workflow | need_executor | final | clarify",
  "step": "short string",
  "audit": {
    "verdict": "not_applicable | approved | retry | blocked",
    "notes": "short string"
  },
  "workflow_plan": {
    "id": "wf_xxx",
    "strategy": "research_and_write",
    "summary": "Collect evidence, extract findings, verify, then write report",
    "tasks": [],
    "finish_when": {
      "mode": "all_required_tasks_completed"
    },
    "replan_policy": {
      "allow_runtime_replan": true,
      "max_replans": 2
    }
  },
  "executor_request": {
    "instruction": "string",
    "allowed_tools": ["tool1"],
    "expected_output": "string"
  },
  "answer": "string",
  "question": "string"
}
```

规则：

- `status = workflow` 时，必须有 `workflow_plan`
- `status = need_executor` 时，必须有 `executor_request`
- `status = final` 时，必须有 `answer`
- `workflow_plan` 与 `executor_request` 不应同时作为主路径执行

---

## 3.2 workflow_plan schema

```json
{
  "id": "wf_20260525_001",
  "strategy": "research_and_write",
  "summary": "Search official sources, extract key facts, compare alternatives, then write markdown report",
  "tasks": [
    {
      "id": "t1",
      "title": "Collect primary evidence",
      "kind": "search",
      "role": "worker",
      "instruction": "Find official or primary sources for the target topic",
      "allowed_tools": ["web_search", "url_fetch"],
      "depends_on": [],
      "required": true,
      "retry_policy": {
        "max_attempts": 2,
        "on_failure": "replan"
      },
      "outputs": {
        "artifacts": ["search_results", "page_content"],
        "memory_key": "primary_evidence"
      }
    }
  ],
  "finish_when": {
    "mode": "all_required_tasks_completed"
  },
  "replan_policy": {
    "allow_runtime_replan": true,
    "max_replans": 2
  }
}
```

---

## 3.3 Task node schema

```json
{
  "id": "t2",
  "title": "Extract benchmark scores",
  "kind": "extract",
  "role": "worker | verifier | synthesizer | planner_proxy",
  "instruction": "Read the collected artifacts and extract benchmark scores into structured JSON",
  "allowed_tools": ["read_file", "parse_json", "extract_text"],
  "depends_on": ["t1"],
  "required": true,
  "input": {
    "from_memory": ["primary_evidence"],
    "from_artifacts": ["t1"]
  },
  "constraints": {
    "max_tool_rounds": 2,
    "max_runtime_seconds": 90,
    "require_structured_output": true
  },
  "retry_policy": {
    "max_attempts": 2,
    "on_failure": "replan"
  },
  "outputs": {
    "artifacts": ["structured_summary"],
    "memory_key": "benchmark_scores"
  }
}
```

字段说明：

- `id`
  - workflow 内唯一
- `title`
  - 前台展示和日志使用
- `kind`
  - runtime 支持的任务节点类型
- `role`
  - 指派给哪个逻辑角色执行
- `instruction`
  - 该节点的执行目标
- `allowed_tools`
  - 白名单工具
- `depends_on`
  - DAG 依赖
- `required`
  - 若为 `false`，失败后可跳过
- `input`
  - 描述依赖什么 memory / artifact
- `constraints`
  - 节点级执行限制
- `retry_policy`
  - 节点失败时的处理
- `outputs`
  - 约定产物与 memory 归档位置

---

## 3.4 支持的 kind

第一版建议：

### `search`

- 典型工具：`web_search`, `weather_lookup`, `finance_lookup`, `sports_lookup`
- 目标：获取候选结果或直接事实

### `fetch`

- 典型工具：`url_fetch`, `http_request`
- 目标：读取候选页面或 API 内容

### `read`

- 典型工具：`read_file`, `list_files`
- 目标：读取已有 artifact / 文件

### `extract`

- 典型工具：`read_file`, `parse_json`, `extract_text`, `parse_csv`
- 目标：从原始材料中提取结构化信息

### `transform`

- 典型工具：`parse_json`, `write_file`
- 目标：格式转换、结构压缩、生成中间摘要

### `write`

- 典型工具：`write_file`
- 目标：写报告、写配置、写结果文件

### `verify`

- 典型工具：`read_file`, `list_files`
- 目标：校验结果质量、文件存在性、结构正确性

### `synthesize`

- 典型工具：通常不需要工具，或只读 artifact
- 目标：综合多个分支输出最终答案

### `approval`

- 目标：进入人工审批 gate
- 无需普通工具执行，由 runtime 控制

### `delegate`

- 目标：对子任务调用现有 `runTask()`，作为嵌套执行单元
- 这是第一版连接旧系统最重要的兼容节点

---

## 3.5 finish_when schema

```json
{
  "mode": "all_required_tasks_completed"
}
```

第一版建议只支持四种：

- `all_required_tasks_completed`
- `any_of`
- `first_success`
- `manual_approval_resolved`

示例：

```json
{
  "mode": "any_of",
  "task_ids": ["t3", "t4"]
}
```

含义：

- `t3` 或 `t4` 任一完成即可收敛

---

## 3.6 retry_policy schema

```json
{
  "max_attempts": 2,
  "on_failure": "replan | fail | skip | fallback",
  "fallback_task_id": "t_fallback"
}
```

运行时含义：

- `replan`
  - 把当前状态回传 planner，要求生成修正版 plan
- `fail`
  - 直接让 workflow 失败
- `skip`
  - 标记该节点跳过，继续后续可执行节点
- `fallback`
  - 进入预定义 fallback task

---

## 4. Runtime 执行模型

## 4.1 总体流程

```text
planner
  -> returns workflow_plan
runtime
  -> validate workflow_plan
  -> convert to TaskQueue items
  -> assign roles via Scheduler
  -> execute ready tasks
  -> persist artifacts / events / memory
  -> check finish_when
  -> if needed, replan
  -> finalize job
```

---

## 4.2 执行阶段

### Phase A: Plan validation

runtime 在接受 `workflow_plan` 前执行：

1. 顶层 schema 校验
2. task id 唯一性校验
3. `depends_on` 引用有效性校验
4. DAG 无环校验
5. `role` 是否存在于当前 runtime
6. `allowed_tools` 是否都是已注册工具
7. `kind` 是否为支持类型
8. `finish_when` 是否引用有效 task
9. 预算检查：
   - 总 task 数量
   - 估计总工具轮次
   - 并发上限

若失败：

- 记录 `workflow.plan.invalid`
- 进入 `planner replan`
- 或降级到单线 `need_executor`

### Phase B: Queue materialization

把 `workflow_plan.tasks` 映射为现有 `Task` / `TaskRun`：

- `workflow task` -> `Task`
- `Task` -> `TaskRun`
- `outputs.artifacts` -> artifact expectation metadata

此阶段复用：

- `createTask()`
- `TaskQueue`
- `validateTaskDependencies()`

### Phase C: Scheduling

根据 `role` 与 `Scheduler` 分发：

- `worker` -> 普通 executor
- `verifier` -> verifier runtime
- `synthesizer` -> synthesizer runtime
- `planner_proxy` -> planner 参与节点级决策

第一版可以先不做多物理模型并发，只做逻辑角色区分。

### Phase D: Task execution

每个 ready task 的执行方式：

#### kind = `delegate`

- 直接调用现有 `runTask(subGoal, routePolicy)`
- 这是最稳的兼容桥梁

#### kind = `write` / `read` / `extract` / `fetch`

- 映射为单节点 executor_request
- 调用现有 `runExecutorStep()`

#### kind = `approval`

- 进入现有 approval state
- 等待 `/approve`

#### kind = `synthesize`

- 读取依赖分支 artifacts / memory
- 由 planner 或 synthesizer 角色生成总结

### Phase E: Finish evaluation

每轮任务完成后检查：

- 是否满足 `finish_when`
- 是否所有 required task 已 completed
- 是否某 required task failed 且不可恢复
- 是否达到 workflow 预算上限

### Phase F: Replan

在以下情况下触发：

- 节点失败且 `on_failure = replan`
- plan validation 失败
- verifier 明确认为结果不达标
- finish condition 迟迟无法满足

replan 输入应包含：

- 原始 goal
- 当前 workflow_plan
- task 状态摘要
- artifacts 摘要
- memory summary
- failure reasons

planner 输出：

- `workflow_patch`
- 或新的完整 `workflow_plan`
- 或退回 `final`

---

## 5. Workflow 状态机

## 5.1 Job 状态

延续现有：

- `queued`
- `running`
- `awaiting_approval`
- `completed`
- `failed`
- `blocked`
- `cancelled`

## 5.2 Workflow 状态

新增逻辑状态：

- `draft`
- `validated`
- `active`
- `replanning`
- `awaiting_approval`
- `completed`
- `failed`
- `blocked`
- `superseded`

## 5.3 Task 节点状态

建议扩成：

- `pending`
- `ready`
- `in_progress`
- `partial_success`
- `awaiting_approval`
- `completed`
- `failed`
- `blocked`
- `skipped`
- `superseded`

其中：

- `ready`
  - 依赖已满足，可执行
- `partial_success`
  - 有 artifact，可继续推进
- `superseded`
  - 被 replan 替换

---

## 6. 事件模型

新增事件：

- `workflow.plan.created`
- `workflow.plan.validated`
- `workflow.plan.rejected`
- `workflow.plan.replanned`
- `workflow.task.ready`
- `workflow.task.assigned`
- `workflow.task.partial_success`
- `workflow.task.superseded`
- `workflow.finish_condition.met`
- `workflow.finish_condition.pending`

现有事件继续保留：

- `workflow.executor.start`
- `workflow.executor.result`
- `workflow.tool.start`
- `workflow.tool.result`

前台可据此展示：

- 当前 plan
- DAG 进度
- 并行分支
- replan 历史

---

## 7. 与现有代码的对接方案

## 7.1 现有可复用模块

直接复用：

- [src/orchestrator.ts](../src/orchestrator.ts)
  - `runTask`
  - `runExecutorStep`
  - `finalizeExecutorResult`
- [src/team.ts](../src/team.ts)
  - `runTeam`
  - `buildSubtaskConfig`
- [src/task/task.ts](../src/task/task.ts)
  - `createTask`
  - `validateTaskDependencies`
- [src/task/queue.ts](../src/task/queue.ts)
  - `TaskQueue`
- [src/orchestrator/scheduler.ts](../src/orchestrator/scheduler.ts)
  - `Scheduler`
- `job store / event bus / workflow-ui-events / timeline`

## 7.2 需要新增的模块

建议新增：

- `src/workflow-plan.ts`
  - schema 定义与校验
- `src/workflow-plan-parser.ts`
  - planner 输出解析
- `src/workflow-runtime.ts`
  - workflow 执行器
- `src/workflow-finish.ts`
  - finish_when 评估
- `src/workflow-replan.ts`
  - replan 输入构造与 patch 应用

## 7.3 types.ts 建议新增类型

建议增加：

```ts
export type PlannerStatus =
  | "need_executor"
  | "workflow"
  | "final"
  | "clarify";

export type WorkflowTaskKind =
  | "search"
  | "fetch"
  | "read"
  | "extract"
  | "transform"
  | "write"
  | "verify"
  | "synthesize"
  | "approval"
  | "delegate";

export type WorkflowRole =
  | "worker"
  | "verifier"
  | "synthesizer"
  | "planner_proxy";
```

## 7.4 Planner prompt 建议

新增规则：

- 你可以输出 `workflow_plan`
- 只允许使用受支持的 `kind`
- 优先设计可验证、可恢复、少循环的 DAG
- 不要生成超过 N 个 task
- 如果任务明显简单，仍然优先输出 `need_executor` 而不是 workflow

也就是说：

- workflow_plan 不是默认路径
- 而是 planner 在复杂任务中可用的新武器

---

## 8. 第一版落地路径

## Milestone A

只新增 schema，不执行：

- 定义 `workflow_plan` types
- planner 可返回 `status = workflow`
- server 记录 plan，但仍降级回旧模式

价值：

- 先验证 planner 是否会产出可用 plan

当前状态：已完成。

## Milestone B

执行最小工作流：

- 支持 `delegate`
- 支持 `write`
- 支持 `approval`
- finish_when 只支持 `all_required_tasks_completed`

价值：

- 用最小改动打通执行链路

当前状态：已完成。`workflow-runtime` 已能执行 `delegate`、`write`、`approval`，并能把审批等待状态持久化到 job record。

## Milestone C

支持多节点与 replan：

- `search/fetch/read/extract/synthesize`
- 节点 retry_policy
- workflow replan

当前状态：已完成。已支持 `search/fetch/read/extract` 通过 executor step 执行，`verify` 通过系统级 verifier 执行，`synthesize` 通过 team synthesis 执行，`retry_policy.on_failure = fail/skip/fallback/replan` 均已有实现；`replan` 不再只是最小 replacement workflow，还会保留 superseded task history、归档前序 task/artifact，并发出 `workflow.plan.replanned` / `workflow.task.superseded` 事件；`finish_when` 也已具备 `all_required_tasks_completed / any_of / first_success / manual_approval_resolved` 的真实执行语义。更完整的 patch 级 replan、状态合并优化与 richer history 展示可放入后续增强阶段，但 Milestone C 定义范围内的能力已经收口。

## Milestone D

支持 verifier / synthesizer / 前台 DAG 展示

当前状态：部分完成。前台事件和 timeline 已能展示 workflow plan、task ready/assigned/completed/failed/skipped/awaiting_approval，以及 job/steps 响应中的 workflow summary；完整 DAG 图形化仍待推进。

---

## 9. 示例

## 9.1 复杂 research + write

```json
{
  "status": "workflow",
  "step": "build_workflow",
  "audit": {
    "verdict": "approved",
    "notes": "A multi-stage evidence workflow is more efficient than single-step retries."
  },
  "workflow_plan": {
    "id": "wf_report_001",
    "strategy": "research_compare_write",
    "summary": "Gather evidence, extract comparison points, verify, then write final markdown report",
    "tasks": [
      {
        "id": "t1",
        "title": "Collect official sources",
        "kind": "delegate",
        "role": "worker",
        "instruction": "Search and fetch official sources about the target models",
        "allowed_tools": ["web_search", "url_fetch", "read_file"],
        "depends_on": [],
        "required": true,
        "retry_policy": { "max_attempts": 2, "on_failure": "replan" },
        "outputs": { "memory_key": "official_sources" }
      },
      {
        "id": "t2",
        "title": "Extract benchmark table",
        "kind": "extract",
        "role": "worker",
        "instruction": "Read collected artifacts and extract benchmark scores into structured JSON",
        "allowed_tools": ["read_file", "parse_json", "extract_text"],
        "depends_on": ["t1"],
        "required": true,
        "retry_policy": { "max_attempts": 2, "on_failure": "replan" },
        "outputs": { "memory_key": "benchmark_table" }
      },
      {
        "id": "t3",
        "title": "Verify evidence completeness",
        "kind": "verify",
        "role": "verifier",
        "instruction": "Check whether the extracted evidence is sufficient to support the requested comparison",
        "allowed_tools": ["read_file"],
        "depends_on": ["t2"],
        "required": true,
        "retry_policy": { "max_attempts": 1, "on_failure": "replan" },
        "outputs": { "memory_key": "verification_result" }
      },
      {
        "id": "t4",
        "title": "Write markdown report",
        "kind": "write",
        "role": "worker",
        "instruction": "Write the final Chinese markdown report to the requested local path",
        "allowed_tools": ["write_file"],
        "depends_on": ["t2", "t3"],
        "required": true,
        "retry_policy": { "max_attempts": 1, "on_failure": "fail" },
        "outputs": { "artifacts": ["report_file"] }
      }
    ],
    "finish_when": {
      "mode": "all_required_tasks_completed"
    },
    "replan_policy": {
      "allow_runtime_replan": true,
      "max_replans": 2
    }
  }
}
```

---

## 10. 推荐结论

最推荐的落地方式不是“直接取消所有约束，把 planner 完全放开”，而是：

1. 让 planner 获得 `workflow_plan` 表达能力
2. 让 runtime 严格校验并执行 `workflow_plan`
3. 先用 `delegate` 节点桥接现有 `runTask`
4. 再逐步把更多节点原生化

这条路的优点是：

- planner 更灵活
- runtime 仍可控
- 现有代码可复用
- 前台可展示
- 可以逐步灰度，而不是大爆炸式重构

## 11. 当前上下文压缩（2026-05-25）

截至本次检查，代码进度已超过本文原始“下一步”：

1. `types.ts` 已新增 `status = workflow`、`WorkflowPlan`、`WorkflowTaskSpec`、`TaskRunStatus = awaiting_approval` 等类型。
2. `workflow-plan.ts` 已实现 plan 解析、schema/DAG/工具校验、Milestone fallback request、执行支持度判断。
3. `workflow-runtime.ts` 已实现工作流执行入口，支持依赖解锁、审批等待、delegate/write/search/fetch/read/extract/synthesize、skip/fallback 策略、job 进度持久化。
4. `orchestrator.ts` 已能解析 planner 的 `workflow_plan`，发出 `workflow.plan.*` 事件，并在支持范围内直接执行 workflow plan。
5. `workflow-ui-events.ts`、`index.ts`、`timeline.ts` 已补齐 workflow plan/task 事件归一化、job summary、steps 当前任务标记和 timeline header。
6. 验证结果：`npm run test:unit` 通过（42/42），`npm run build` 通过。

继续推进时，最值得优先做的是：

1. 继续增强 `verify` 节点：当前已接入系统级 verifier，后续可再补 task 级 verifier 选择、结构化校验结果归档与更细粒度的 verifier 事件。
2. 把 workflow replan 从“replacement workflow + superseded history”继续补全到更完整形态：支持 patch 级 plan 更新、状态合并优化与 richer history 展示。
3. 补集成测试：覆盖 `/v1/jobs` 创建 workflow、`/events` 历史回放、`/stream` 实时事件、`/approve` 恢复审批。
4. 清理命名：`assessWorkflowExecutionSupport` 的提示仍写着 “Milestone C”，后续如果能力继续扩展，应同步更新用户可见文案。
