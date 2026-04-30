import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { WORKFLOW_SCHEMA } from "../shared/schema.js";
import type { Workflow } from "../shared/types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(WORKFLOW_SCHEMA);

test("workflow schema accepts object model selectors", () => {
  const workflow = createWorkflow({
    model: { vendor: "copilot", family: "gpt-4o", id: "copilot-gpt-4o" }
  });

  assert.equal(validate(workflow), true, formatErrors());
});

test("workflow schema rejects legacy string model selectors", () => {
  const workflow = createWorkflow({ model: "copilot/gpt-4o" as never });

  assert.equal(validate(workflow), false);
  assert.match(formatErrors(), /model/);
});

test("workflow schema rejects empty model selector objects", () => {
  const workflow = createWorkflow({ model: {} });

  assert.equal(validate(workflow), false);
  assert.match(formatErrors(), /must match/);
});

test("workflow schema accepts fileChange triggers", () => {
  const workflow = createWorkflow({ trigger: { type: "fileChange", glob: "src/**/*.ts" } });

  assert.equal(validate(workflow), true, formatErrors());
});

test("workflow schema accepts startup triggers", () => {
  const workflow = createWorkflow({ trigger: { type: "startup", delaySeconds: 5 } });

  assert.equal(validate(workflow), true, formatErrors());
});

test("workflow schema accepts diagnostics triggers", () => {
  const workflow = createWorkflow({
    trigger: { type: "diagnostics", glob: "src/**/*", severity: "error", debounceMs: 1000 }
  });

  assert.equal(validate(workflow), true, formatErrors());
});

test("workflow schema accepts nodes without custom agents", () => {
  const workflow = createWorkflow({ agent: "" });

  assert.equal(validate(workflow), true, formatErrors());
});

function createWorkflow(nodePatch: Partial<Workflow["nodes"][number]> = {}): Workflow {
  return {
    $schema: "./runtime/workflow.schema.json",
    version: 1,
    id: "test-workflow",
    name: "Test workflow",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    settings: {
      dailyHandoffCap: 200,
      concurrencyLimit: 2,
      ledgerRetentionDays: 30
    },
    nodes: [
      {
        id: "sec",
        label: "Security",
        agent: "engineering-security-engineer",
        trigger: { type: "manual" },
        context: "Review the incoming work.",
        position: { x: 100, y: 100 },
        enabled: true,
        ...nodePatch
      }
    ],
    edges: []
  };
}

function formatErrors(): string {
  return JSON.stringify(validate.errors ?? [], null, 2);
}