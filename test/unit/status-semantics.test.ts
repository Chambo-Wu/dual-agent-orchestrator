import test from "node:test";
import assert from "node:assert/strict";
import {
  describeJobState,
  mapJobStatusToLifecycleType,
  mapJobStatusToUiStatus,
  mapTaskRunStatusToUiStatus,
} from "../../src/status-semantics.js";

test("mapTaskRunStatusToUiStatus normalizes task states for UI consumers", () => {
  assert.equal(mapTaskRunStatusToUiStatus("pending"), "running");
  assert.equal(mapTaskRunStatusToUiStatus("in_progress"), "running");
  assert.equal(mapTaskRunStatusToUiStatus("awaiting_approval"), "awaiting_approval");
  assert.equal(mapTaskRunStatusToUiStatus("completed"), "completed");
  assert.equal(mapTaskRunStatusToUiStatus("failed"), "failed");
  assert.equal(mapTaskRunStatusToUiStatus("blocked"), "blocked");
  assert.equal(mapTaskRunStatusToUiStatus("skipped"), "running");
});

test("mapJobStatusToUiStatus and lifecycle types share one job interpretation", () => {
  assert.equal(mapJobStatusToUiStatus("queued"), "running");
  assert.equal(mapJobStatusToUiStatus("running"), "running");
  assert.equal(mapJobStatusToUiStatus("awaiting_approval"), "awaiting_approval");
  assert.equal(mapJobStatusToUiStatus("completed"), "completed");
  assert.equal(mapJobStatusToUiStatus("failed"), "failed");
  assert.equal(mapJobStatusToUiStatus("blocked"), "blocked");
  assert.equal(mapJobStatusToUiStatus("cancelled"), "blocked");

  assert.equal(mapJobStatusToLifecycleType("queued"), "job.queued");
  assert.equal(mapJobStatusToLifecycleType("running"), "job.started");
  assert.equal(mapJobStatusToLifecycleType("awaiting_approval"), "job.awaiting_approval");
  assert.equal(mapJobStatusToLifecycleType("completed"), "job.completed");
  assert.equal(mapJobStatusToLifecycleType("failed"), "job.failed");
  assert.equal(mapJobStatusToLifecycleType("blocked"), "job.blocked");
  assert.equal(mapJobStatusToLifecycleType("cancelled"), "job.cancelled");
});

test("describeJobState produces consistent control-plane summaries", () => {
  assert.equal(describeJobState("running"), "Job is currently running.");
  assert.equal(describeJobState("queued"), "Job is queued.");
  assert.equal(describeJobState("awaiting_approval"), "Job is waiting for approval.");
  assert.equal(describeJobState("cancelled"), "Job was cancelled.");
  assert.equal(describeJobState("blocked"), "Job finished with status blocked.");
  assert.equal(describeJobState("completed"), "Job finished with status completed.");
  assert.equal(describeJobState("failed"), "Job finished with status failed.");
});
