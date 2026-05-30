import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildCandidateReplayConfig, probeCandidateRuntimeWorkflow, resolveCandidateReplayBuiltinDir, runCandidateRuntimeWorkflowReplay } from "../../src/skill-replay-runtime.js";
import { loadConfig } from "../../src/config.js";
import type { SkillEvolutionProposal } from "../../src/skill-evolution-types.js";
import { createJobRecord, createPlanRecord, createTaskRunRecord } from "../../src/workflow-contract.js";

function buildProposal(targetFiles: string[]): SkillEvolutionProposal {
  return {
    id: "proposal_runtime_test",
    skillId: "find.code_symbol",
    sourceReflectionId: "refl_runtime_test",
    status: "draft",
    targetFiles,
    patchSummary: "runtime test proposal",
    patchText: "patch",
    candidateDir: "runtime/skill-evolution",
    createdAt: new Date().toISOString(),
  };
}

function writeCandidateManifest(proposalId = "proposal_runtime_test"): string {
  const manifestPath = resolve(
    process.cwd(),
    `runtime/skill-evolution/proposals/${proposalId}/candidate/skills/find.code_symbol/skill.json`,
  );
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    id: "find.code_symbol",
    version: "0.1.0",
    title: "Code Symbol Discovery",
    description: "Locate symbols from candidate snapshot.",
    intents: ["coding"],
    keywords: ["symbol"],
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
      requiredArtifacts: ["symbol_hits"],
      successSignal: "at_least_one_relevant_entrypoint",
    },
  }, null, 2), "utf8");
  return manifestPath;
}

test("resolveCandidateReplayBuiltinDir derives builtin dir from candidate target files", () => {
  const resolved = resolveCandidateReplayBuiltinDir(buildProposal([
    "skills/find.code_symbol/SKILL.md",
    "skills/find.code_symbol/skill.json",
  ]));

  assert.equal(Boolean(resolved), true);
  assert.equal(resolved?.builtinDirRelative.endsWith("runtime/skill-evolution/proposals/proposal_runtime_test/candidate/skills"), true);
  assert.equal(resolved?.targetFile, "skills/find.code_symbol/skill.json");
});

test("buildCandidateReplayConfig points builtinDir at the candidate snapshot", () => {
  const baseConfig = loadConfig();
  const replayConfig = buildCandidateReplayConfig(baseConfig, buildProposal([
    "skills/find.code_symbol/SKILL.md",
    "skills/find.code_symbol/skill.json",
  ]));

  assert.equal(replayConfig.runtimeSource.prepared, true);
  assert.equal(replayConfig.runtimeSource.skillId, "find.code_symbol");
  assert.equal(replayConfig.config.skills.builtinDir.endsWith("runtime/skill-evolution/proposals/proposal_runtime_test/candidate/skills"), true);
});

test("probeCandidateRuntimeWorkflow materializes candidate workflow from snapshot", () => {
  const proposal = buildProposal([
    "skills/find.code_symbol/SKILL.md",
    "skills/find.code_symbol/skill.json",
  ]);
  writeCandidateManifest();

  try {
    const probe = probeCandidateRuntimeWorkflow({
      baseConfig: loadConfig(),
      proposal,
    });

    assert.equal(probe.configPrepared, true);
    assert.equal(probe.workflowMaterialized, true);
    assert.equal(probe.workflowTaskCount >= 2, true);
    assert.equal(probe.workflowStrategy?.includes("skill:find.code_symbol"), true);
  } finally {
    rmSync(resolve(process.cwd(), "runtime/skill-evolution/proposals/proposal_runtime_test"), { recursive: true, force: true });
  }
});

test("runCandidateRuntimeWorkflowReplay executes candidate workflow with deterministic replay deps", async () => {
  const proposal = buildProposal([
    "skills/find.code_symbol/SKILL.md",
    "skills/find.code_symbol/skill.json",
  ]);
  writeCandidateManifest();
  const taskRun = createTaskRunRecord({
    id: "baseline_task",
    title: "Baseline symbol lookup",
    description: "Locate a symbol.",
    status: "completed",
    verified: true,
    output: "symbol hits found",
    artifacts: [{
      id: "baseline_symbol_hits",
      type: "text",
      contentPreview: "symbol hits and relevant entrypoint evidence",
      source: "task_run",
    }],
    attempts: 1,
  });
  const plan = createPlanRecord({
    id: "baseline_plan",
    goal: "Find symbol hits.",
    mode: "task",
    taskRunIds: [taskRun.id],
    summary: "Baseline plan.",
  });
  const job = createJobRecord({
    id: "baseline_job",
    goal: plan.goal,
    mode: "task",
    status: "completed",
    verified: true,
    output: "done",
    plan,
    taskRuns: [taskRun],
    artifacts: taskRun.artifacts,
    verificationResult: {
      status: "verified",
      summary: "Baseline verified.",
      checks: [{
        name: "artifact_presence",
        passed: true,
        status: "passed",
        detail: "Required symbol artifact is present.",
      }],
    },
  });

  try {
    const replay = await runCandidateRuntimeWorkflowReplay({
      baseConfig: loadConfig(),
      proposal,
      baselineRecord: {
        job,
        plan,
        taskRuns: [taskRun],
        artifacts: taskRun.artifacts,
      },
    });

    assert.equal(replay.configPrepared, true);
    assert.equal(replay.workflowMaterialized, true);
    assert.equal(replay.workflowExecuted, true);
    assert.equal(replay.replayReady, true);
    assert.equal(replay.status, "completed");
    assert.equal(replay.verified, true);
    assert.equal(replay.taskRunCount, replay.workflowTaskCount);
    assert.equal(replay.artifactCount > 0, true);
  } finally {
    rmSync(resolve(process.cwd(), "runtime/skill-evolution/proposals/proposal_runtime_test"), { recursive: true, force: true });
  }
});
