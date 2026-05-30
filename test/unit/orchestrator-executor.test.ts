import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { __testables as orchestratorTestables } from "../../src/orchestrator.js";
import { WORKSPACE_ROOT } from "../../src/paths.js";
import type { ModelResponse } from "../../src/types.js";
import { buildMinimalConfig, buildRoutePolicy, createFakeChatRunner, createFakeRuntimeDeps, modelResponseFromJson } from "../helpers/fake-runtime.js";
import { getInstalledSkill } from "../../src/skill-registry.js";
import { getInstalledSkillRecord, installSkillRecord } from "../../src/skill-installer.js";

test("finalizeExecutorResult treats successful native tool calls as success even when assistant text is empty", () => {
  const executorResponse: ModelResponse = {
    content: "",
    reasoning: "",
    toolCalls: [{
      id: "call_1",
      name: "write_file",
      arguments: "{\"path\":\"out.txt\",\"content\":\"hello\"}",
    }],
    raw: { id: "resp_1" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [{ tool: "write_file", arguments: { path: "out.txt", content: "hello" } }],
    artifacts: [{ type: "file", path: "runtime/out.txt", content_preview: "hello" }],
    lastSummary: "Wrote file runtime/out.txt",
    lastRawResult: "hello",
    ok: true,
  });

  assert.equal(result.status, "success");
  assert.equal(result.summary, "Wrote file runtime/out.txt");
  assert.equal(result.error, undefined);
  assert.equal(result.source, "native_tool");
  assert.deepEqual(result.tool_calls_made, [{ tool: "write_file", arguments: { path: "out.txt", content: "hello" } }]);
  assert.deepEqual(result.artifacts, [{ type: "file", path: "runtime/out.txt", content_preview: "hello" }]);
  assert.equal(result.raw_result, "hello");
});

test("finalizeExecutorResult preserves successful native progress gathered before tool round limit", () => {
  const executorResponse: ModelResponse = {
    content: "",
    reasoning: "",
    toolCalls: [],
    raw: { id: "resp_limit" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [
      { tool: "web_search", arguments: { query: "DeepSeek V4" } },
      { tool: "url_fetch", arguments: { url: "https://www.deepseek.com/" } },
    ],
    artifacts: [
      { type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"DeepSeek\"}]" },
      { type: "file", path: "runtime/command-results/page.txt", content_preview: "DeepSeek-V4 preview release" },
    ],
    lastSummary: "Fetched https://www.deepseek.com/ (463 chars)",
    lastRawResult: "DeepSeek-V4 preview release",
    ok: true,
  });

  assert.equal(result.status, "success");
  assert.equal(result.source, "native_tool");
  assert.equal(result.error, undefined);
  assert.equal(result.summary, "Fetched https://www.deepseek.com/ (463 chars)");
  assert.equal(result.raw_result, "DeepSeek-V4 preview release");
  assert.equal(result.artifacts.length, 2);
});

test("finalizeExecutorResult marks native partial progress as partial_success when error is present", () => {
  const executorResponse: ModelResponse = {
    content: "",
    reasoning: "",
    toolCalls: [],
    raw: { id: "resp_partial" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [{ tool: "web_search", arguments: { query: "DeepSeek V4" } }],
    artifacts: [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"DeepSeek\"}]" }],
    lastSummary: "Found 3 results",
    lastRawResult: "[{\"title\":\"DeepSeek\"}]",
    lastError: "Executor exceeded tool round limit",
    ok: true,
  });

  assert.equal(result.status, "partial_success");
  assert.equal(result.source, "native_tool");
  assert.equal(result.summary, "Found 3 results");
});

test("finalizeExecutorResult preserves model-declared failure after native tool execution", () => {
  const executorResponse: ModelResponse = {
    content: JSON.stringify({
      status: "failed",
      summary: "Search results were low quality and did not establish a trustworthy answer.",
      raw_result: "Search results were dominated by irrelevant placeholder domains.",
      error: "Need better sources before continuing.",
    }),
    reasoning: "",
    toolCalls: [],
    raw: { id: "resp_failed_after_tools" },
  };

  const result = orchestratorTestables.finalizeExecutorResult(executorResponse, {
    executedCalls: [{ tool: "web_search", arguments: { query: "example topic" } }],
    artifacts: [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"Example\"}]" }],
    lastSummary: "Found 5 results",
    lastRawResult: "[{\"title\":\"Example\"}]",
    ok: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.source, "native_tool");
  assert.equal(result.summary, "Search results were low quality and did not establish a trustworthy answer.");
  assert.equal(result.raw_result, "Search results were dominated by irrelevant placeholder domains.");
  assert.equal(result.error, "Need better sources before continuing.");
  assert.deepEqual(result.tool_calls_made, [{ tool: "web_search", arguments: { query: "example topic" } }]);
  assert.deepEqual(result.artifacts, [{ type: "json", path: "runtime/command-results/search.json", content_preview: "[{\"title\":\"Example\"}]" }]);
});

test("assessTaskComplexity classifies simple weather lookup as direct", () => {
  const result = orchestratorTestables.assessTaskComplexity(
    "帮我查询上海未来一周的天气，然后写入本地天气预报-上海-20260525.md",
    "general",
    {
      type: "general",
      matchers: [],
      plannerInstruction: "",
      enableRanking: false,
      requireEvidenceBeforeFinal: false,
      minGroundedCandidates: 0,
      requireArtifactReadback: false,
      requireNonEmptyArtifact: false,
      preferredTools: ["web_search"],
      artifactPriority: [],
      completionChecklist: [],
      fallbackRule: "",
    },
  );

  assert.equal(result.mode, "direct");
  assert.ok(result.score >= 4);
});

test("assessTaskComplexity keeps comparison-heavy research as orchestrated", () => {
  const result = orchestratorTestables.assessTaskComplexity(
    "调研 DeepSeek、Qwen、GLM 的代码能力对比，分析优劣并生成报告",
    "research",
    {
      type: "research",
      matchers: ["research"],
      plannerInstruction: "",
      enableRanking: true,
      requireEvidenceBeforeFinal: true,
      minGroundedCandidates: 3,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
      preferredTools: ["web_search", "read_file"],
      artifactPriority: [],
      completionChecklist: [],
      fallbackRule: "",
    },
  );

  assert.equal(result.mode, "orchestrated");
  assert.ok(result.score < 4);
});

test("detectTaskType routes release-note fact research away from comparative research", () => {
  const routing = [
    buildRoutePolicy({
      type: "fact_research",
      matchers: ["latest", "official", "release", "highlights"],
      enableRanking: false,
      minGroundedCandidates: 0,
      requireEvidenceBeforeFinal: true,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
    }),
    buildRoutePolicy({
      type: "research",
      matchers: ["github", "repository", "compare", "ranking"],
      enableRanking: true,
      minGroundedCandidates: 3,
      requireEvidenceBeforeFinal: true,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
    }),
    buildRoutePolicy(),
  ];

  const taskType = orchestratorTestables.detectTaskType(
    "Research the latest official TypeScript 5.x release highlights and provide a concise sourced summary",
    routing,
  );

  assert.equal(taskType, "fact_research");
});

test("detectTaskType recognizes Chinese research prompts instead of falling back to general", () => {
  const routing = [
    buildRoutePolicy({
      type: "fact_research",
      matchers: ["最新", "官方", "发布", "公告"],
      enableRanking: false,
      minGroundedCandidates: 0,
      requireEvidenceBeforeFinal: true,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
    }),
    buildRoutePolicy({
      type: "research",
      matchers: ["调研", "研究", "案例", "趋势", "分析", "报告"],
      enableRanking: true,
      minGroundedCandidates: 3,
      requireEvidenceBeforeFinal: true,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
    }),
    buildRoutePolicy({
      type: "web_search",
      matchers: ["搜索", "查询", "检索"],
      enableRanking: true,
      minGroundedCandidates: 2,
      requireEvidenceBeforeFinal: true,
      requireArtifactReadback: true,
      requireNonEmptyArtifact: true,
    }),
    buildRoutePolicy(),
  ];

  const taskType = orchestratorTestables.detectTaskType(
    "研究一下大模型协作，目前有哪些成功案例，主要使用场景是什么，并整理成报告",
    routing,
  );

  assert.equal(taskType, "research");
});

test("buildPlannerMessages includes matched skill candidates for coding prompts", () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "code",
    plannerInstruction: "Code task.",
    preferredTools: ["list_files", "read_file", "shell_command"],
  });

  const messages = orchestratorTestables.buildPlannerMessages(
    config,
    "Debug src/index.ts and find the route entrypoint before editing",
    [],
    0,
    routePolicy,
  );

  const userMessage = messages.find((message) => message.role === "user");
  const content = typeof userMessage?.content === "string" ? userMessage.content : "";
  assert.equal(content.includes("Available skills:"), true);
  assert.equal(content.includes("find.code_symbol"), true);
});

test("runPlannerStep records and degrades workflow plans during milestone A", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy();
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "workflow",
      step: "build_workflow",
      audit: {
        verdict: "approved",
        notes: "Multi-stage task benefits from a workflow plan.",
      },
      workflow_plan: {
        id: "wf_demo",
        strategy: "research_and_write",
        summary: "Collect evidence then write the result.",
        tasks: [
          {
            id: "t1",
            title: "Collect evidence",
            kind: "delegate",
            role: "worker",
            instruction: "Collect evidence with direct tools.",
            allowed_tools: ["web_search", "read_file"],
            depends_on: [],
            required: true,
          },
        ],
        finish_when: {
          mode: "all_required_tasks_completed",
        },
        replan_policy: {
          allow_runtime_replan: true,
          max_replans: 1,
        },
      },
    }),
  ]);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];

  const result = await orchestratorTestables.runPlannerStep(
    config,
    "Research a topic and prepare a report",
    [],
    0,
    routePolicy,
    1,
    undefined,
    createFakeRuntimeDeps({
      runChatCompletionDetailed: fakeChat.runner,
    }),
    {
      onEvent: (event) => {
        events.push({ type: event.type, data: event.data });
      },
    },
  );

  assert.equal(result.status, "need_executor");
  assert.equal(result.workflow_plan?.id, "wf_demo");
  assert.equal(result.executor_request?.allowed_tools.includes("web_search"), true);
  assert.equal(result.audit.notes.includes("Runtime fallback applied"), true);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "workflow.step.start",
      "workflow.plan.created",
      "workflow.plan.validated",
      "workflow.planner.decision",
    ],
  );
});

test("runPlannerStep materializes builtin code skill into workflow plan", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "code",
    plannerInstruction: "Code task.",
    preferredTools: ["list_files", "read_file", "shell_command"],
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "locate repository entrypoints",
      audit: {
        verdict: "approved",
        notes: "Use builtin symbol discovery.",
      },
      skill: {
        skill_id: "find.code_symbol",
        skill_action: "use_installed",
        skill_reason: "Need stable repository discovery before editing.",
      },
      executor_request: {
        instruction: "Fallback if workflow cannot run.",
        allowed_tools: ["list_files"],
        expected_output: "Fallback discovery output.",
      },
    }),
  ]);

  try {
    installSkillRecord(config, {
      id: "find.code_symbol",
      version: "0.1.0",
      title: "Code Symbol Discovery",
      description: "Locate relevant repository symbols, entrypoints, routes, and config definitions before editing.",
      intents: ["coding"],
      keywords: ["fix", "debug", "implement", "route", "function", "class", "module", "src", ".ts", ".js"],
      requiredTools: ["list_files", "read_file", "shell_command"],
      install: {
        source: "builtin",
        location: "skills/find.code_symbol",
      },
      activation: {
        mode: "intent_match",
        priority: 100,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_code_symbol_v1",
      },
      verification: {
        requiredArtifacts: ["symbol_hits", "file_excerpt"],
        successSignal: "at_least_one_relevant_entrypoint",
      },
    });

    const result = await orchestratorTestables.runPlannerStep(
      config,
      "Debug src/index.ts and locate the route entrypoint",
      [],
      0,
      routePolicy,
      1,
      undefined,
      createFakeRuntimeDeps({
        runChatCompletionDetailed: fakeChat.runner,
      }),
    );

    assert.equal(result.skill?.skill_id, "find.code_symbol");
    assert.equal(result.workflow_plan?.id, "find_code_symbol_v1");
    assert.equal(result.workflow_plan?.strategy, "code_symbol_discovery+skill:find.code_symbol");
    assert.equal(result.workflow_plan?.tasks.length, 3);
    assert.equal(result.workflow_plan?.tasks[0]?.allowed_tools.includes("list_files"), true);
    assert.equal(result.workflow_plan?.tasks[0]?.allowed_tools.includes("shell_command"), true);
    assert.equal(result.workflow_plan?.tasks[1]?.allowed_tools.includes("read_file"), true);
    assert.equal(result.workflow_plan?.tasks[2]?.kind, "verify");
    assert.equal(result.workflow_plan?.tasks[2]?.constraints?.verifier_profile, "artifact");
    assert.equal(result.workflow_plan?.tasks[2]?.constraints?.minimum_artifact_count, 2);
    assert.equal(result.status, "need_executor");
    assert.equal(result.audit.notes.includes("Skill workflow template applied"), true);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("runPlannerStep materializes builtin research skill into workflow plan", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "research",
    plannerInstruction: "Research task.",
    preferredTools: ["web_search", "url_fetch", "read_file"],
    requireEvidenceBeforeFinal: true,
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "find official sources",
      audit: {
        verdict: "approved",
        notes: "Use builtin official source discovery.",
      },
      skill: {
        skill_id: "find.official_sources",
        skill_action: "use_installed",
        skill_reason: "Need primary sources before synthesis.",
      },
      executor_request: {
        instruction: "Fallback if workflow cannot run.",
        allowed_tools: ["web_search"],
        expected_output: "Fallback source list.",
      },
    }),
  ]);

  try {
    installSkillRecord(config, {
      id: "find.official_sources",
      version: "0.1.0",
      title: "Official Source Discovery",
      description: "Find official docs, repositories, release notes, and primary sources.",
      intents: ["research"],
      keywords: ["official", "latest", "release", "source", "documentation", "repo", "github", "announcement"],
      requiredTools: ["web_search", "url_fetch", "read_file"],
      install: {
        source: "builtin",
        location: "skills/find.official_sources",
      },
      activation: {
        mode: "intent_match",
        priority: 100,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_official_sources_v1",
      },
      verification: {
        requiredArtifacts: ["search_results", "primary_source_summary"],
        successSignal: "at_least_two_non_empty_primary_sources",
      },
    });

    const result = await orchestratorTestables.runPlannerStep(
      config,
      "Find the latest official TypeScript release notes and documentation",
      [],
      0,
      routePolicy,
      1,
      undefined,
      createFakeRuntimeDeps({
        runChatCompletionDetailed: fakeChat.runner,
      }),
    );

    assert.equal(result.skill?.skill_id, "find.official_sources");
    assert.equal(result.workflow_plan?.id, "find_official_sources_v1");
    assert.equal(result.workflow_plan?.strategy, "official_source_discovery+skill:find.official_sources");
    assert.equal(result.workflow_plan?.tasks.at(-1)?.kind, "verify");
    assert.equal(result.workflow_plan?.tasks.at(-1)?.constraints?.minimum_artifact_count, 2);
    assert.equal(result.status, "need_executor");
    assert.equal(result.audit.notes.includes("Skill workflow template applied"), true);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("runPlannerStep materializes builtin workspace file skill into workflow plan", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "code",
    plannerInstruction: "Workspace file task.",
    preferredTools: ["list_files", "read_file", "shell_command"],
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "find workspace files",
      audit: {
        verdict: "approved",
        notes: "Use builtin workspace file discovery.",
      },
      skill: {
        skill_id: "find.workspace_files",
        skill_action: "use_installed",
        skill_reason: "Need to locate concrete workspace config and schema files first.",
      },
      executor_request: {
        instruction: "Fallback if workflow cannot run.",
        allowed_tools: ["list_files"],
        expected_output: "Fallback workspace discovery output.",
      },
    }),
  ]);

  try {
    installSkillRecord(config, {
      id: "find.workspace_files",
      version: "0.1.0",
      title: "Workspace File Discovery",
      description: "Locate relevant workspace files, schemas, configs, and neighboring assets before deeper analysis or edits.",
      intents: ["coding"],
      keywords: ["file", "files", "workspace", "schema", "config", "directory", "folder", ".json", ".yml", ".yaml", ".env"],
      requiredTools: ["list_files", "read_file", "shell_command"],
      install: {
        source: "builtin",
        location: "skills/find.workspace_files",
      },
      activation: {
        mode: "intent_match",
        priority: 95,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_workspace_files_v1",
      },
      verification: {
        requiredArtifacts: ["file_hits", "config_excerpt"],
        successSignal: "at_least_one_relevant_workspace_target",
      },
    });

    const result = await orchestratorTestables.runPlannerStep(
      config,
      "Find the relevant config files and schema files in this workspace",
      [],
      0,
      routePolicy,
      1,
      undefined,
      createFakeRuntimeDeps({
        runChatCompletionDetailed: fakeChat.runner,
      }),
    );

    assert.equal(result.skill?.skill_id, "find.workspace_files");
    assert.equal(result.workflow_plan?.id, "find_workspace_files_v1");
    assert.equal(result.status, "need_executor");
    assert.equal(result.audit.notes.includes("Skill workflow template applied"), true);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("runPlannerStep materializes builtin integration point skill into workflow plan", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "code",
    plannerInstruction: "Integration tracing task.",
    preferredTools: ["list_files", "read_file", "shell_command"],
  });
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "find integration points",
      audit: {
        verdict: "approved",
        notes: "Use builtin integration point discovery.",
      },
      skill: {
        skill_id: "find.integration_points",
        skill_action: "use_installed",
        skill_reason: "Need to trace handlers, events, and entry points before changing behavior.",
      },
      executor_request: {
        instruction: "Fallback if workflow cannot run.",
        allowed_tools: ["list_files"],
        expected_output: "Fallback integration discovery output.",
      },
    }),
  ]);

  try {
    installSkillRecord(config, {
      id: "find.integration_points",
      version: "0.1.0",
      title: "Integration Point Discovery",
      description: "Identify integration boundaries such as routes, handlers, events, persistence layers, and UI consumption points.",
      intents: ["coding"],
      keywords: ["integration", "entrypoint", "entry point", "hook", "handler", "event", "api", "endpoint", "consumer", "producer", "wiring"],
      requiredTools: ["list_files", "read_file", "shell_command"],
      install: {
        source: "builtin",
        location: "skills/find.integration_points",
      },
      activation: {
        mode: "intent_match",
        priority: 98,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_integration_points_v1",
      },
      verification: {
        requiredArtifacts: ["integration_hits", "call_path_excerpt"],
        successSignal: "at_least_one_relevant_integration_boundary",
      },
    });

    const result = await orchestratorTestables.runPlannerStep(
      config,
      "Find the API handlers, event wiring, and integration entry points for this feature",
      [],
      0,
      routePolicy,
      1,
      undefined,
      createFakeRuntimeDeps({
        runChatCompletionDetailed: fakeChat.runner,
      }),
    );

    assert.equal(result.skill?.skill_id, "find.integration_points");
    assert.equal(result.workflow_plan?.id, "find_integration_points_v1");
    assert.equal(result.status, "need_executor");
    assert.equal(result.audit.notes.includes("Skill workflow template applied"), true);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("runPlannerStep does not auto-install builtin skill when skills.auto_install is disabled", async () => {
  const config = buildMinimalConfig();
  const routePolicy = buildRoutePolicy({
    type: "code",
    plannerInstruction: "Code task.",
    preferredTools: ["list_files", "read_file", "shell_command"],
  });
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "locate repository entrypoints",
      audit: {
        verdict: "approved",
        notes: "Install then use builtin symbol discovery.",
      },
      skill: {
        skill_id: "find.code_symbol",
        skill_action: "install_then_use",
        skill_reason: "Need stable repository discovery before editing.",
      },
      executor_request: {
        instruction: "Fallback if workflow cannot run.",
        allowed_tools: ["list_files"],
        expected_output: "Fallback discovery output.",
      },
    }),
  ]);

  try {
    const result = await orchestratorTestables.runPlannerStep(
      config,
      "Debug src/index.ts and locate the route entrypoint",
      [],
      0,
      routePolicy,
      1,
      undefined,
      createFakeRuntimeDeps({
        runChatCompletionDetailed: fakeChat.runner,
      }),
      {
        onEvent: (event) => {
          events.push({ type: event.type, data: event.data });
        },
      },
    );

    assert.equal(result.skill?.skill_id, "find.code_symbol");
    assert.equal(result.workflow_plan, undefined);
    assert.equal(result.audit.verdict, "retry");
    assert.equal(result.audit.notes.includes("skills.auto_install=true"), true);
    assert.equal(getInstalledSkillRecord(config, "find.code_symbol"), null);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "workflow.step.start",
        "system.skill_install_attempted",
        "system.skill_install_blocked",
        "workflow.planner.decision",
      ],
    );
    assert.equal(events[1]?.data.skill_id, "find.code_symbol");
    assert.equal(events[2]?.data.install_status, "blocked");
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("runPlannerStep auto-installs builtin skill when skills.auto_install is enabled", async () => {
  const config = buildMinimalConfig();
  config.skills.autoInstall = true;
  const routePolicy = buildRoutePolicy({
    type: "code",
    plannerInstruction: "Code task.",
    preferredTools: ["list_files", "read_file", "shell_command"],
  });
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "locate repository entrypoints",
      audit: {
        verdict: "approved",
        notes: "Install then use builtin symbol discovery.",
      },
      skill: {
        skill_id: "find.code_symbol",
        skill_action: "install_then_use",
        skill_reason: "Need stable repository discovery before editing.",
      },
      executor_request: {
        instruction: "Fallback if workflow cannot run.",
        allowed_tools: ["list_files"],
        expected_output: "Fallback discovery output.",
      },
    }),
  ]);

  try {
    const result = await orchestratorTestables.runPlannerStep(
      config,
      "Debug src/index.ts and locate the route entrypoint",
      [],
      0,
      routePolicy,
      1,
      undefined,
      createFakeRuntimeDeps({
        runChatCompletionDetailed: fakeChat.runner,
      }),
      {
        onEvent: (event) => {
          events.push({ type: event.type, data: event.data });
        },
      },
    );

    assert.equal(result.skill?.skill_id, "find.code_symbol");
    assert.equal(result.workflow_plan?.id, "find_code_symbol_v1");
    assert.equal(result.audit.notes.includes("Skill workflow template applied"), true);
    assert.notEqual(getInstalledSkill("find.code_symbol", config), null);
    assert.notEqual(getInstalledSkillRecord(config, "find.code_symbol"), null);
    assert.deepEqual(
      events.slice(0, 3).map((event) => event.type),
      [
        "workflow.step.start",
        "system.skill_install_attempted",
        "system.skill_install_completed",
      ],
    );
    assert.equal(events.some((event) => event.type === "workflow.plan.created"), true);
    assert.equal(events.some((event) => event.type === "workflow.plan.validated"), true);
    assert.equal(events.at(-1)?.type, "workflow.planner.decision");
    assert.equal(events[1]?.data.skill_id, "find.code_symbol");
    assert.equal(events[2]?.data.install_status, "installed");
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("runPlannerStep scopes research readback requests to current-run artifact paths", async () => {
  const config = buildMinimalConfig();
  const routePolicy = {
    ...buildRoutePolicy(),
    type: "research" as const,
    requireEvidenceBeforeFinal: true,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    enableRanking: true,
    minGroundedCandidates: 1,
  };

  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "final",
      step: "finalize_from_partial_evidence",
      answer: "Tentative answer without enough grounded readback.",
      audit: {
        verdict: "approved",
        notes: "Attempting to finalize from currently available evidence.",
      },
    }),
  ]);

  const result = await orchestratorTestables.runPlannerStep(
    config,
    "Research the latest official TypeScript 5.x release highlights and provide a concise sourced summary",
    [
      {
        status: "success",
        summary: "Found 10 results",
        tool_calls_made: [{ tool: "web_search", arguments: { query: "TypeScript 5.x" } }],
        artifacts: [
          {
            type: "json",
            path: "runtime/command-results/001-web-search.json",
            content_preview: "[{\"title\":\"TypeScript\"}]",
          },
        ],
        raw_result: "[{\"title\":\"TypeScript\"}]",
        source: "native_tool",
      },
      {
        status: "success",
        summary: "Fetched official page",
        tool_calls_made: [{ tool: "url_fetch", arguments: { url: "https://www.typescriptlang.org/docs" } }],
        artifacts: [
          {
            type: "file",
            path: "runtime/command-results/002-url-fetch.txt",
            content_preview: "official docs content",
          },
        ],
        raw_result: "official docs content",
        source: "native_tool",
      },
    ],
    0,
    routePolicy,
    1,
    undefined,
    createFakeRuntimeDeps({
      runChatCompletionDetailed: fakeChat.runner,
    }),
  );

  assert.equal(result.status, "need_executor");
  assert.equal(result.executor_request?.allowed_tools.includes("list_files"), false);
  assert.equal(result.executor_request?.allowed_tools.includes("read_file"), true);
  assert.equal(result.executor_request?.instruction.includes("Read only these current-run artifact files"), true);
  assert.equal(result.executor_request?.instruction.includes("runtime/command-results/001-web-search.json"), true);
  assert.equal(result.executor_request?.instruction.includes("runtime/command-results/002-url-fetch.txt"), true);
  assert.equal(result.executor_request?.instruction.includes("Do not inspect unrelated workspace files"), true);
});

test("runOrchestrator main loop rewrites broad research readback requests to current-run artifact paths", async () => {
  const config = buildMinimalConfig();
  config.policy.maxSteps = 3;
  const routePolicy = {
    ...buildRoutePolicy(),
    type: "research" as const,
    requireEvidenceBeforeFinal: true,
    requireArtifactReadback: true,
    requireNonEmptyArtifact: true,
    enableRanking: true,
    minGroundedCandidates: 1,
  };

  const commandDir = resolve(WORKSPACE_ROOT, "runtime", "command-results");
  const webSearchPath = resolve(commandDir, "test-main-loop-web-search.json");
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(webSearchPath, "[{\"title\":\"TypeScript 5.9\"}]", "utf8");

  const fakeChat = createFakeChatRunner([
    modelResponseFromJson({
      status: "need_executor",
      step: "search",
      executor_request: {
        instruction: "Search official TypeScript release sources.",
        allowed_tools: ["web_search"],
        expected_output: "search results",
      },
      audit: { verdict: "not_applicable", notes: "" },
    }),
    modelResponseFromJson({
      status: "need_executor",
      step: "readback",
      executor_request: {
        instruction: "List and read the strongest non-empty search result artifact, then produce a grounded ranking with inclusion reasons and concerns. Do not invent projects that are not present in the evidence.",
        allowed_tools: ["read_file", "list_files"],
        expected_output: "grounded ranking",
      },
      audit: { verdict: "retry", notes: "" },
    }),
    modelResponseFromJson({
      status: "final",
      step: "finalize",
      answer: "done",
      audit: { verdict: "approved", notes: "" },
    }),
  ]);

  const executorRequests: string[] = [];
  const result = await orchestratorTestables.runOrchestrator(
    config,
    "Research the latest official TypeScript 5.x release highlights and provide a concise sourced summary",
    undefined,
    createFakeRuntimeDeps({
      runChatCompletionDetailed: fakeChat.runner,
      loadTaskRoutingConfig: () => routePolicy,
      runExecutorStep: async (_config, planner) => {
        executorRequests.push(planner.executor_request?.instruction ?? "");
        if (executorRequests.length === 1) {
          return {
            status: "success",
            summary: "Found search results",
            tool_calls_made: [{ tool: "web_search", arguments: { query: "TypeScript 5.x latest" } }],
            artifacts: [{ type: "json", path: webSearchPath, content_preview: "[{\"title\":\"TypeScript 5.9\"}]" }],
            raw_result: "[{\"title\":\"TypeScript 5.9\"}]",
            source: "native_tool",
          };
        }
        return {
          status: "success",
          summary: `Read file ${webSearchPath}`,
          tool_calls_made: [{ tool: "read_file", arguments: { path: webSearchPath } }],
          artifacts: [{ type: "file", path: webSearchPath, content_preview: "[{\"title\":\"TypeScript 5.9\"}]" }],
          raw_result: "[{\"title\":\"TypeScript 5.9\"}]",
          source: "native_tool",
        };
      },
    }),
  );

  assert.equal(result.status, "final");
  assert.equal(executorRequests.length >= 2, true);
  assert.equal(executorRequests[1]?.includes("Read only these current-run artifact files"), true);
  assert.equal(executorRequests[1]?.includes("Do not inspect unrelated workspace files"), true);
  assert.equal(executorRequests[1]?.includes(webSearchPath), true);
  assert.equal(executorRequests[1]?.includes("list and read the strongest non-empty search result artifact"), false);

  rmSync(webSearchPath, { force: true });
});
