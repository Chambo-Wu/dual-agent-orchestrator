import { type IncomingMessage, type ServerResponse } from "node:http";
import { loadEventsFromDisk, appendEvent, getNextSeq } from "../job-event-bus.js";
import { listStoredJobs, readJobRecord, type StoredJobRecord } from "../job-store.js";
import type { WorkflowUiEvent } from "../workflow-ui-events.js";
import { createUiEvent } from "../workflow-ui-events.js";
import type { OrchestratorConfig } from "../types.js";
import type {
  SkillEvolutionDecisionRecord,
  SkillReflectionRecord,
} from "../skill-evolution-types.js";
import { getSkillManifest, listAvailableSkills, listInstalledSkills } from "../skill-registry.js";
import { getInstalledSkillRecord, installSkillById } from "../skill-installer.js";
import { auditSkillEvolutionProposal } from "../skill-auditor.js";
import { validateSkillEvolutionProposalWithRuntimeReplay } from "../skill-deployment-validator.js";
import {
  applyAcceptedSkillProposal,
  getSkillEvolutionProposalCandidateRoot,
  getSkillEvolutionProposalRollbackRoot,
  listSkillEvolutionProposals,
  persistSkillEvolutionDecisionRecord,
  listSkillReflectionRecords,
  persistSkillAuditReport,
  persistSkillDeploymentValidationReport,
  persistSkillEvolutionProposal,
  persistSkillReflectionRecord,
  readSkillAuditReport,
  readSkillDeploymentValidationReport,
  readSkillEvolutionDecisionRecord,
  readSkillEvolutionProposal,
  readSkillReflectionRecord,
  updateSkillEvolutionProposal,
} from "../skill-evolution-store.js";
import { buildSkillEvolutionProposal, buildSkillReflectionFromRecord } from "../skill-evolution-builders.js";
import { buildSkillEvolutionOpsSummary, buildSkillEvolutionProposalControlPlaneRecord } from "../skill-evolution-control-plane.js";
import { renderSkillEvolutionOpsDashboardHtml } from "../skill-evolution-ops-dashboard.js";
import { createLifecycleEvent } from "../job-response.js";
import { getRuntimeConfig, jsonResponse, jsonErrorResponse, readJsonBody } from "./shared.js";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function buildSkillListResponse(config = getRuntimeConfig()): Record<string, unknown> {
  const available = listAvailableSkills(config);
  return {
    object: "list",
    data: available.map((skill) => {
      const installedRecord = getInstalledSkillRecord(config, skill.id);
      const runtimeInstalled = listInstalledSkills(config).find((entry) => entry.id === skill.id);
      return {
        skill_id: skill.id,
        version: skill.version,
        title: skill.title,
        description: skill.description,
        intents: skill.intents,
        source: skill.install.source,
        install_status: installedRecord
          ? "installed"
          : runtimeInstalled
            ? "builtin_available"
            : "available",
        auto_install_eligible: config.skills.enabled
          && config.skills.autoInstall
          && config.skills.allowSources.includes(skill.install.source),
        explicit_install: Boolean(installedRecord),
        location: runtimeInstalled?.location ?? skill.install.location,
      };
    }),
  };
}

export async function handleListSkills(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  jsonResponse(res, 200, buildSkillListResponse(config));
}

export async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ skill_id?: string }>(req);
  const skillId = typeof body.skill_id === "string" ? body.skill_id.trim() : "";
  if (!skillId) {
    throw new Error("`skill_id` must be a non-empty string.");
  }
  const config = getRuntimeConfig();
  const result = installSkillById(config, skillId);
  const statusCode = result.status === "installed" || result.status === "already_installed"
    ? 200
    : result.status === "blocked" || result.status === "unavailable"
      ? 409
      : 400;
  jsonResponse(res, statusCode, {
    skill_id: result.skillId,
    status: result.status,
    reason: result.reason,
    source: result.source ?? null,
    location: result.location ?? result.record?.location ?? null,
    record: result.record ?? null,
  });
}

function buildSkillReflectionsResponse(skillId: string, candidateDir: string, limit?: number): Record<string, unknown> {
  const records = listSkillReflectionRecords(skillId, candidateDir);
  const data = Number.isFinite(limit) && (limit as number) >= 0
    ? records.slice(0, limit as number)
    : records;
  return {
    object: "list",
    skill_id: skillId,
    count: data.length,
    data,
  };
}

export async function handleListSkillReflections(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  const config = getRuntimeConfig();
  if (!getSkillManifest(skillId, config)) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill not found: ${skillId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  jsonResponse(res, 200, buildSkillReflectionsResponse(skillId, config.skillEvolution.candidateDir, limit));
}

function findLatestSkillJobRecord(skillId: string): StoredJobRecord | null {
  for (const stored of listStoredJobs()) {
    const record = readJobRecord(stored.id);
    if (!record) {
      continue;
    }
    const selectedSkillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
    if (selectedSkillId === skillId) {
      return record;
    }
  }
  return null;
}

function findLatestSkillReflectionRecord(skillId: string, candidateDir: string): SkillReflectionRecord | null {
  return listSkillReflectionRecords(skillId, candidateDir)[0] ?? null;
}

function findReflectionForProposalCreate(
  config: OrchestratorConfig,
  input: { skillId?: string; reflectionId?: string },
): SkillReflectionRecord | null {
  const requestedSkillId = input.skillId?.trim() ?? "";
  const requestedReflectionId = input.reflectionId?.trim() ?? "";
  if (requestedSkillId && requestedReflectionId) {
    return readSkillReflectionRecord(requestedSkillId, requestedReflectionId, config.skillEvolution.candidateDir);
  }
  if (requestedReflectionId) {
    for (const skill of listAvailableSkills(config)) {
      const reflection = readSkillReflectionRecord(skill.id, requestedReflectionId, config.skillEvolution.candidateDir);
      if (reflection) {
        return reflection;
      }
    }
    return null;
  }
  if (requestedSkillId) {
    return findLatestSkillReflectionRecord(requestedSkillId, config.skillEvolution.candidateDir);
  }
  return null;
}

export async function handleCreateSkillReflection(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  const config = getRuntimeConfig();
  if (!getSkillManifest(skillId, config)) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill not found: ${skillId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const body = await readJsonBody<{ job_id?: string }>(req);
  const requestedJobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  const record = requestedJobId
    ? readJobRecord(requestedJobId)
    : findLatestSkillJobRecord(skillId);

  if (!record) {
    jsonResponse(res, 404, {
      error: {
        message: requestedJobId
          ? `Job not found: ${requestedJobId}`
          : `No job history found for skill ${skillId}.`,
        type: "not_found_error",
      },
    });
    return;
  }

  const selectedSkillId = record.job.selectedSkill?.skill_id ?? record.plan.selectedSkill?.skill_id;
  if (selectedSkillId !== skillId) {
    jsonResponse(res, 409, {
      error: {
        message: `Job ${record.job.id} is associated with skill ${selectedSkillId ?? "unknown"}, not ${skillId}.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const reflection = buildSkillReflectionFromRecord(record);
  if (!reflection) {
    jsonResponse(res, 409, {
      error: {
        message: `Unable to build a reflection for skill ${skillId} from job ${record.job.id}.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const path = persistSkillReflectionRecord(reflection, config.skillEvolution.candidateDir);
  jsonResponse(res, 201, {
    skill_id: skillId,
    job_id: record.job.id,
    reflection,
    path,
  });
}

export async function handleCreateSkillProposal(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  const config = getRuntimeConfig();
  if (!getSkillManifest(skillId, config)) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill not found: ${skillId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const body = await readJsonBody<{ reflection_id?: string }>(req);
  const requestedReflectionId = typeof body.reflection_id === "string" ? body.reflection_id.trim() : "";
  const reflection = requestedReflectionId
    ? readSkillReflectionRecord(skillId, requestedReflectionId, config.skillEvolution.candidateDir)
    : findLatestSkillReflectionRecord(skillId, config.skillEvolution.candidateDir);

  if (!reflection) {
    jsonResponse(res, 404, {
      error: {
        message: requestedReflectionId
          ? `Reflection not found: ${requestedReflectionId}`
          : `No reflection history found for skill ${skillId}.`,
        type: "not_found_error",
      },
    });
    return;
  }

  const proposal = buildSkillEvolutionProposal(reflection, config.skillEvolution.candidateDir, config);
  const path = persistSkillEvolutionProposal(proposal, config.skillEvolution.candidateDir);
  const candidatePath = getSkillEvolutionProposalCandidateRoot(proposal.id, config.skillEvolution.candidateDir);
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: proposal.createdAt,
    type: "system.skill_evolution_proposed",
    title: "Skill evolution proposed",
    summary: proposal.patchSummary,
    status: "running",
    meta: {
      skill_id: proposal.skillId,
      reflection_id: proposal.sourceReflectionId,
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      patch_summary: proposal.patchSummary,
      change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
      rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
      changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
    },
  }));
  jsonResponse(res, 201, {
    skill_id: skillId,
    reflection_id: reflection.id,
    proposal,
    path,
    candidate_path: candidatePath,
  });
}

export async function handleListSkillEvolutionProposals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const ops = buildSkillEvolutionOpsSummary(config);
  const proposals = listSkillEvolutionProposals(config.skillEvolution.candidateDir);
  jsonResponse(res, 200, {
    object: "list",
    summary: isObjectRecord(ops.summary) ? ops.summary : {},
    filters: isObjectRecord(ops.filters) ? ops.filters : {},
    data: proposals
      .map((proposal) => buildSkillEvolutionProposalControlPlaneRecord(proposal, config, proposals)),
  });
}

export async function handleSkillEvolutionOps(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  jsonResponse(res, 200, buildSkillEvolutionOpsSummary(config));
}

export async function handleSkillEvolutionOpsDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const html = renderSkillEvolutionOpsDashboardHtml(buildSkillEvolutionOpsSummary(config), {
    dataUrl: "/skill-evolution/ops/data",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

export async function handleBrowserSkillEvolutionOpsData(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  jsonResponse(res, 200, buildSkillEvolutionOpsSummary(config));
}

export async function handleGetSkillEvolutionProposal(_req: IncomingMessage, res: ServerResponse, proposalId: string): Promise<void> {
  const config = getRuntimeConfig();
  const proposal = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!proposal) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }
  jsonResponse(res, 200, buildSkillEvolutionProposalControlPlaneRecord(proposal, config));
}

export async function handleCreateSkillEvolutionProposal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getRuntimeConfig();
  const body = await readJsonBody<{ skill_id?: string; reflection_id?: string }>(req);
  const reflection = findReflectionForProposalCreate(config, {
    skillId: typeof body.skill_id === "string" ? body.skill_id : undefined,
    reflectionId: typeof body.reflection_id === "string" ? body.reflection_id : undefined,
  });
  if (!reflection) {
    jsonResponse(res, 404, {
      error: {
        message: "No matching reflection found for proposal creation.",
        type: "not_found_error",
      },
    });
    return;
  }

  const proposal = buildSkillEvolutionProposal(reflection, config.skillEvolution.candidateDir, config);
  const path = persistSkillEvolutionProposal(proposal, config.skillEvolution.candidateDir);
  const candidatePath = getSkillEvolutionProposalCandidateRoot(proposal.id, config.skillEvolution.candidateDir);
  appendEvent(createLifecycleEvent({
    jobId: reflection.jobId,
    seq: getNextSeq(reflection.jobId),
    time: proposal.createdAt,
    type: "system.skill_evolution_proposed",
    title: "Skill evolution proposed",
    summary: proposal.patchSummary,
    status: "running",
    meta: {
      skill_id: proposal.skillId,
      reflection_id: proposal.sourceReflectionId,
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      patch_summary: proposal.patchSummary,
      change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
      rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
      changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
    },
  }));
  jsonResponse(res, 201, {
    skill_id: reflection.skillId,
    reflection_id: reflection.id,
    proposal,
    path,
    candidate_path: candidatePath,
  });
}

export async function handleAuditSkillEvolutionProposal(_req: IncomingMessage, res: ServerResponse, proposalId: string): Promise<void> {
  const config = getRuntimeConfig();
  const existing = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!existing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  if (existing.status !== "draft") {
    jsonResponse(res, 409, {
      error: {
        message: `Skill evolution proposal ${proposalId} cannot be audited from status ${existing.status}.`,
        type: "conflict_error",
      },
    });
    return;
  }

  const auditing = updateSkillEvolutionProposal(proposalId, (proposal) => ({
    ...proposal,
    status: "auditing",
  }), config.skillEvolution.candidateDir);

  if (!auditing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const reflection = readSkillReflectionRecord(auditing.skillId, auditing.sourceReflectionId, config.skillEvolution.candidateDir);
  const manifest = getSkillManifest(auditing.skillId, config);
  const audit = auditSkillEvolutionProposal({
    proposal: auditing,
    reflection,
    manifest,
  });
  const path = persistSkillAuditReport(audit, config.skillEvolution.candidateDir);
  const proposal = updateSkillEvolutionProposal(proposalId, (current) => ({
    ...current,
    status: audit.passed ? "validated" : "audit_failed",
    auditReportPath: path,
  }), config.skillEvolution.candidateDir);
  if (reflection && proposal) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: audit.passed ? "system.skill_evolution_audit_passed" : "system.skill_evolution_audit_failed",
      title: audit.passed ? "Skill evolution audit passed" : "Skill evolution audit failed",
      summary: audit.summary,
      status: audit.passed ? "success" : "blocked",
      meta: {
        skill_id: proposal.skillId,
        reflection_id: proposal.sourceReflectionId,
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        audit_report_path: path,
      },
    }));
  }

  jsonResponse(res, 200, {
    proposal,
    audit,
    path,
  });
}

export async function handleValidateSkillEvolutionProposal(_req: IncomingMessage, res: ServerResponse, proposalId: string): Promise<void> {
  const config = getRuntimeConfig();
  const existing = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!existing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  if (existing.status !== "validated") {
    jsonResponse(res, 409, {
      error: {
        message: `Skill evolution proposal ${proposalId} cannot be validated from status ${existing.status}.`,
        type: "conflict_error",
      },
    });
    return;
  }

  const reflection = readSkillReflectionRecord(existing.skillId, existing.sourceReflectionId, config.skillEvolution.candidateDir);
  const baselineRecord = reflection?.jobId ? readJobRecord(reflection.jobId) : null;
  const validation = await validateSkillEvolutionProposalWithRuntimeReplay({
    proposal: existing,
    reflection,
    baselineRecord,
    config,
  });
  const path = persistSkillDeploymentValidationReport(validation, config.skillEvolution.candidateDir);
  const proposal = updateSkillEvolutionProposal(proposalId, (current) => ({
    ...current,
    status: validation.passed ? "validated" : "validation_failed",
    validationReportPath: path,
  }), config.skillEvolution.candidateDir);
  if (reflection && proposal) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: new Date().toISOString(),
      type: validation.passed ? "system.skill_evolution_validation_passed" : "system.skill_evolution_validation_failed",
      title: validation.passed ? "Skill evolution validation passed" : "Skill evolution validation failed",
      summary: validation.summary,
      status: validation.passed ? "success" : "blocked",
      meta: {
        skill_id: proposal.skillId,
        reflection_id: proposal.sourceReflectionId,
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        validation_report_path: path,
      },
    }));
  }

  jsonResponse(res, 200, {
    proposal,
    validation,
    path,
  });
}

export async function handleSkillEvolutionDecision(
  req: IncomingMessage,
  res: ServerResponse,
  proposalId: string,
  decision: SkillEvolutionDecisionRecord["decision"],
): Promise<void> {
  const config = getRuntimeConfig();
  const existing = readSkillEvolutionProposal(proposalId, config.skillEvolution.candidateDir);
  if (!existing) {
    jsonResponse(res, 404, {
      error: {
        message: `Skill evolution proposal not found: ${proposalId}`,
        type: "not_found_error",
      },
    });
    return;
  }

  const allowedStatuses = decision === "accepted" ? new Set(["validated"]) : new Set(["validated", "validation_failed", "audit_failed", "draft"]);
  if (!allowedStatuses.has(existing.status)) {
    jsonResponse(res, 409, {
      error: {
        message: `Skill evolution proposal ${proposalId} cannot be ${decision} from status ${existing.status}.`,
        type: "conflict_error",
      },
    });
    return;
  }

  const body = await readJsonBody<{ reason?: string }>(req);
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : undefined;
  let acceptResult: { appliedFiles: string[]; rollbackDir: string } | null = null;
  if (decision === "accepted") {
    try {
      acceptResult = applyAcceptedSkillProposal(existing, config.skillEvolution.candidateDir);
    } catch (error) {
      jsonResponse(res, 409, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "conflict_error",
        },
      });
      return;
    }
  }
  const record: SkillEvolutionDecisionRecord = {
    proposalId: existing.id,
    skillId: existing.skillId,
    decision,
    reason,
    createdAt: new Date().toISOString(),
  };
  const path = persistSkillEvolutionDecisionRecord(record, config.skillEvolution.candidateDir);
  const proposal = updateSkillEvolutionProposal(proposalId, (current) => ({
    ...current,
    status: decision,
    decidedAt: record.createdAt,
  }), config.skillEvolution.candidateDir);
  const reflection = readSkillReflectionRecord(existing.skillId, existing.sourceReflectionId, config.skillEvolution.candidateDir);
  if (reflection && proposal) {
    appendEvent(createLifecycleEvent({
      jobId: reflection.jobId,
      seq: getNextSeq(reflection.jobId),
      time: record.createdAt,
      type: decision === "accepted" ? "system.skill_evolution_accepted" : "system.skill_evolution_rejected",
      title: decision === "accepted" ? "Skill evolution accepted" : "Skill evolution rejected",
      summary: proposal.controlPlaneSummary?.changeHeadline
        ? `${proposal.controlPlaneSummary.changeHeadline}${reason ? `. ${reason}` : ""}`
        : reason ? `${proposal.patchSummary}. ${reason}` : proposal.patchSummary,
      status: decision === "accepted" ? "success" : "blocked",
      meta: {
        skill_id: proposal.skillId,
        reflection_id: proposal.sourceReflectionId,
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        patch_summary: proposal.patchSummary,
        change_summary: proposal.controlPlaneSummary?.changeHeadline ?? null,
        rationale_summary: proposal.controlPlaneSummary?.rationaleHeadline ?? null,
        changed_files: proposal.controlPlaneSummary?.changedFiles ?? proposal.targetFiles,
        decision_reason: reason ?? null,
      },
    }));
  }

  jsonResponse(res, 200, {
    proposal,
    decision: record,
    path,
    applied_files: acceptResult?.appliedFiles ?? [],
    rollback_path: decision === "accepted" ? getSkillEvolutionProposalRollbackRoot(existing.id, config.skillEvolution.candidateDir) : null,
  });
}
