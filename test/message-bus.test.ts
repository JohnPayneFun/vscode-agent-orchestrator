import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageBus } from "../src/orchestration/message-bus.js";
import { inboxDir, outboxDir, paths } from "../src/orchestration/paths.js";

test("message bus delivers, drains, and removes inbox handoffs", async () => {
  await withTempBus(async ({ bus, root }) => {
    const payload = bus.buildPayload({
      from: "sec",
      to: "pm",
      edgeId: "e_sec_pm",
      trigger: { type: "spawnedSession" },
      payload: { finding: "Review needed" },
      parentId: "parent-1",
      rootId: "root-1",
      depth: 2
    });

    const delivered = await bus.deliver(payload);
    assert.match(delivered.inboxPath, /pm/);
    assert.match(delivered.outboxPath, /sec/);

    const p = paths(root);
    assert.equal((await fs.readdir(inboxDir(p, "pm"))).length, 1);
    assert.equal((await fs.readdir(outboxDir(p, "sec"))).length, 1);

    const drained = await bus.drain("pm");
    assert.equal(drained.length, 1);
    assert.deepEqual(drained[0].payload, { finding: "Review needed" });
    assert.deepEqual(drained[0].trace, {
      rootId: "root-1",
      depth: 2,
      parents: ["parent-1"]
    });
    assert.equal((await fs.readdir(inboxDir(p, "pm"))).length, 0);
  });
});

test("message bus keeps only the latest 50 outbox handoffs per sender", async () => {
  await withTempBus(async ({ bus, root }) => {
    const p = paths(root);

    for (let index = 0; index < 52; index++) {
      await bus.deliver(
        bus.buildPayload({
          from: "sec",
          to: "pm",
          edgeId: "e_sec_pm",
          trigger: { type: "spawnedSession" },
          payload: { index }
        })
      );
    }

    const outboxFiles = await fs.readdir(outboxDir(p, "sec"));
    assert.equal(outboxFiles.length, 50);
  });
});

async function withTempBus(
  run: (ctx: { root: string; bus: MessageBus }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-test-"));
  try {
    await run({ root, bus: new MessageBus(paths(root)) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}