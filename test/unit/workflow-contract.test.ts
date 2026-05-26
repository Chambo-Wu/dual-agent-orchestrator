import test from "node:test";
import assert from "node:assert/strict";
import { buildSingleTaskContract, collectArtifactsFromExecutorHistory, mapJobStatusToTaskRunStatus } from "../../src/workflow-contract.js";

test("mapJobStatusToTaskRunStatus preserves active and approval semantics", () => {
  assert.equal(mapJobStatusToTaskRunStatus("queued"), "pending");
  assert.equal(mapJobStatusToTaskRunStatus("running"), "in_progress");
  assert.equal(mapJobStatusToTaskRunStatus("awaiting_approval"), "awaiting_approval");
  assert.equal(mapJobStatusToTaskRunStatus("completed"), "completed");
  assert.equal(mapJobStatusToTaskRunStatus("failed"), "failed");
  assert.equal(mapJobStatusToTaskRunStatus("blocked"), "blocked");
  assert.equal(mapJobStatusToTaskRunStatus("cancelled"), "blocked");
});

test("buildSingleTaskContract keeps task state aligned with job state", () => {
  const running = buildSingleTaskContract({
    goal: "Running task",
    status: "running",
    verified: false,
    output: "still working",
    executorHistory: [],
  });
  assert.equal(running.job.status, "running");
  assert.equal(running.taskRuns[0]?.status, "in_progress");

  const approval = buildSingleTaskContract({
    goal: "Approval task",
    status: "awaiting_approval",
    verified: false,
    output: "Waiting for approval.",
    executorHistory: [],
  });
  assert.equal(approval.job.status, "awaiting_approval");
  assert.equal(approval.taskRuns[0]?.status, "awaiting_approval");

  const cancelled = buildSingleTaskContract({
    goal: "Cancelled task",
    status: "cancelled",
    verified: false,
    output: "Cancelled.",
    executorHistory: [],
  });
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.taskRuns[0]?.status, "blocked");
});

test("collectArtifactsFromExecutorHistory enriches artifact metadata", () => {
  const artifacts = collectArtifactsFromExecutorHistory([
    {
      status: "success",
      summary: "Fetched source",
      tool_calls_made: [],
      artifacts: [
        { type: "file", path: "runtime/source.txt", content_preview: "source" },
        { type: "text", content_preview: "inline note" },
      ],
      raw_result: "source",
      source: "native_tool",
    },
    {
      status: "success",
      summary: "Parsed data",
      tool_calls_made: [],
      artifacts: [
        { type: "json", path: "runtime/data.json", content_preview: "{}" },
      ],
      raw_result: "{}",
      source: "native_tool",
    },
  ], "task_1", 3);

  assert.equal(artifacts[0]?.sourceTaskRunId, "task_1");
  assert.equal(artifacts[0]?.relatedTaskRunId, "task_1");
  assert.equal(artifacts[0]?.relatedStep, 4);
  assert.equal(artifacts[0]?.trustLevel, "high");
  assert.equal(artifacts[1]?.trustLevel, "medium");
  assert.equal(artifacts[2]?.relatedStep, 5);
});
