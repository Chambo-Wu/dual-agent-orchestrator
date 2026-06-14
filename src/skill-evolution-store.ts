import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { PROJECT_ROOT, resolveRuntimeAwarePath } from "./paths.js";
import { buildCandidateManifestContent, buildStructuredSkillMarkdownCandidate } from "./skill-evolver.js";
import type {
  SkillAuditReport,
  SkillEvolutionDecisionRecord,
  SkillDeploymentValidationReport,
  SkillEvolutionProposal,
  SkillReflectionRecord,
} from "./skill-evolution-types.js";
import type { SkillManifest } from "./skill-types.js";

function reflectionsRoot(candidateDir = "runtime/skill-evolution"): string {
  return resolve(resolveRuntimeAwarePath(candidateDir), "reflections");
}

function proposalsRoot(candidateDir = "runtime/skill-evolution"): string {
  return resolve(resolveRuntimeAwarePath(candidateDir), "proposals");
}

function auditsRoot(candidateDir = "runtime/skill-evolution"): string {
  return resolve(resolveRuntimeAwarePath(candidateDir), "audits");
}

function validationsRoot(candidateDir = "runtime/skill-evolution"): string {
  return resolve(resolveRuntimeAwarePath(candidateDir), "validations");
}

function acceptedRoot(candidateDir = "runtime/skill-evolution"): string {
  return resolve(resolveRuntimeAwarePath(candidateDir), "accepted");
}

function rejectedRoot(candidateDir = "runtime/skill-evolution"): string {
  return resolve(resolveRuntimeAwarePath(candidateDir), "rejected");
}

function skillReflectionsDir(skillId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(reflectionsRoot(candidateDir), skillId);
}

function proposalDir(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(proposalsRoot(candidateDir), proposalId);
}

function reflectionPath(skillId: string, reflectionId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(skillReflectionsDir(skillId, candidateDir), `${reflectionId}.json`);
}

function proposalRecordPath(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(proposalDir(proposalId, candidateDir), "proposal.json");
}

function proposalPatchPath(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(proposalDir(proposalId, candidateDir), "patch.diff");
}

function proposalCandidateRoot(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(proposalDir(proposalId, candidateDir), "candidate");
}

function proposalRollbackRoot(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(proposalDir(proposalId, candidateDir), "rollback");
}

export function resolveSkillEvolutionLiveTargetPath(targetFile: string): string {
  const resolvedPath = isAbsolute(targetFile) ? resolve(targetFile) : resolve(PROJECT_ROOT, targetFile);
  assertPathWithinRoot(resolvedPath, PROJECT_ROOT, `Skill evolution target escapes the workspace: ${targetFile}`);
  return resolvedPath;
}

export function resolveSkillEvolutionSnapshotTargetPath(snapshotRoot: string, targetFile: string): string {
  const resolvedSnapshotRoot = resolve(snapshotRoot);
  if (!isAbsolute(targetFile)) {
    const resolvedPath = resolve(resolvedSnapshotRoot, targetFile);
    assertPathWithinRoot(resolvedPath, resolvedSnapshotRoot, `Skill evolution snapshot target escapes the snapshot root: ${targetFile}`);
    return resolvedPath;
  }
  const snapshotRelativeTarget = targetFile.replace(/\\/g, "/").replace(/:/g, "").replace(/^\/+/, "");
  const resolvedPath = resolve(resolvedSnapshotRoot, snapshotRelativeTarget);
  assertPathWithinRoot(resolvedPath, resolvedSnapshotRoot, `Skill evolution snapshot target escapes the snapshot root: ${targetFile}`);
  return resolvedPath;
}

function assertPathWithinRoot(path: string, root: string, message: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  const normalizedRelativePath = relativePath.replace(/\\/g, "/");
  if (isAbsolute(relativePath) || normalizedRelativePath === ".." || normalizedRelativePath.startsWith("../")) {
    throw new Error(message);
  }
}

function proposalCandidateFilePath(
  proposalId: string,
  targetFile: string,
  candidateDir = "runtime/skill-evolution",
): string {
  return resolveSkillEvolutionSnapshotTargetPath(proposalCandidateRoot(proposalId, candidateDir), targetFile);
}

function auditReportPath(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(auditsRoot(candidateDir), `${proposalId}.audit.json`);
}

function validationReportPath(proposalId: string, candidateDir = "runtime/skill-evolution"): string {
  return resolve(validationsRoot(candidateDir), `${proposalId}.validation.json`);
}

function decisionRecordPath(
  proposalId: string,
  decision: SkillEvolutionDecisionRecord["decision"],
  candidateDir = "runtime/skill-evolution",
): string {
  return resolve(decision === "accepted" ? acceptedRoot(candidateDir) : rejectedRoot(candidateDir), `${proposalId}.${decision}.json`);
}

function parseReflection(raw: string): SkillReflectionRecord | null {
  try {
    const parsed = JSON.parse(raw) as SkillReflectionRecord;
    return parsed
      && typeof parsed.id === "string"
      && typeof parsed.skillId === "string"
      && typeof parsed.jobId === "string"
      && typeof parsed.createdAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseProposal(raw: string): SkillEvolutionProposal | null {
  try {
    const parsed = JSON.parse(raw) as SkillEvolutionProposal;
    return parsed
      && typeof parsed.id === "string"
      && typeof parsed.skillId === "string"
      && typeof parsed.sourceReflectionId === "string"
      && typeof parsed.status === "string"
      && typeof parsed.patchSummary === "string"
      && typeof parsed.patchText === "string"
      && typeof parsed.candidateDir === "string"
      && typeof parsed.createdAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseAuditReport(raw: string): SkillAuditReport | null {
  try {
    const parsed = JSON.parse(raw) as SkillAuditReport;
    return parsed
      && typeof parsed.proposalId === "string"
      && typeof parsed.passed === "boolean"
      && Array.isArray(parsed.checks)
      && typeof parsed.summary === "string"
      && typeof parsed.createdAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseValidationReport(raw: string): SkillDeploymentValidationReport | null {
  try {
    const parsed = JSON.parse(raw) as SkillDeploymentValidationReport;
    return parsed
      && typeof parsed.proposalId === "string"
      && typeof parsed.passed === "boolean"
      && typeof parsed.summary === "string"
      && typeof parsed.createdAt === "string"
      && typeof parsed.decision === "object"
      && parsed.decision !== null
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseDecisionRecord(raw: string): SkillEvolutionDecisionRecord | null {
  try {
    const parsed = JSON.parse(raw) as SkillEvolutionDecisionRecord;
    return parsed
      && typeof parsed.proposalId === "string"
      && typeof parsed.skillId === "string"
      && (parsed.decision === "accepted" || parsed.decision === "rejected")
      && typeof parsed.createdAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readSkillReflectionForProposal(
  proposal: SkillEvolutionProposal,
  candidateDir = "runtime/skill-evolution",
): SkillReflectionRecord | null {
  try {
    const raw = readFileSync(reflectionPath(proposal.skillId, proposal.sourceReflectionId, candidateDir), "utf8");
    return parseReflection(raw);
  } catch {
    return null;
  }
}

function safeReadManifest(path: string): SkillManifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
  } catch {
    return null;
  }
}

function buildCandidateManifest(
  proposal: SkillEvolutionProposal,
  reflection: SkillReflectionRecord | null,
  existingManifest: SkillManifest | null,
): string {
  return buildCandidateManifestContent(proposal, reflection, existingManifest);
}

function buildCandidateFileContent(
  proposal: SkillEvolutionProposal,
  targetFile: string,
  sourcePath: string,
  reflection: SkillReflectionRecord | null,
): string | null {
  const normalizedTarget = targetFile.replace(/\\/g, "/");
  if (normalizedTarget.endsWith("/SKILL.md")) {
    const existingMarkdown = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : null;
    return buildStructuredSkillMarkdownCandidate(reflection ?? {
      id: proposal.sourceReflectionId,
      skillId: proposal.skillId,
      jobId: "",
      reflectionKind: "optimization",
      reason: "Create a structured candidate SKILL.md scaffold for safe evolution.",
      evidence: {
        failedCheckNames: [],
        missingRequirements: [],
        eventIds: [],
        artifactIds: [],
      },
      recommendedAction: "append_appendix",
      createdAt: proposal.createdAt,
    }, existingMarkdown, proposal.skillId);
  }
  if (normalizedTarget.endsWith("/skill.json")) {
    const existingManifest = existsSync(sourcePath) ? safeReadManifest(sourcePath) : null;
    return buildCandidateManifest(proposal, reflection, existingManifest);
  }
  return existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : null;
}

function materializeCandidateSkillSnapshot(
  proposal: SkillEvolutionProposal,
  candidateDir = "runtime/skill-evolution",
): void {
  mkdirSync(proposalCandidateRoot(proposal.id, candidateDir), { recursive: true });
  const reflection = readSkillReflectionForProposal(proposal, candidateDir);
  for (const targetFile of proposal.targetFiles) {
    const sourcePath = resolveSkillEvolutionLiveTargetPath(targetFile);
    const destinationPath = proposalCandidateFilePath(proposal.id, targetFile, candidateDir);
    mkdirSync(dirname(destinationPath), { recursive: true });
    const nextContent = buildCandidateFileContent(proposal, targetFile, sourcePath, reflection);
    if (nextContent === null) {
      continue;
    }
    writeFileSync(destinationPath, nextContent, "utf8");
  }
}

export function getSkillEvolutionProposalCandidateRoot(
  proposalId: string,
  candidateDir = "runtime/skill-evolution",
): string {
  return proposalCandidateRoot(proposalId, candidateDir);
}

export function getSkillEvolutionProposalRollbackRoot(
  proposalId: string,
  candidateDir = "runtime/skill-evolution",
): string {
  return proposalRollbackRoot(proposalId, candidateDir);
}

export function persistSkillReflectionRecord(
  record: SkillReflectionRecord,
  candidateDir = "runtime/skill-evolution",
): string {
  const dir = skillReflectionsDir(record.skillId, candidateDir);
  mkdirSync(dir, { recursive: true });
  const path = reflectionPath(record.skillId, record.id, candidateDir);
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return path;
}

export function listSkillReflectionRecords(
  skillId: string,
  candidateDir = "runtime/skill-evolution",
): SkillReflectionRecord[] {
  try {
    return readdirSync(skillReflectionsDir(skillId, candidateDir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try {
          const raw = readFileSync(resolve(skillReflectionsDir(skillId, candidateDir), entry.name), "utf8");
          const parsed = parseReflection(raw);
          return parsed ? [parsed] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  } catch {
    return [];
  }
}

export function readSkillReflectionRecord(
  skillId: string,
  reflectionId: string,
  candidateDir = "runtime/skill-evolution",
): SkillReflectionRecord | null {
  try {
    const raw = readFileSync(reflectionPath(skillId, reflectionId, candidateDir), "utf8");
    return parseReflection(raw);
  } catch {
    return null;
  }
}

export function persistSkillEvolutionProposal(
  proposal: SkillEvolutionProposal,
  candidateDir = "runtime/skill-evolution",
  options?: { materializeCandidateSnapshot?: boolean },
): string {
  const dir = proposalDir(proposal.id, candidateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(proposalRecordPath(proposal.id, candidateDir), JSON.stringify(proposal, null, 2), "utf8");
  writeFileSync(proposalPatchPath(proposal.id, candidateDir), proposal.patchText, "utf8");
  if (options?.materializeCandidateSnapshot !== false) {
    materializeCandidateSkillSnapshot(proposal, candidateDir);
  }
  return proposalRecordPath(proposal.id, candidateDir);
}

export function listSkillEvolutionProposals(candidateDir = "runtime/skill-evolution"): SkillEvolutionProposal[] {
  try {
    return readdirSync(proposalsRoot(candidateDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          const raw = readFileSync(proposalRecordPath(entry.name, candidateDir), "utf8");
          const parsed = parseProposal(raw);
          return parsed ? [parsed] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  } catch {
    return [];
  }
}

export function readSkillEvolutionProposal(
  proposalId: string,
  candidateDir = "runtime/skill-evolution",
): SkillEvolutionProposal | null {
  try {
    const raw = readFileSync(proposalRecordPath(proposalId, candidateDir), "utf8");
    return parseProposal(raw);
  } catch {
    return null;
  }
}

export function updateSkillEvolutionProposal(
  proposalId: string,
  updater: (proposal: SkillEvolutionProposal) => SkillEvolutionProposal,
  candidateDir = "runtime/skill-evolution",
): SkillEvolutionProposal | null {
  const existing = readSkillEvolutionProposal(proposalId, candidateDir);
  if (!existing) {
    return null;
  }
  const next = updater(existing);
  persistSkillEvolutionProposal(next, candidateDir, { materializeCandidateSnapshot: false });
  return next;
}

export function persistSkillAuditReport(
  report: SkillAuditReport,
  candidateDir = "runtime/skill-evolution",
): string {
  mkdirSync(auditsRoot(candidateDir), { recursive: true });
  const path = auditReportPath(report.proposalId, candidateDir);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

export function readSkillAuditReport(
  proposalId: string,
  candidateDir = "runtime/skill-evolution",
): SkillAuditReport | null {
  try {
    const raw = readFileSync(auditReportPath(proposalId, candidateDir), "utf8");
    return parseAuditReport(raw);
  } catch {
    return null;
  }
}

export function persistSkillDeploymentValidationReport(
  report: SkillDeploymentValidationReport,
  candidateDir = "runtime/skill-evolution",
): string {
  mkdirSync(validationsRoot(candidateDir), { recursive: true });
  const path = validationReportPath(report.proposalId, candidateDir);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

export function readSkillDeploymentValidationReport(
  proposalId: string,
  candidateDir = "runtime/skill-evolution",
): SkillDeploymentValidationReport | null {
  try {
    const raw = readFileSync(validationReportPath(proposalId, candidateDir), "utf8");
    return parseValidationReport(raw);
  } catch {
    return null;
  }
}

export function persistSkillEvolutionDecisionRecord(
  record: SkillEvolutionDecisionRecord,
  candidateDir = "runtime/skill-evolution",
): string {
  mkdirSync(record.decision === "accepted" ? acceptedRoot(candidateDir) : rejectedRoot(candidateDir), { recursive: true });
  const path = decisionRecordPath(record.proposalId, record.decision, candidateDir);
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return path;
}

export function readSkillEvolutionDecisionRecord(
  proposalId: string,
  decision: SkillEvolutionDecisionRecord["decision"],
  candidateDir = "runtime/skill-evolution",
): SkillEvolutionDecisionRecord | null {
  try {
    const raw = readFileSync(decisionRecordPath(proposalId, decision, candidateDir), "utf8");
    return parseDecisionRecord(raw);
  } catch {
    return null;
  }
}

export function applyAcceptedSkillProposal(
  proposal: SkillEvolutionProposal,
  candidateDir = "runtime/skill-evolution",
): {
  appliedFiles: string[];
  rollbackDir: string;
} {
  const rollbackDir = proposalRollbackRoot(proposal.id, candidateDir);
  const candidateRoot = proposalCandidateRoot(proposal.id, candidateDir);
  mkdirSync(rollbackDir, { recursive: true });

  const operations = proposal.targetFiles.map((targetFile) => {
    const livePath = resolveSkillEvolutionLiveTargetPath(targetFile);
    const candidatePath = resolveSkillEvolutionSnapshotTargetPath(candidateRoot, targetFile);
    const rollbackPath = resolveSkillEvolutionSnapshotTargetPath(rollbackDir, targetFile);
    return {
      targetFile,
      livePath,
      candidatePath,
      rollbackPath,
      existed: existsSync(livePath),
    };
  });

  for (const operation of operations) {
    if (!existsSync(operation.candidatePath)) {
      throw new Error(`Candidate file missing for accepted proposal: ${operation.targetFile}`);
    }
  }

  const applied: typeof operations = [];
  try {
    for (const operation of operations) {
      mkdirSync(dirname(operation.rollbackPath), { recursive: true });
      if (operation.existed) {
        writeFileSync(operation.rollbackPath, readFileSync(operation.livePath, "utf8"), "utf8");
      }
      mkdirSync(dirname(operation.livePath), { recursive: true });
      writeFileSync(operation.livePath, readFileSync(operation.candidatePath, "utf8"), "utf8");
      applied.push(operation);
    }
  } catch (error) {
    for (const operation of applied.reverse()) {
      if (operation.existed && existsSync(operation.rollbackPath)) {
        writeFileSync(operation.livePath, readFileSync(operation.rollbackPath, "utf8"), "utf8");
      } else if (!operation.existed && existsSync(operation.livePath)) {
        unlinkSync(operation.livePath);
      }
    }
    throw error;
  }

  return {
    appliedFiles: operations.map((operation) => operation.livePath),
    rollbackDir,
  };
}
