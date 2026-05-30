import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InstalledSkillRecord, SkillInstallResult, SkillManifest } from "./skill-types.js";
import type { OrchestratorConfig } from "./types.js";
import { PROJECT_ROOT } from "./paths.js";
import { validateSkillManifestShape } from "./skill-manifest-schema.js";

const INSTALLED_REGISTRY_FILENAME = "installed.json";

function resolveConfiguredPath(pathText: string): string {
  return resolve(PROJECT_ROOT, pathText);
}

function installedRegistryPath(config: OrchestratorConfig): string {
  return resolve(resolveConfiguredPath(config.skills.installDir), INSTALLED_REGISTRY_FILENAME);
}

function builtinSkillsRoot(config: OrchestratorConfig): string {
  return resolveConfiguredPath(config.skills.builtinDir);
}

function ensureInstallRoot(config: OrchestratorConfig): void {
  mkdirSync(resolveConfiguredPath(config.skills.installDir), { recursive: true });
}

function readInstalledRegistry(config: OrchestratorConfig): InstalledSkillRecord[] {
  try {
    return JSON.parse(readFileSync(installedRegistryPath(config), "utf8")) as InstalledSkillRecord[];
  } catch {
    return [];
  }
}

function readManifestFile(path: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
    return validateSkillManifestShape(parsed).length === 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readBuiltinManifest(config: OrchestratorConfig, skillId: string): SkillManifest | null {
  const root = builtinSkillsRoot(config);
  if (!existsSync(root)) {
    return null;
  }
  const direct = readManifestFile(resolve(root, skillId, "skill.json"));
  if (direct) {
    return direct;
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifest = readManifestFile(resolve(root, entry.name, "skill.json"));
      return manifest ? [manifest] : [];
    })
    .find((manifest) => manifest.id === skillId) ?? null;
}

function readLocalDirManifest(config: OrchestratorConfig, skillId: string): SkillManifest | null {
  const root = resolveConfiguredPath(config.skills.installDir);
  if (!existsSync(root)) {
    return null;
  }
  const direct = readManifestFile(resolve(root, skillId, "skill.json"));
  if (direct) {
    return direct;
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifest = readManifestFile(resolve(root, entry.name, "skill.json"));
      return manifest ? [manifest] : [];
    })
    .find((manifest) => manifest.id === skillId) ?? null;
}

function resolveManifestForInstall(config: OrchestratorConfig, skillId: string): SkillManifest | null {
  if (config.skills.allowSources.includes("builtin")) {
    const builtin = readBuiltinManifest(config, skillId);
    if (builtin) {
      return builtin;
    }
  }
  if (config.skills.allowSources.includes("local_dir")) {
    const local = readLocalDirManifest(config, skillId);
    if (local) {
      return local;
    }
  }
  return null;
}

function writeInstalledRegistry(config: OrchestratorConfig, records: InstalledSkillRecord[]): void {
  ensureInstallRoot(config);
  writeFileSync(installedRegistryPath(config), JSON.stringify(records, null, 2), "utf8");
}

export function listInstalledSkillRecords(config: OrchestratorConfig): InstalledSkillRecord[] {
  return readInstalledRegistry(config);
}

export function getInstalledSkillRecord(config: OrchestratorConfig, skillId: string): InstalledSkillRecord | null {
  return readInstalledRegistry(config).find((record) => record.id === skillId) ?? null;
}

export function validateSkillManifest(manifest: SkillManifest, config: OrchestratorConfig): void {
  const shapeIssues = validateSkillManifestShape(manifest);
  if (shapeIssues.length > 0) {
    throw new Error(`Skill manifest schema validation failed: ${shapeIssues.join(" ")}`);
  }
  if (!manifest.id.trim()) {
    throw new Error("Skill manifest id must be non-empty.");
  }
  if (!config.skills.allowSources.includes(manifest.install.source)) {
    throw new Error(`Skill source "${manifest.install.source}" is not allowed by config.`);
  }
}

export function installSkillRecord(config: OrchestratorConfig, manifest: SkillManifest): InstalledSkillRecord {
  validateSkillManifest(manifest, config);
  const location = manifest.install.source === "builtin"
    ? resolveConfiguredPath(manifest.install.location)
    : resolveConfiguredPath(config.skills.installDir);
  if (manifest.install.source === "builtin" && !existsSync(location)) {
    throw new Error(`Builtin skill directory does not exist: ${location}`);
  }

  const records = readInstalledRegistry(config);
  const nextRecord: InstalledSkillRecord = {
    id: manifest.id,
    version: manifest.version,
    installedAt: new Date().toISOString(),
    source: manifest.install.source,
    location,
    enabled: true,
    checksum: manifest.install.checksum,
  };
  const deduped = [
    ...records.filter((record) => record.id !== manifest.id),
    nextRecord,
  ].sort((left, right) => left.id.localeCompare(right.id));
  writeInstalledRegistry(config, deduped);
  return nextRecord;
}

export function installSkillById(
  config: OrchestratorConfig,
  skillId: string,
  options?: { requireAutoInstallEnabled?: boolean },
): SkillInstallResult {
  const normalizedSkillId = skillId.trim();
  if (!normalizedSkillId) {
    return {
      skillId: "",
      status: "failed",
      reason: "Skill id must be non-empty.",
    };
  }

  if (!config.skills.enabled) {
    return {
      skillId: normalizedSkillId,
      status: "blocked",
      reason: "Skill installation is disabled because the skill layer is turned off.",
    };
  }

  if (options?.requireAutoInstallEnabled && !config.skills.autoInstall) {
    return {
      skillId: normalizedSkillId,
      status: "blocked",
      reason: "Skill installation requires skills.auto_install=true.",
    };
  }

  const manifest = resolveManifestForInstall(config, normalizedSkillId);
  if (!manifest) {
    return {
      skillId: normalizedSkillId,
      status: "unavailable",
      reason: "No available skill manifest was found for this skill id.",
    };
  }

  const existing = getInstalledSkillRecord(config, normalizedSkillId);
  if (existing) {
    return {
      skillId: normalizedSkillId,
      status: "already_installed",
      reason: "Skill is already present in the installed registry.",
      source: existing.source,
      location: existing.location,
      record: existing,
    };
  }

  try {
    const record = installSkillRecord(config, manifest);
    return {
      skillId: normalizedSkillId,
      status: "installed",
      reason: "Skill install record created successfully.",
      source: record.source,
      location: record.location,
      record,
    };
  } catch (error) {
    return {
      skillId: normalizedSkillId,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      source: manifest.install.source,
    };
  }
}
