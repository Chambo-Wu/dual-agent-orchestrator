import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { persistApprovalRequest, resolveApprovalRequest, readJobRecord, type StoredJobRecord } from "../../src/job-store.js";
import type { ApprovalRequest, Job, Plan, TaskRun, Artifact } from "../../src/types.js";

const TEST_JOBS_DIR = resolve(import.meta.dirname!, "../../runtime/jobs");

function makeRecord(jobId: string): StoredJobRecord {
  return {
    savedAt: new Date().toISOString(),
    job: { id: jobId, goal: "test goal", mode: "task", status: "blocked", verified: false, output: "", plan: {} as Plan, taskRuns: [], artifacts: [] } as unknown as Job,
    plan: { id: `plan_${jobId}`, goal: "test goal", mode: "task", taskRunIds: [] } as Plan,
    taskRuns: [] as TaskRun[],
    artifacts: [] as Artifact[],
    control: {},
  };
}

function seedRecord(record: StoredJobRecord): void {
  const dir = resolve(TEST_JOBS_DIR, record.job.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "record.json"), JSON.stringify(record, null, 2), "utf8");
}

describe("approval persistence", () => {
  const jobId = "job_approval_test";

  beforeEach(() => {
    mkdirSync(TEST_JOBS_DIR, { recursive: true });
    seedRecord(makeRecord(jobId));
  });

  afterEach(() => {
    try { rmSync(resolve(TEST_JOBS_DIR, jobId), { recursive: true, force: true }); } catch {}
  });

  it("persistApprovalRequest adds request and sets control", () => {
    const req: ApprovalRequest = {
      id: "appr_001",
      jobId,
      taskIds: ["task_1"],
      reason: "needs review",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const updated = persistApprovalRequest(jobId, req);
    assert.ok(updated);
    assert.equal(updated!.approvalRequests?.length, 1);
    assert.equal(updated!.approvalRequests![0]!.id, "appr_001");
    assert.equal(updated!.control?.pendingApprovalId, "appr_001");
    assert.equal(updated!.control?.approvalStatus, "pending");
  });

  it("resolveApprovalRequest updates status and clears pending", () => {
    const req: ApprovalRequest = {
      id: "appr_002",
      jobId,
      taskIds: ["task_1"],
      reason: "needs review",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    persistApprovalRequest(jobId, req);

    const resolved = resolveApprovalRequest(jobId, "appr_002", "approved", "looks good");
    assert.ok(resolved);
    assert.equal(resolved!.approvalRequests![0]!.status, "approved");
    assert.equal(resolved!.approvalRequests![0]!.responseNote, "looks good");
    assert.ok(resolved!.approvalRequests![0]!.respondedAt);
    assert.equal(resolved!.control?.pendingApprovalId, undefined);
    assert.equal(resolved!.control?.approvalStatus, "approved");
  });

  it("resolveApprovalRequest returns null for missing approval", () => {
    const result = resolveApprovalRequest(jobId, "nonexistent", "denied");
    assert.equal(result, null);
  });

  it("persistApprovalRequest returns null for missing job", () => {
    const req: ApprovalRequest = {
      id: "appr_003",
      jobId: "nonexistent",
      taskIds: [],
      reason: "test",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const result = persistApprovalRequest("nonexistent", req);
    assert.equal(result, null);
  });
});
