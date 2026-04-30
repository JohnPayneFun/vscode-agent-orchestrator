import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkflowNode } from "../src/orchestration/node-resolver.js";
import type { Workflow } from "../shared/types.js";

test("node resolver matches human labels", () => {
  const result = resolveWorkflowNode(workflow(), "Coder");

  assert.equal(result.reason, "matched");
  assert.equal(result.node?.id, "node_1");
});

test("node resolver matches labels case-insensitively", () => {
  const result = resolveWorkflowNode(workflow(), "agent1");

  assert.equal(result.reason, "matched");
  assert.equal(result.node?.id, "node_3");
});

test("node resolver still matches internal ids", () => {
  const result = resolveWorkflowNode(workflow(), "node_2");

  assert.equal(result.reason, "matched");
  assert.equal(result.node?.label, "Reviewer");
});

test("node resolver matches selected custom agent ids", () => {
  const result = resolveWorkflowNode(workflow(), "engineering-rapid-prototyper");

  assert.equal(result.reason, "matched");
  assert.equal(result.node?.label, "Coder");
});

test("node resolver reports ambiguous labels", () => {
  const base = workflow();
  const result = resolveWorkflowNode(
    { ...base, nodes: [...base.nodes, { ...base.nodes[0], id: "node_3" }] },
    "Coder"
  );

  assert.equal(result.reason, "ambiguous");
  assert.equal(result.matches.length, 2);
});

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
        label: "Coder",
        agent: "engineering-rapid-prototyper",
        trigger: { type: "manual" },
        context: "",
        position: { x: 0, y: 0 },
        enabled: true
      },
      {
        id: "node_2",
        label: "Reviewer",
        agent: "engineering-code-reviewer",
        trigger: { type: "manual" },
        context: "",
        position: { x: 200, y: 0 },
        enabled: true
      },
      {
        id: "node_3",
        label: "Agent1",
        agent: "academic-geographer",
        trigger: { type: "manual" },
        context: "",
        position: { x: 400, y: 0 },
        enabled: true
      }
    ],
    edges: []
  };
}
