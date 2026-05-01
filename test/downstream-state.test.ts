import test from "node:test";
import assert from "node:assert/strict";
import { scheduledDispatchDownstreamState } from "../src/runtime/downstream-state.js";
import type { LedgerEntry, Workflow } from "../shared/types.js";

test("scheduled dispatch defers when downstream target is running", () => {
  const workflow = createWorkflow();
  const result = scheduledDispatchDownstreamState(workflow, workflow.nodes[0], "interval", [
    entry({ type: "trigger.fired", node: "lead", trigger: "handoff" })
  ]);

  assert.equal(result.busy, true);
  assert.deepEqual(result.downstream, [{ nodeId: "lead", status: "running" }]);
});

test("scheduled dispatch does not defer after downstream target completes", () => {
  const workflow = createWorkflow();
  const result = scheduledDispatchDownstreamState(workflow, workflow.nodes[0], "timer", [
    entry({ type: "trigger.fired", node: "lead", trigger: "handoff" }),
    entry({ type: "session.spawned", node: "lead" })
  ]);

  assert.equal(result.busy, false);
  assert.deepEqual(result.downstream, [{ nodeId: "lead", status: "completed" }]);
});

test("manual dispatch ignores downstream running state", () => {
  const workflow = createWorkflow();
  const result = scheduledDispatchDownstreamState(workflow, workflow.nodes[0], "manual", [
    entry({ type: "trigger.fired", node: "lead", trigger: "handoff" })
  ]);

  assert.equal(result.busy, false);
  assert.deepEqual(result.downstream, []);
});

function createWorkflow(): Workflow {
  return {
    version: 1,
    id: "workflow",
    name: "Workflow",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    settings: { dailyHandoffCap: 10, concurrencyLimit: 2, ledgerRetentionDays: 30 },
    nodes: [
      {
        id: "pm",
        label: "Project Manager",
        agent: "",
        trigger: { type: "interval", every: 30, unit: "minutes" },
        context: "",
        position: { x: 0, y: 0 },
        enabled: true
      },
      {
        id: "lead",
        label: "Lead Dev",
        agent: "",
        trigger: { type: "handoff" },
        context: "",
        position: { x: 300, y: 0 },
        enabled: true
      }
    ],
    edges: [{ id: "pm-lead", from: "pm", to: "lead" }]
  };
}

function entry(partial: Omit<LedgerEntry, "ts">): LedgerEntry {
  return { ts: "2026-05-01T00:00:00.000Z", ...partial } as LedgerEntry;
}
