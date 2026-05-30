import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAvailableSkills, listBuiltinSkills, listInstalledSkills, listLocalDirSkills, matchSkills } from "../../src/skill-registry.js";
import { installSkillRecord } from "../../src/skill-installer.js";
import type { OrchestratorConfig } from "../../src/types.js";

function buildSkillConfig(overrides?: Partial<OrchestratorConfig["skills"]>): OrchestratorConfig {
  const root = mkdtempSync(join(tmpdir(), "dao-skill-registry-"));
  return {
    planner: {
      provider: "openai_compatible",
      baseUrl: "http://planner.test/v1",
      apiKey: "planner-key",
      model: "planner-model",
      timeoutMs: 1000,
      maxTokens: 256,
      temperature: 0,
    },
    executor: {
      provider: "openai_compatible",
      baseUrl: "http://executor.test/v1",
      apiKey: "executor-key",
      model: "executor-model",
      timeoutMs: 1000,
      maxTokens: 256,
      temperature: 0,
    },
    modelRegistry: {},
    modelRouting: {
      plannerCandidates: [],
      executorCandidates: [],
    },
    skills: {
      enabled: true,
      autoInstall: false,
      builtinDir: "skills",
      installDir: root,
      allowSources: ["builtin", "local_dir"],
      ...overrides,
    },
    policy: {
      maxSteps: 4,
      maxReplans: 2,
      maxToolRetries: 1,
      plannerHistoryMaxEntries: 4,
      plannerHistoryPreviewChars: 120,
      maxRepeatedExecutorRequests: 2,
      autoResumeConcurrency: 3,
    },
    taskRoutingPath: "config/task-routing.yml",
  };
}

function writeBuiltinSkillManifest(root: string, manifest: Record<string, unknown>): void {
  const skillDir = join(root, String(manifest.id));
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.json"), JSON.stringify(manifest), "utf8");
}

test("skill registry exposes builtin skills", () => {
  const skills = listBuiltinSkills();
  const codeSymbol = skills.find((skill) => skill.id === "find.code_symbol");

  assert.equal(skills.some((skill) => skill.id === "find.code_symbol"), true);
  assert.equal(skills.some((skill) => skill.id === "find.official_sources"), true);
  assert.equal(skills.some((skill) => skill.id === "find.workspace_files"), true);
  assert.equal(skills.some((skill) => skill.id === "find.integration_points"), true);
  assert.equal(codeSymbol?.verification?.artifactLabels?.symbol_hits, "relevant symbol hits");
  assert.equal(codeSymbol?.verification?.successSignalLabel, "identify at least one relevant entrypoint");
  assert.equal(
    codeSymbol?.verification?.remediation?.insufficient,
    "Capture concrete symbol hits and supporting file excerpts, then rerun skill verification.",
  );
});

test("skill registry reads builtin skills from configured builtinDir", () => {
  const builtinRoot = mkdtempSync(join(tmpdir(), "dao-builtin-skills-"));
  const config = buildSkillConfig({
    builtinDir: builtinRoot,
    allowSources: ["builtin"],
  });
  try {
    writeBuiltinSkillManifest(builtinRoot, {
      id: "find.custom_builtin",
      version: "0.2.0",
      title: "Custom Builtin Discovery",
      description: "Custom builtin skill loaded from disk.",
      intents: ["coding"],
      keywords: ["custom", "builtin"],
      requiredTools: ["list_files"],
      install: {
        source: "builtin",
        location: "tmp/find.custom_builtin",
      },
      activation: {
        mode: "intent_match",
        priority: 77,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_custom_builtin_v1",
      },
    });

    const skills = listBuiltinSkills(config);
    assert.deepEqual(skills.map((skill) => skill.id), ["find.custom_builtin"]);
    assert.equal(skills[0]?.title, "Custom Builtin Discovery");
  } finally {
    rmSync(builtinRoot, { recursive: true, force: true });
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill registry matches coding discovery skills", () => {
  const matches = matchSkills("Please debug src/index.ts and find the route entrypoint", "coding");

  assert.equal(matches.length > 0, true);
  assert.equal(matches[0]?.skillId, "find.code_symbol");
});

test("skill registry matches official source discovery for research", () => {
  const matches = matchSkills("Find the latest official release notes and documentation", "research");

  assert.equal(matches.length > 0, true);
  assert.equal(matches[0]?.skillId, "find.official_sources");
});

test("skill registry matches workspace file discovery for coding file-location prompts", () => {
  const matches = matchSkills("Find the relevant config files and schema files in this workspace", "coding");

  assert.equal(matches.length > 0, true);
  assert.equal(matches.some((match) => match.skillId === "find.workspace_files"), true);
});

test("skill registry matches integration point discovery for architecture tracing prompts", () => {
  const matches = matchSkills("Find the API handlers, event wiring, and integration entry points for this feature", "coding");

  assert.equal(matches.length > 0, true);
  assert.equal(matches.some((match) => match.skillId === "find.integration_points"), true);
});

test("skill registry discovers local_dir skill manifests from install_dir", () => {
  const config = buildSkillConfig();
  try {
    const skillDir = join(config.skills.installDir, "find.workspace_files");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
      id: "find.workspace_files",
      version: "0.1.0",
      title: "Workspace File Discovery",
      description: "Locate workspace files and neighboring schemas.",
      intents: ["coding"],
      keywords: ["file", "workspace"],
      requiredTools: ["list_files", "read_file"],
      install: {
        source: "local_dir",
        location: "runtime/skills/find.workspace_files",
      },
      activation: {
        mode: "intent_match",
        priority: 90,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_workspace_files_v1",
      },
    }), "utf8");

    const localSkills = listLocalDirSkills(config);
    const availableSkills = listAvailableSkills(config);
    assert.equal(localSkills.some((skill) => skill.id === "find.workspace_files"), true);
    assert.equal(availableSkills.some((skill) => skill.id === "find.workspace_files"), true);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill registry rejects local_dir manifests with invalid remediation schema", () => {
  const config = buildSkillConfig();
  try {
    const skillDir = join(config.skills.installDir, "find.invalid_skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
      id: "find.invalid_skill",
      version: "0.1.0",
      title: "Invalid Skill",
      description: "Invalid remediation schema.",
      intents: ["coding"],
      keywords: ["invalid"],
      requiredTools: ["list_files"],
      install: {
        source: "local_dir",
        location: "runtime/skills/find.invalid_skill",
      },
      activation: {
        mode: "intent_match",
        priority: 90,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_workspace_files_v1",
      },
      verification: {
        requiredArtifacts: ["file_hits"],
        remediation: {
          retry: "unsupported key",
        },
      },
    }), "utf8");

    const localSkills = listLocalDirSkills(config);
    assert.equal(localSkills.some((skill) => skill.id === "find.invalid_skill"), false);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill installer records builtin installs in the installed registry", () => {
  const config = buildSkillConfig();
  try {
    const manifest = listBuiltinSkills(config).find((skill) => skill.id === "find.code_symbol");
    assert.notEqual(manifest, undefined);
    installSkillRecord(config, manifest!);

    const installed = listInstalledSkills(config);
    const record = installed.find((entry) => entry.id === "find.code_symbol");
    assert.equal(record?.source, "builtin");
    assert.equal(record?.enabled, true);
    assert.equal(Boolean(record?.location), true);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});

test("skill installer rejects manifests with invalid remediation schema", () => {
  const config = buildSkillConfig();
  try {
    assert.throws(() => installSkillRecord(config, {
      id: "find.invalid_manifest",
      version: "0.1.0",
      title: "Invalid Manifest",
      description: "Bad remediation field.",
      intents: ["coding"],
      keywords: ["invalid"],
      requiredTools: ["list_files"],
      install: {
        source: "local_dir",
        location: "runtime/skills/find.invalid_manifest",
      },
      activation: {
        mode: "intent_match",
        priority: 90,
      },
      execution: {
        strategy: "workflow_template",
        templateId: "find_workspace_files_v1",
      },
      verification: {
        requiredArtifacts: ["file_hits"],
        artifactLabels: {
          config_excerpt: "orphan label",
        },
      },
    }), /schema validation failed/i);
  } finally {
    rmSync(config.skills.installDir, { recursive: true, force: true });
  }
});
