import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirs, paths } from "../src/orchestration/paths.js";
import { listRetryStates, saveRetryState, takeLatestRetryStateForNode } from "../src/runtime/retry-state.js";

test("retry state can take the latest saved state for a node and kind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-retry-state-test-"));
  try {
    const p = paths(root);
    await ensureDirs(p);

    const older = await saveRetryState(p, {
      retryKind: "toolRoundLimit",
      retryAt: "2026-05-01T10:00:00.000Z",
      nodeId: "node_1",
      triggerType: "manual",
      userText: "older",
      drainedHandoffs: [],
      reason: "first cap"
    });
    const usage = await saveRetryState(p, {
      retryKind: "usageLimit",
      retryAt: "2026-05-01T10:30:00.000Z",
      nodeId: "node_1",
      triggerType: "manual",
      userText: "usage",
      drainedHandoffs: [],
      reason: "usage cap"
    });
    const newer = await saveRetryState(p, {
      retryKind: "toolRoundLimit",
      retryAt: "2026-05-01T11:00:00.000Z",
      nodeId: "node_1",
      triggerType: "manual",
      userText: "newer",
      drainedHandoffs: [],
      reason: "second cap"
    });

    const resumed = await takeLatestRetryStateForNode(p, "node_1", "toolRoundLimit");
    assert.equal(resumed?.id, newer.id);
    assert.equal(resumed?.userText, "newer");

    const remaining = await listRetryStates(p);
    assert.deepEqual(
      remaining.map((state) => state.id).sort(),
      [older.id, usage.id].sort()
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
