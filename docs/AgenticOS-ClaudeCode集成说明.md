# Dual Agent Orchestrator - Claude Code Agentic OS 集成

## 概述

本文档说明如何将 Dual Agent Orchestrator 的核心架构迁移到 Claude Code 的原生 multi-agent 系统中，实现 **Planner + Worker(s)** 架构。

## 架构对比

### 原架构（独立服务）
```
User → HTTP API → Job Queue → Orchestrator Loop → Result
                        ↓
                  Planner + Executor 循环
                  Workflow Plan 执行
                  Skill Evolution 追踪
```

### 新架构（Claude Code Agentic OS）
```
User → Claude Code Kernel → Task Decomposition → Parallel Subagents → Synthesis
                              ↓
                    @planner (规划) + @workers (执行) + @verifier (验证)
```

## 核心组件

### 1. Kernel (`CLAUDE.md`)
- 身份：任务编排器
- 职责：任务分类、路由、agent 选择
- 位置：项目根目录

### 2. Specialist Agents (`.claude/agents/`)
| Agent | 文件 | 职责 |
|-------|------|------|
| @planner | `.claude/agents/planner.md` | 目标分析、任务分解、进度审计 |
| @coder | `.claude/agents/coder.md` | 代码实现、调试、重构 |
| @researcher | `.claude/agents/researcher.md` | 网络搜索、数据收集、来源验证 |
| @writer | `.claude/agents/writer.md` | 文档编写、内容创建 |
| @verifier | `.claude/agents/verifier.md` | 输出验证、质量检查 |

### 3. Commands (`.claude/commands/`)
| Command | 用途 |
|---------|------|
| `/dao-run` | 保持原 Dual Agent Orchestrator 大流程语义，自动选择 native / service job / MCP 路由 |
| `/build-feature` | 构建完整功能（实现+测试+文档） |
| `/research-and-report` | 深度研究并生成报告 |
| `/verify-quality` | 综合质量验证 |
| `/orchestrator-demo` | 演示架构工作流程 |

### 4. Shared Context (`SHARED_TASK_NOTES.template.md`)
- 根目录保留共享上下文模板
- 多步骤任务的实时记录写入 `runtime/agentic-os/tasks/<task-id>.md`
- 避免运行中进度污染 Git 工作区

## 使用方式

### 简单任务（无需规划）
```
User: "读取 src/config.ts 并总结其结构"
→ 直接 @coder 执行
```

### 中等任务（轻量规划）
```
User: "为 auth 模块添加错误处理"
→ @planner 创建计划 → @coder 实现 → 响应
```

### 复杂任务（完整流程）
```
User: "构建一个带测试和文档的新 API 端点"
→ @planner 分解 → @coder 实现 → @writer 文档 → @verifier 验证 → 综合
```

### 使用 Commands
```
/dao-run 构建一个可恢复、可观测的后台任务
/build-feature 添加用户资料页面，支持头像上传
/research-and-report 比较 React 状态管理方案
/verify-quality src/auth/
```

### `/dao-run` 路由策略

`/dao-run` 是 Claude Code 中恢复原 Dual Agent Orchestrator 大流程的主入口。它先判断任务应该走哪条路线：

| 路由 | 适用场景 | 状态来源 |
|------|----------|----------|
| `native` | 短小、本地、同步完成，不需要恢复或 timeline | Claude Code subagents + task note |
| `service_job` | 长任务、多步骤、需要 dashboard / timeline / replay / recovery | `/v1/jobs` 持久化 job |
| `mcp_service_job` | 已配置 Dual Agent Orchestrator MCP 工具 | MCP job/status/event 工具 |
| `hybrid` | Claude Code 负责局部读写和验证，服务负责持久化大流程 | task note + service job |

复杂任务默认优先尝试 `service_job`，本地服务默认地址为 `http://127.0.0.1:9898`。如果服务不可达，再退回 `native`，并在 task note 中记录降级原因。

每次 `/dao-run` 都必须创建 `runtime/agentic-os/tasks/<task-id>.md`，记录 route、status、job_id、timeline_url、acceptance criteria、artifacts、verification 和 CTA。

## 执行流程示例

### 示例：构建 REST API

**输入**：
```
/build-feature 用户注册和登录 API
```

**Phase 1: 规划 (@planner)**
```markdown
## Plan Summary
- **Goal**: 用户注册和登录 API
- **Complexity**: Medium
- **Steps**: 5
- **Parallel**: Yes (步骤 2-3)

## Execution Steps
1. 设计数据库 schema → @coder
2. 实现注册端点 → @coder (parallel)
3. 实现登录端点 → @coder (parallel)
4. 添加认证中间件 → @coder
5. 编写测试 → @coder
6. 编写 API 文档 → @writer
```

**Phase 2: 执行 (Parallel Workers)**
- @coder: 创建 User model
- @coder: 实现 POST /auth/register
- @coder: 实现 POST /auth/login
- @coder: 实现 JWT 中间件
- @coder: 编写测试用例
- @writer: 编写 API 文档

**Phase 3: 验证 (@verifier)**
```markdown
## Verification Report

### Verdict
✅ PASS

### Acceptance Criteria
| Criterion | Status | Evidence |
|-----------|--------|----------|
| 用户可以注册 | ✅ PASS | POST /auth/register 返回 201 |
| 用户可以登录 | ✅ PASS | POST /auth/login 返回 token |
| 受保护路由需要认证 | ✅ PASS | GET /api/me 无 token 返回 401 |
| 密码已加密 | ✅ PASS | 使用 bcrypt，salt rounds = 10 |

### 测试结果
- 23/23 测试通过
- 覆盖率: 85%
```

**Phase 4: 综合**
```
✅ 功能完成
- 6 个文件创建/修改
- 23 个测试通过
- 文档已更新
- 所有验收标准满足
```

## 与原 Dual Agent Orchestrator 的对比

| 特性 | 原架构 | Claude Code Agentic OS |
|------|--------|------------------------|
| 规划能力 | 内置 planner | @planner agent |
| 执行能力 | 内置 executor | @coder, @researcher, @writer |
| 验证能力 | 内置 verifier | @verifier agent |
| 并行执行 | 有限 | Claude Code task subagent |
| 可观测性 | Dashboard/Timeline | `runtime/agentic-os/tasks/` task notes |
| Skill Evolution | 完整支持 | 可通过 MCP 集成 |
| 持久化 | 文件系统 | 文件系统 |
| 启动成本 | 需要运行服务 | 零配置 |

## 优势

1. **零配置**：不需要运行独立服务
2. **原生集成**：使用 Claude Code 原生能力
3. **并行执行**：task subagent 支持真正并行
4. **上下文共享**：task notes 桥接上下文
5. **可扩展**：轻松添加新 agent

## 局限性

1. **无异步 Job**：所有任务同步完成
2. **无持久化队列**：任务不能跨会话排队
3. **无实时 Dashboard**：进度通过文件追踪
4. **无 Skill Evolution**：除非通过 MCP 集成

## 进阶：集成原 Dual Agent Orchestrator 服务

如果需要原架构的高级功能（异步 Job、Skill Evolution），可以通过 MCP 集成：

```markdown
## MCP Integration (Optional)

启动 Dual Agent Orchestrator 服务：
npm run serve

在 .claude/mcp.json 中配置：
{
  "servers": {
    "dual-agent": {
      "command": "node",
      "args": ["dist/index.js", "serve"],
      "env": {
        "PORT": "9898"
      }
    }
  }
}

然后 agent 可以调用：
- create_job: 创建异步任务
- get_job_status: 查询任务状态
- skill_evolution: Skill 改进追踪
```

## 下一步

1. 试用 `/orchestrator-demo` 查看架构演示
2. 使用 `/build-feature` 构建你的下一个功能
3. 根据需要自定义 agent 定义
4. 考虑是否需要 MCP 集成高级功能
