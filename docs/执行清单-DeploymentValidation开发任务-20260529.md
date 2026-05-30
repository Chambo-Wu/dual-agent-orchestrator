# 执行清单：Deployment Validation 开发任务

- 日期：2026-05-29
- 范围：把 `Deployment Validation` 从专项路线下钻成可直接开发、验证、回归的任务清单
- 关联文档：
  - [专项路线-DeploymentValidation-Skill自进化-20260529.md](/d:/Android/dual-agent-orchestrator/docs/专项路线-DeploymentValidation-Skill自进化-20260529.md)
  - [主骨架与专项推进路线-Skill自进化-20260529.md](/d:/Android/dual-agent-orchestrator/docs/主骨架与专项推进路线-Skill自进化-20260529.md)
  - [总排期页-Skill自进化专项路线-20260529.md](/d:/Android/dual-agent-orchestrator/docs/总排期页-Skill自进化专项路线-20260529.md)

## 1. 目标

本清单的目标不是再写一份设计，而是把 `Deployment Validation` 拆成能直接进入迭代开发的任务。

完成后应达到：

1. validation report 能解释 baseline / candidate 是怎么来的。
2. `silent_bypass` 进入明确的 validation contract。
3. candidate replay provenance 至少可被控制面和测试消费。
4. baseline / candidate 对跑有可扩展的最小骨架。

## 2. 当前基线

当前仓库已经具备这些能力：

- 能从 validate API 产出 `SkillDeploymentValidationReport`
- 能比较 baseline / candidate verified
- 能比较 artifact count / failed checks
- 能阻止明显未改善的 proposal

但还缺：

- baseline replay contract
- candidate runtime injection
- replay provenance
- `silent_bypass` 硬性门槛
- risk-tier aware validation contract

## 3. 任务总览

| 任务 | 优先级 | 目标 | 依赖 |
|---|---:|---|---|
| DV-1 | P0 | 固化 baseline replay contract | 无 |
| DV-2 | P0 | 扩展 validation report provenance 字段 | DV-1 |
| DV-3 | P0 | 把 `silent_bypass` 纳入 validation 硬门槛 | DV-1 |
| DV-4 | P1 | 建立 candidate runtime injection 最小骨架 | DV-1, DV-2 |
| DV-5 | P1 | 建立 baseline / candidate 对跑集成测试 | DV-2, DV-3, DV-4 |
| DV-6 | P1 | 引入 risk-tier aware validation summary | DV-3, DV-5 |
| DV-7 | P2 | 增加 replay instability / flakiness 信号 | DV-5 |

## 4. 推荐开发顺序

建议按这个顺序开工：

1. `DV-1`
2. `DV-2`
3. `DV-3`
4. `DV-4`
5. `DV-5`
6. `DV-6`
7. `DV-7`

原因：

- 先把 contract 讲清楚，再做 runtime 注入。
- 先让 report 可解释，再放大自动化。
- 先让 `silent_bypass` 进入门槛，再讨论 risk tier。

## 5. 任务明细

## DV-1：固化 baseline replay contract

- 优先级：`P0`
- 状态：`done`
- 目标：明确 validation 里 baseline / candidate 的来源与同输入语义。

### 交付物

1. baseline source 规则
2. same-input contract
3. replay provenance 语义说明

### 当前落实

- `SkillDeploymentValidationReport.contract.baselineSelection`
- `SkillDeploymentValidationReport.contract.inputEquivalence`
- baseline source 已区分：
  - `source_reflection_job`
  - `reflection_only`
  - `none`

## DV-2：扩展 validation report provenance 字段

- 优先级：`P0`
- 状态：`done`
- 目标：让 validation report 能显式回答“这次 compare 到底比了什么”。

### 建议文件

- `src/skill-evolution-types.ts`
- `src/skill-deployment-validator.ts`
- `src/index.ts`

### 当前落实

- 已增加 `replay.provenance`
- 已增加 `decision.reasonCode / autoAcceptReady`
- 已增加 `contract.hardGates`

## DV-3：把 `silent_bypass` 纳入 validation 硬门槛

- 优先级：`P0`
- 状态：`done`
- 目标：让 candidate 在缺乏真实执行证据时不能被轻易视为通过。

### 当前落实

- `silent_bypass_absent` 已进入 validation hard gate
- 新增 silent bypass 失败集成测试

## DV-4：建立 candidate runtime injection 最小骨架

- 优先级：`P1`
- 状态：`done`
- 目标：为后续 isolated replay 预留 candidate runtime source。

### 当前落实

- 已新增 `src/skill-replay-runtime.ts`
- 已可从 proposal candidate snapshot 派生 replay config
- validation report 已输出：
  - `replay.provenance.candidateSource = candidate_runtime_config`
  - `replay.provenance.runtimeConfig`
- validation report 已增加 `replay.runtimeBoundary`，用于区分：
  - `not_enabled`：未启用真实 candidate runtime replay
  - `config_prepared`：已准备 candidate runtime config，但尚未实例化 workflow
  - `workflow_materialized`：已基于 candidate snapshot 实例化 skill workflow
- 当前 `workflow_materialized` 仍不等于 true runtime replay ready，真实 candidate workflow task execution 尚未完成。

## DV-5：建立 baseline / candidate 对跑集成测试

- 优先级：`P1`
- 状态：`done`
- 目标：确保 validate 不会退回只看文件差异。

### 当前落实

- 已覆盖：
  - candidate 改善时通过
  - candidate 无明显改善时失败
  - `silent_bypass` 时失败
  - candidate 有文件变化但因风险扩权失败
- 已明确断言：
  - baseline / candidate provenance
  - same-input contract
  - hard gates
  - decision reason code

## DV-6：引入 risk-tier aware validation summary

- 优先级：`P1`
- 状态：`done`
- 目标：让 coding / research 类 skill 的 validation 结果有差异化总结。

### 当前落实

- validation report 已增加 `risk.tier / skillClass / acceptanceFocus / summary`
- 已覆盖 coding-like 与 research-like 的差异化断言
- `risk_tier_contract` 已进入 validation hard gate

## DV-7：增加 replay instability / flakiness 信号

- 优先级：`P2`
- 状态：`done`
- 目标：为 auto_accept 之前补上稳定性指标。

### 当前落实

- validation report 已增加 `stability.replayInstabilityDetected / candidateFlakySignal / autoAcceptBlocked / reasons`
- 已覆盖“低风险、可通过、但不可 auto-accept”的 flaky 场景
- auto-accept 主链已消费 `validation.decision.autoAcceptReady`

## 6. 按专项路线继续推进的增量

在 DV-1 ~ DV-7 全部完成后，已继续向专项路线的 `Phase 2 / Phase 3` 之间推进一小步，补强 replay provenance 的“selected skill source”证据链。

### 已补充

- validation report 的 `replay.provenance` 已增加：
  - `baselineSelectedSkillSource`
  - `candidateSelectedSkillSource`
  - `candidateBinding`
  - `executionEvidence`
- 可区分 baseline 的 selected skill id 是来自：
  - `job_selected_skill`
  - `plan_selected_skill`
  - `reflection_record`
  - `unavailable`
- 可区分 candidate 的 selected skill id 是来自：
  - `candidate_manifest`
  - `reflection_record`
  - `unavailable`
- 已补集成断言，确保 validate API 会显式返回这层 provenance。
- 已把 candidate binding 细化为：
  - `manifestPresent`
  - `runtimePrepared`
  - `targetFileCount / changedFileCount`
  - `selectedSkillMatchesProposal / selectedSkillMatchesReflection`
  - `bindingReady / reasons`
- 已把 execution evidence 细化为：
  - `reflectionEventIds / reflectionArtifactIds`
  - `baselineHadArtifacts`
  - `silentBypassSignal`
  - `candidateManifestPresent / candidateChangedFiles / candidateVerified`
  - `level = direct | partial | weak`
  - `summary`
- 已继续把这两组信号收口到 validation readiness：
  - `contract.hardGates.candidate_binding_ready`
  - `contract.hardGates.execution_evidence_ready`
  - `contract.hardGates.same_input_comparison_ready`
  - `decision.autoAcceptReady` 现在会直接受 `bindingReady` 与 `executionEvidence.level === direct` 约束
- risky escalation 场景下，即使 candidate 文件存在，也不会再被视为 `bindingReady`
- 已把 readiness signal 继续下钻到 baseline / candidate 同输入对跑结果：
  - `replay.sameInputComparison`
  - `mode = recorded_baseline_vs_candidate | baseline_job_vs_candidate_runtime`
  - `inputAligned / baselineObserved / candidateObserved`
  - `baselineSelected / candidateSelected`
  - `artifactDelta / failedChecksDelta`
  - `resolvedMissingRequirements / remainingMissingRequirements / introducedMissingRequirements`
  - `evidenceLevel / readiness / summary`
- `decision.autoAcceptReady` 现在也会直接受 `sameInputComparison.readiness === ready` 约束
- 当 `baselineRecord` 真实存在且 candidate runtime 已准备好时，comparison mode 会提升到更接近 isolated replay 语义的 `baseline_job_vs_candidate_runtime`
- baseline 侧 comparison 也开始优先消费真实 `baselineRecord` 的 artifact / verification 结果，而不是只依赖 reflection 摘要
- 已进一步落成一次可执行的 isolated manifest replay：
  - 复用 baseline job 的真实 artifacts / verification 结果
  - 在 live manifest 与 candidate manifest 下各执行一次确定性 verification replay
  - candidate contract 变严格时，可在 validate 阶段被 isolated replay 真实打回
- `replay.provenance.isolated = true` 不再只是语义占位，而代表 isolated replay 已实际执行
- 已继续往上推成 task/job 级 replay contract：
  - `replay.baseline.replayJob`
  - `replay.candidate.replayJob`
  - 返回 `jobId / taskRunId / status / verificationStatus / artifactCount`
  - source 标记为 `isolated_manifest_replay`
- 这次再补成带事件流的 isolated replay contract：
  - `replay.baseline.replayJob.events[]`
  - `replay.candidate.replayJob.events[]`
  - 事件序列当前为 replay-local、deterministic evidence，不直接复用主事件总线
  - 首批事件覆盖 `replay_job_created / artifacts_loaded / manifest_resolved / verification_started / checks_evaluated / verification_completed / replay_job_completed|replay_job_blocked`
- 已继续把真实 candidate runtime replay 边界从“配置已准备”推进到“workflow 已实例化”：
  - `replay.runtimeBoundary.source = candidate_snapshot`
  - `replay.runtimeBoundary.contract = workflow_materialized`
  - `candidateRuntimeConfigPrepared = true`
  - `trueRuntimeReplayEnabled = true`
  - `trueRuntimeReplayReady = false`
  - `autoAcceptEligible = false`
  - `reason = candidate_runtime_workflow_materialized`
- 这一步已经实际消费 candidate snapshot 的 builtin skill 目录并 materialize workflow，但还没有执行 candidate workflow task，也没有把真实 task execution result 纳入 comparison。
- 已新增候选 runtime workflow execution harness：
  - `runCandidateRuntimeWorkflowReplay`
  - 复用 candidate snapshot 派生出的 builtinDir
  - 通过真实 workflow runtime 执行 materialized candidate workflow
  - 使用 deterministic replay deps 消费 recorded baseline evidence，避免 validation 阶段触发外部模型或工具副作用
  - 已有 unit test 覆盖 workflow task execution 与 replayReady
- 已把该 harness 接入 manual validate endpoint：
  - `validateSkillEvolutionProposalWithRuntimeReplay`
  - `/v1/skill-evolution/proposals/:id/validate` 会先执行 candidate runtime workflow replay，再生成 validation report
  - passing report 可进入 `runtimeBoundary.stage = executed`
  - passing report 可进入 `runtimeBoundary.contract = true_candidate_runtime_replay`
  - `sameInputComparison.readiness` 可在真实 replay ready 时提升为 `ready`
- 自动 evolution pipeline 仍保持同步旧路径，暂不因为 endpoint harness 直接放开自动 accept。
- 已新增自动 pipeline opt-in 开关：
  - `skill_evolution.runtime_replay_in_auto_pipeline`
  - 默认 `false`，保持旧自动链路安全边界
  - 开启后 auto-validate 会使用 `validateSkillEvolutionProposalWithRuntimeReplay`
  - 已覆盖开启后 validation summary 可进入 `same_input_readiness = ready`
  - 即使开启该开关，是否 accepted 仍继续受 `auto_accept`、risk tier、dynamic ceiling、validation readiness 共同约束

### 这一步的意义

- 让 validation report 不只回答“candidate 从哪套 runtime 来”，也能回答“selected skill id 是从哪份证据解析出来的”。
- 让 validation report 能进一步回答“candidate 是否已经完成绑定”和“当前 execution evidence 的强度到底有多高”。
- 让 readiness-sensitive 决策不再只看启发式 pass/fail，而会显式消费 binding / evidence 两层硬信号。
- 让 readiness-sensitive 决策开始直接消费“baseline / candidate 同输入对跑结果本身是否已达到 readiness”这层判断。
- 让 `sameInputComparison` 开始区分“只是 recorded 对比”与“已具备 baseline job + candidate runtime 的更强对跑前提”。
- 让 candidate runtime 的 verification contract 改动开始真实影响 validate 结果，而不再只是 reflected heuristic。
- 让 validation report 开始携带真正的 replay job/task 级结果，而不只是一份 verification 结论。
- 让 validation report 开始携带可消费的 replay 过程事件，而不只是 terminal summary。
- 让真实 candidate runtime replay 的 contract 不再只有“是否准备 config”的粗粒度标记，而能表达 `not_enabled -> config_prepared -> workflow_materialized` 的边界推进。
- 让 manual validate report 首次可以表达 `stage = executed` 与 `contract = true_candidate_runtime_replay`。
- 为后续真正做 baseline / candidate 同输入对跑时，补上更完整的 execution evidence 骨架。
- validator 现已开始复用 Proposal Generator 的共享 policy 层：
  - 对 `execution_lapse / append_appendix` 的 patch scope 边界不再单独维护一份启发式
  - 对 manifest escalation 的安全边界也与 auditor 共享同一来源
  - 对 `Core Procedure / Scenario Extensions / Appendix` 的段落级 patch 面判断也开始与 auditor 共享同一来源
- 已把 validation readiness 继续接入控制面消费面：
  - proposal detail 已返回 `validation_summary.auto_accept_ready`
  - proposal detail 已返回 `validation_summary.same_input_readiness`
  - job workflow summary 已返回 latest validation summary
  - dashboard 已展示 skill evolution replay readiness 摘要
  - 集成测试已覆盖 proposal detail 与 job summary 中的 readiness / replay event 摘要

### 下一步更值得做的切片

1. 在 replay event stream 上继续补 task-level step payload，而不只是 summary/detail。
2. 继续评估 auto-accept 放大条件：低风险 skill、runtime replay ready、稳定性窗口、dynamic ceiling 全部满足时，是否允许从 opt-in runtime replay 自动进入 accepted。
3. 为 proposal queue / accepted history / rollback guide 继续补 validation readiness 聚合视图。
4. 补一轮 targeted regression，覆盖 proposal detail、job summary、dashboard 三处 readiness 展示的一致性。
