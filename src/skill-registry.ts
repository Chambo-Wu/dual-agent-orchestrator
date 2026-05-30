import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { InstalledSkillRecord, SkillManifest, SkillMatchResult } from "./skill-types.js";
import type { IntentRouteKind, OrchestratorConfig } from "./types.js";
import { PROJECT_ROOT } from "./paths.js";
import { getInstalledSkillRecord, listInstalledSkillRecords } from "./skill-installer.js";
import { validateSkillManifestShape } from "./skill-manifest-schema.js";

function mapIntentKind(intentKind: IntentRouteKind): SkillManifest["intents"][number] | null {
  switch (intentKind) {
    case "coding":
      return "coding";
    case "research":
      return "research";
    case "goal":
      return "goal_planning";
    default:
      return null;
  }
}

function scoreSkill(goal: string, manifest: SkillManifest): SkillMatchResult | null {
  const normalized = goal.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const keyword of manifest.keywords) {
    if (normalized.includes(keyword.toLowerCase())) {
      score += 2;
      reasons.push(`keyword:${keyword}`);
    }
  }

  if (manifest.id === "find.code_symbol" && /(src[\\/]|\.ts\b|\.tsx\b|\.js\b|\.jsx\b|function|class|module|route|api)/i.test(goal)) {
    score += 3;
    reasons.push("workspace_or_symbol_signal");
  }

  if (manifest.id === "find.official_sources" && /(official|latest|release|documentation|docs|announcement|repo|github|source)/i.test(goal)) {
    score += 3;
    reasons.push("official_source_signal");
  }

  if (manifest.id === "find.workspace_files" && /(file|files|workspace|schema|config|directory|folder|manifest|json|yaml|yml|env)/i.test(goal)) {
    score += 3;
    reasons.push("workspace_file_signal");
  }

  if (manifest.id === "find.integration_points" && /(integration|entrypoint|entry point|handler|event|api|endpoint|consumer|producer|wiring|hook)/i.test(goal)) {
    score += 3;
    reasons.push("integration_boundary_signal");
  }

  if (score <= 0) {
    return null;
  }

  return {
    skillId: manifest.id,
    score,
    reasons,
    source: "rule",
  };
}

function cloneManifest(skill: SkillManifest): SkillManifest {
  return {
    ...skill,
    intents: [...skill.intents],
    keywords: [...skill.keywords],
    requiredTools: [...skill.requiredTools],
    optionalTools: skill.optionalTools ? [...skill.optionalTools] : undefined,
    install: { ...skill.install },
    activation: { ...skill.activation },
    execution: { ...skill.execution },
    verification: skill.verification ? {
      requiredArtifacts: skill.verification.requiredArtifacts ? [...skill.verification.requiredArtifacts] : undefined,
      successSignal: skill.verification.successSignal,
      artifactLabels: skill.verification.artifactLabels ? { ...skill.verification.artifactLabels } : undefined,
      successSignalLabel: skill.verification.successSignalLabel,
      remediation: skill.verification.remediation ? { ...skill.verification.remediation } : undefined,
    } : undefined,
  };
}

function resolveConfiguredPath(pathText: string): string {
  return resolve(PROJECT_ROOT, pathText);
}

function getBuiltinSkillsRoot(config?: OrchestratorConfig): string {
  return resolveConfiguredPath(config?.skills.builtinDir ?? "skills");
}

function readManifestFile(path: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
    return validateSkillManifestShape(parsed).length === 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function listLocalDirSkills(config: OrchestratorConfig): SkillManifest[] {
  const root = resolveConfiguredPath(config.skills.installDir);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifest = readManifestFile(resolve(root, entry.name, "skill.json"));
      return manifest ? [manifest] : [];
    });
}

export function listBuiltinSkills(config?: OrchestratorConfig): SkillManifest[] {
  const root = getBuiltinSkillsRoot(config);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifest = readManifestFile(resolve(root, entry.name, "skill.json"));
      return manifest ? [cloneManifest(manifest)] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function listAvailableSkills(config?: OrchestratorConfig): SkillManifest[] {
  const builtin = listBuiltinSkills(config).map(cloneManifest);
  if (!config || !config.skills.enabled) {
    return builtin;
  }
  const local = config.skills.allowSources.includes("local_dir")
    ? listLocalDirSkills(config).map(cloneManifest)
    : [];
  const byId = new Map<string, SkillManifest>();
  for (const manifest of [...builtin, ...local]) {
    byId.set(manifest.id, manifest);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function getSkillManifest(skillId: string, config?: OrchestratorConfig): SkillManifest | null {
  return listAvailableSkills(config).find((skill) => skill.id === skillId) ?? null;
}

export function listInstalledSkills(config?: OrchestratorConfig): InstalledSkillRecord[] {
  if (!config || !config.skills.enabled) {
    return listBuiltinSkills(config).map((skill) => ({
      id: skill.id,
      version: skill.version,
      installedAt: "",
      source: "builtin",
      location: resolveConfiguredPath(skill.install.location),
      enabled: true,
      checksum: skill.install.checksum,
    }));
  }
  const explicit = listInstalledSkillRecords(config);
  const builtin = config.skills.allowSources.includes("builtin")
    ? listBuiltinSkills(config).map((skill) => ({
      id: skill.id,
      version: skill.version,
      installedAt: "",
      source: "builtin" as const,
      location: resolveConfiguredPath(skill.install.location),
      enabled: true,
      checksum: skill.install.checksum,
    }))
    : [];
  const byId = new Map<string, InstalledSkillRecord>();
  for (const record of [...builtin, ...explicit]) {
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function getInstalledSkill(skillId: string, config?: OrchestratorConfig): InstalledSkillRecord | null {
  if (!config) {
    return listInstalledSkills().find((record) => record.id === skillId) ?? null;
  }
  return getInstalledSkillRecord(config, skillId)
    ?? listInstalledSkills(config).find((record) => record.id === skillId)
    ?? null;
}

export function matchSkills(goal: string, intentKind: IntentRouteKind): SkillMatchResult[] {
  const mappedIntent = mapIntentKind(intentKind);
  if (!mappedIntent) {
    return [];
  }
  return listBuiltinSkills()
    .filter((skill) => skill.intents.includes(mappedIntent))
    .flatMap((skill) => {
      const result = scoreSkill(goal, skill);
      return result ? [result] : [];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}
