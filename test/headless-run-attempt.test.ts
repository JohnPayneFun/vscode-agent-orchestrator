import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../src/orchestration/ledger.js";
import { MessageBus } from "../src/orchestration/message-bus.js";
import { ensureDirs, paths, type OrchestrationPaths } from "../src/orchestration/paths.js";
import { createStaticModelProvider } from "../src/headless/model-providers.js";
import { runHeadlessNodeAttempt, type HeadlessRuntimeConfig } from "../src/headless/run-attempt.js";
import type { Workflow } from "../shared/types.js";

test("headless run attempt records phases, runs hooks, and routes through node runner", async () => {
  await withRuntime(async ({ root, p, bus, ledger, workflow }) => {
    const beforeMarker = path.join(root, "before.txt");
    const afterMarker = path.join(root, "after.txt");
    const nodeCommand = quoteCommandPath(process.execPath);
    const runtimeConfig: HeadlessRuntimeConfig = {
      hooks: {
        beforeRun: `${nodeCommand} -e "require('fs').writeFileSync('before.txt', process.env.AGENT_ORCHESTRATOR_NODE_ID)"`,
        afterRun: `${nodeCommand} -e "require('fs').writeFileSync('after.txt', process.env.AGENT_ORCHESTRATOR_HOOK)"`
      }
    };

    const attempt = await runHeadlessNodeAttempt({
      deps: deps({ p, bus, ledger, workflow }),
      node: workflow.nodes[0],
      runtimeConfig,
      onMarkdown: () => undefined
    });

    assert.equal(attempt.status, "succeeded");
    assert.equal(attempt.result?.assistantText, "Headless response.");
    assert.equal(await fs.readFile(beforeMarker, "utf8"), "node_1");
    assert.equal(await fs.readFile(afterMarker, "utf8"), "afterRun");
    assert.equal((await bus.peek("node_2")).length, 1);

    const eventTypes = (await ledger.tail()).map((entry) => entry.type);
    assert.deepEqual(eventTypes, [
      "attempt.started",
      "attempt.phase",
      "attempt.hookSucceeded",
      "attempt.phase",
      "trigger.fired",
      "session.spawned",
      "usage.recorded",
      "handoff.emitted",
      "handoff.delivered",
      "attempt.phase",
      "attempt.hookSucceeded",
      "attempt.succeeded"
    ]);
  });
});

test("headless run attempt fails when beforeRun hook fails", async () => {
  await withRuntime(async ({ p, bus, ledger, workflow }) => {
    const attempt = await runHeadlessNodeAttempt({
      deps: deps({ p, bus, ledger, workflow }),
      node: workflow.nodes[0],
      runtimeConfig: { hooks: { beforeRun: `${process.execPath} -e "process.exit(7)"` } }
    });

    assert.equal(attempt.status, "failed");
    assert.match(attempt.error ?? "", /beforeRun hook failed/);
    const eventTypes = (await ledger.tail()).map((entry) => entry.type);
    assert.deepEqual(eventTypes, [
      "attempt.started",
      "attempt.phase",
      "attempt.hookFailed",
      "attempt.phase",
      "attempt.failed"
    ]);
  });
});

function deps(args: { p: OrchestrationPaths; bus: MessageBus; ledger: Ledger; workflow: Workflow }) {
  return {
    paths: args.p,
    bus: args.bus,
    ledger: args.ledger,
    getWorkflow: () => args.workflow,
    getAgentInstructions: async () => null,
    modelProvider: createStaticModelProvider("Headless response.")
  };
}

async function withRuntime(
  run: (ctx: { root: string; p: OrchestrationPaths; bus: MessageBus; ledger: Ledger; workflow: Workflow }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-headless-test-"));
  try {
    const p = paths(root);
    await ensureDirs(p);
    await run({ root, p, bus: new MessageBus(p), ledger: new Ledger(p.ledgerJsonl), workflow: workflow() });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function workflow(): Workflow {
  return {
    version: 1,
    id: "test",
    name: "Test",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    settings: { dailyHandoffCap: 10, concurrencyLimit: 2, ledgerRetentionDays: 30 },
    nodes: [
      {
        id: "node_1",
        label: "agent1",
        agent: "",
        trigger: { type: "manual" },
        context: "Write a response",
        position: { x: 0, y: 0 },
        enabled: true
      },
      {
        id: "node_2",
        label: "agent2",
        agent: "",
        trigger: { type: "handoff" },
        context: "Receive a response",
        position: { x: 200, y: 0 },
        enabled: true
      }
    ],
    edges: [
      {
        id: "edge-node-1-node-2",
        from: "node_1",
        to: "node_2",
        payloadSchema: null,
        via: null
      }
    ]
  };
}

function quoteCommandPath(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}