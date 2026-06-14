import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  resolveSkillEvolutionLiveTargetPath,
  resolveSkillEvolutionSnapshotTargetPath,
} from "../../src/skill-evolution-store.js";

test("skill evolution live targets stay inside the workspace", () => {
  const resolved = resolveSkillEvolutionLiveTargetPath("skills/find.code_symbol/SKILL.md");

  assert.equal(resolved, resolve(process.cwd(), "skills/find.code_symbol/SKILL.md"));
  assert.throws(
    () => resolveSkillEvolutionLiveTargetPath("../outside/SKILL.md"),
    /escapes the workspace/,
  );
  assert.throws(
    () => resolveSkillEvolutionLiveTargetPath(resolve(process.cwd(), "..", "outside", "SKILL.md")),
    /escapes the workspace/,
  );
});

test("skill evolution snapshot targets stay inside their snapshot root", () => {
  const snapshotRoot = resolve(process.cwd(), "runtime/test-skill-evolution-store/candidate");
  const resolved = resolveSkillEvolutionSnapshotTargetPath(snapshotRoot, "skills/find.code_symbol/SKILL.md");

  assert.equal(resolved, resolve(snapshotRoot, "skills/find.code_symbol/SKILL.md"));
  assert.throws(
    () => resolveSkillEvolutionSnapshotTargetPath(snapshotRoot, "../rollback-escape/SKILL.md"),
    /escapes the snapshot root/,
  );
});
