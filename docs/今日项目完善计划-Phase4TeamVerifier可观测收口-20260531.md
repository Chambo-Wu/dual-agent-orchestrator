# 【已完成】今日项目完善计划：Phase 4 Team / Verifier 可观测收口

- 日期：2026-05-31
- 来源：从 `【部分完成】` 与未完成任务中筛选一天内可完成、低风险、可验收的项目完善切片。
- 今日目标：把 Phase 4 已启动的 team / verifier 能力从“后端已接入”推进到“运行时可见、降级可解释、回归可守护”。
- 完成状态：done

## 0. 收口结果

已完成：

- `runTeam` 运行开始时发出 `system.team_agent_registry_snapshot`，记录 `planner / executor / worker / verifier / synthesizer / planner_proxy` 角色状态。
- team-mode subtask verification 在没有注册 verifier agent 时改为 deterministic system verifier fallback，并发出 `system.team_verifier_fallback` warning。
- `/health` 暴露 `runtime.team_agents`，Electron Health 页面展示 team role 状态卡。
- Job response / Jobs Dashboard 暴露 `team_agent_registry`，team job 可在控制面看到角色状态。
- `/events` 与 `/stream` 可回放 team registry 与 verifier fallback 事件。

已验证：

- `npm run typecheck`
- `npm run build`
- `node --check electron/renderer.js`
- `node --import tsx --test test/integration/team.run-team.test.ts test/integration/job-store.api.test.ts test/unit/dashboard-ui.test.ts test/unit/config.test.ts`

## 1. 今日选择

今日只做一个连贯切片：

> Team agent registry 与 verifier fallback 可观测性收口。

选择理由：

- `runTeam` 已有 `worker / synthesizer / verifier` 首批能力，继续做可观测性比继续扩展新角色更稳。
- 文档中多处仍列出“前端动态 agent registry 展示”“team verifier 语义补强”“verifier profile/task constraints warning”“/stream 断言”。
- 该切片主要是 read-only API / UI / event / test，不改变核心调度策略，适合当天完成。

## 2. 今日不做

以下任务继续保留，不进入今天范围：

- patch 级 replan。
- 外部代理或插件化接入边界。
- user / developer / admin 审计权限模型。
- 安全与隐私分级展示。
- Skill 自进化全量 v2 rewrite。
- auto-accept 放大条件调整。
- 全量 `SKILL.md` 迁移。

## 3. 交付物

### T1. Agent registry 运行时快照

- 状态：done
- 目标：让当前 team 角色、模型路由和可用性变成可查询数据。
- 建议文件：
  - `src/team.ts`
  - `src/team-schema.ts`
  - `src/index.ts`
  - `test/integration/api.contract.test.ts`
- 输出：
  - 增加 read-only agent registry snapshot 数据结构。
  - 暴露 team roles：`planner`、`executor`、`worker`、`verifier`、`synthesizer`、`planner_proxy`。
  - 标出每个角色的 `configured / active / missing / fallback` 状态。
- 验收：
  - API contract test 能读取 registry snapshot。
  - 没有配置某角色时，响应不报错，状态为 `missing` 或 `fallback`。

### T2. Verifier fallback warning

- 状态：done
- 目标：当配置了 verifier 路由但 agent 不存在、不可用或降级到 system checks 时，产生可观测 warning。
- 建议文件：
  - `src/team.ts`
  - `src/verification.ts`
  - `src/job-event-bus.ts`
  - `test/integration/team.run-team.test.ts`
- 输出：
  - team-mode verifier 降级时写入 job event。
  - event payload 至少包含 `role`、`requested_agent_id`、`fallback`、`reason`。
- 验收：
  - 集成测试覆盖 verifier 缺失时仍能完成 system-first verification。
  - events 中能看到降级 warning。

### T3. Dashboard / Electron 可见入口

- 状态：done
- 目标：让操作者能在已有 UI 中看到 team agent registry 与 verifier fallback 状态。
- 建议文件：
  - `src/jobs-dashboard.ts`
  - `electron/renderer.html`
  - `electron/renderer.js`
  - `electron/renderer.css`
- 输出：
  - Jobs Dashboard 或 Electron Health 区展示 team roles 状态。
  - 对 fallback / missing 状态使用明确文案。
  - 不新增复杂交互，只做 read-only 展示。
- 验收：
  - 页面在无 team 运行记录时也能正常渲染。
  - 角色状态文本不遮挡、不撑破布局。

### T4. Stream / timeline 回归守护

- 状态：done
- 目标：把今天新增的 registry / warning 信号纳入回归测试。
- 建议文件：
  - `test/integration/job-store.api.test.ts`
  - `test/integration/team.run-team.test.ts`
  - `test/unit/dashboard-ui.test.ts`
- 输出：
  - `/events` 可查到 verifier fallback warning。
  - 如 `/stream` 已支持 replay，补一条 snapshot replay 断言。
  - dashboard HTML 包含 agent registry/fallback 状态。
- 验收：
  - `npm run typecheck`
  - `node --import tsx --test test/integration/team.run-team.test.ts`
  - `node --import tsx --test test/integration/job-store.api.test.ts test/unit/dashboard-ui.test.ts`

## 4. 时间安排

| 时间 | 任务 | 退出条件 |
|---|---|---|
| 09:30-10:00 | 阅读 team / verification / dashboard 现有实现 | 明确最小数据结构与 UI 插入点 |
| 10:00-12:00 | T1 agent registry snapshot | API/内部结构可测试 |
| 13:30-15:00 | T2 verifier fallback warning | warning event 有集成覆盖 |
| 15:00-16:30 | T3 UI 可见入口 | dashboard/Electron read-only 展示完成 |
| 16:30-17:30 | T4 回归测试与文档同步 | typecheck + 指定测试通过 |
| 17:30-18:00 | 收口报告 | 更新完成/剩余项与验证结果 |

## 5. 风险控制

- 不改 team 调度算法，只增加状态快照、warning 与展示。
- 不默认启用新 verifier profile。
- 不把 fallback 视为失败，只把它变成可见信号。
- 若 UI 工作超时，优先保留 API/event/test，UI 只做 Health 区最小展示。

## 6. 完成后应更新的文档

- `docs/对齐分析日志-规划vs现状-20260530.md`
  - 将“前端动态 agent registry 展示”从未开始改为首版完成。
  - 将“team verifier 语义补强”补充 fallback warning 事实。
- `docs/路线图日志-Phase4验证层缺口-20260527.md`
  - 将 `verifier_agent_id` 缺失 warning 标记为完成。
  - 记录 `/events` 或 `/stream` 回归覆盖情况。
- `docs/文档索引-导航页-20260529.md`
  - 将本计划作为今天执行入口归档。
