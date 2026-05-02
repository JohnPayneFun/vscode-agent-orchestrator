import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageBus } from "../src/orchestration/message-bus.js";
import { Ledger } from "../src/orchestration/ledger.js";
import { ensureDirs, paths, type OrchestrationPaths } from "../src/orchestration/paths.js";
import { runWorkflowNode, type RuntimeChatMessage, type RuntimeModelProvider, type RuntimeToolCallStats } from "../src/runtime/node-runner.js";
import type { ModelSelector, Workflow } from "../shared/types.js";

test("node runner executes without VS Code and routes graph-edge handoffs", async () => {
  await withRuntime(async ({ bus, ledger, p, workflow }) => {
    const fake = fakeModelProvider(["Across ", "the USA."]);
    const output: string[] = [];

    const result = await runWorkflowNode({
      deps: deps({ bus, ledger, p, workflow, modelProvider: fake.provider }),
      node: workflow.nodes[0],
      source: "headless-test",
      spawner: "headless-test",
      onMarkdown: (markdown) => {
        output.push(markdown);
      }
    });

    assert.equal(result.assistantText, "Across the USA.");
    assert.equal(result.handoffsEmitted, 1);
    assert.match(
      output.join(""),
      /^Across the USA\.\n\n---\n\*Routing 1 graph edge handoff\(s\)\.\.\.\*\n  -> `node_2` \(id [0-9A-Z]+\)\n$/
    );

    const pending = await bus.peek("node_2");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].from, "node_1");
    assert.equal(pending[0].to, "node_2");
    assert.equal(pending[0].edgeId, "edge-node-1-node-2");
    assert.equal(pending[0].trigger.type, "graphEdge");
    assert.equal(pending[0].trigger.source, "headless-test");
    assert.deepEqual(pending[0].payload, {
      fromNode: "node_1",
      fromLabel: "agent1",
      toNode: "node_2",
      toLabel: "agent2",
      response: "Across the USA."
    });

    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0][0].content, /Selected agent instructions/);
    assert.match(fake.calls[0][0].content, /Use precise geography/);

    const entries = await ledger.tail();
    assert.deepEqual(entries.map((entry) => entry.type), [
      "trigger.fired",
      "session.spawned",
      "usage.recorded",
      "handoff.emitted",
      "handoff.delivered"
    ]);
    assert.equal(entries[0].node, "node_1");
    assert.equal((entries[0].detail as Record<string, unknown>).source, "headless-test");
    assert.equal(entries[1].spawner, "headless-test");
    assert.equal(entries[2].node, "node_1");
    assert.equal(typeof entries[2].totalTokens, "number");
  });
});

test("node runner drains handoffs and writes file artifacts headlessly", async () => {
  await withRuntime(async ({ bus, ledger, p, root, workflow }) => {
    await bus.deliver(
      bus.buildPayload({
        from: "node_1",
        to: "node_2",
        edgeId: "edge-node-1-node-2",
        trigger: { type: "graphEdge" },
        payload: { response: "Two sentences about geography." },
        rootId: "root-1",
        depth: 1
      })
    );
    const targetPath = path.join(root, "agent2-output.md");
    const fake = fakeModelProvider([
      `Documented.\n<<WRITE_FILE path="${targetPath}">>\n# Agent 2 Output\n\nTwo sentences about geography.\n<<END_WRITE_FILE>>`
    ]);

    const result = await runWorkflowNode({
      deps: deps({ bus, ledger, p, workflow, modelProvider: fake.provider }),
      node: workflow.nodes[1],
      userText: "[triggered:handoff:handoffFiles=1]",
      source: "headless-test",
      spawner: "headless-test"
    });

    assert.equal(result.drainedHandoffs, 1);
    assert.equal(result.fileArtifacts.length, 1);
    assert.equal(result.fileArtifacts[0].path, targetPath);
    assert.equal(await fs.readFile(targetPath, "utf8"), "# Agent 2 Output\n\nTwo sentences about geography.\n");

    const pending = await bus.peek("node_2");
    assert.equal(pending.length, 0);

    const entries = await ledger.tail();
    assert.deepEqual(entries.map((entry) => entry.type), [
      "trigger.fired",
      "handoff.consumed",
      "session.spawned",
      "usage.recorded",
      "file.written"
    ]);
    assert.equal(entries[0].trigger, "handoff");
    assert.equal(entries[4].path, targetPath);
  });
});

test("node runner records tool usage when a model reports tool stats", async () => {
  await withRuntime(async ({ bus, ledger, p, workflow }) => {
    const fake = fakeModelProvider(["Done."], {
      rounds: 2,
      calls: 3,
      failures: 1,
      limit: 64,
      tools: {
        run_in_terminal: { calls: 2, failures: 0 },
        get_terminal_output: { calls: 1, failures: 1 }
      }
    });

    await runWorkflowNode({
      deps: deps({ bus, ledger, p, workflow, modelProvider: fake.provider }),
      node: workflow.nodes[1],
      source: "headless-test",
      spawner: "headless-test"
    });

    const entry = (await ledger.tail()).find((candidate) => candidate.type === "toolUsage.recorded");
    assert.ok(entry);
    assert.equal(entry.node, "node_2");
    assert.equal(entry.toolCalls, 3);
    assert.equal(entry.toolRounds, 2);
    assert.equal(entry.failedToolCalls, 1);
    assert.equal(entry.toolRoundLimit, 64);
  });
});

test("node runner records output chunks when requested", async () => {
  await withRuntime(async ({ bus, ledger, p, workflow }) => {
    const fake = fakeModelProvider(["First ", "second."]);

    await runWorkflowNode({
      deps: deps({ bus, ledger, p, workflow, modelProvider: fake.provider }),
      node: workflow.nodes[1],
      source: "headless-test",
      spawner: "headless-test",
      recordOutput: true
    });

    const entries = await ledger.tail();
    const output = entries.find((entry) => entry.type === "session.output");
    assert.ok(output);
    assert.equal(output.node, "node_2");
    assert.equal(output.content, "First second.");
    assert.equal(output.sequence, 0);
  });
});

function deps(args: {
  bus: MessageBus;
  ledger: Ledger;
  p: OrchestrationPaths;
  workflow: Workflow;
  modelProvider: RuntimeModelProvider;
}) {
  return {
    paths: args.p,
    bus: args.bus,
    ledger: args.ledger,
    getWorkflow: () => args.workflow,
    getAgentInstructions: async (agentId: string) => (agentId === "academic-geographer" ? "Use precise geography." : null),
    modelProvider: args.modelProvider
  };
}

function fakeModelProvider(fragments: string[], toolCallStats?: RuntimeToolCallStats): {
  provider: RuntimeModelProvider;
  calls: RuntimeChatMessage[][];
  selectors: Array<ModelSelector | undefined>;
} {
  const calls: RuntimeChatMessage[][] = [];
  const selectors: Array<ModelSelector | undefined> = [];
  return {
    calls,
    selectors,
    provider: {
      async selectModel(selector: ModelSelector | undefined) {
        selectors.push(selector);
        return {
          id: "fake-model",
          name: "Fake Model",
          vendor: "test",
          family: "fake",
          toolCallStats,
          async *sendRequest(messages: RuntimeChatMessage[]) {
            calls.push(messages);
            for (const fragment of fragments) {
              yield fragment;
            }
          }
        };
      }
    }
  };
}

async function withRuntime(
  run: (ctx: { root: string; p: OrchestrationPaths; bus: MessageBus; ledger: Ledger; workflow: Workflow }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-runner-test-"));
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
        agent: "academic-geographer",
        trigger: { type: "manual" },
        context: "Write a two sentence story about USA",
        position: { x: 0, y: 0 },
        enabled: true
      },
      {
        id: "node_2",
        label: "agent2",
        agent: "",
        trigger: { type: "handoff" },
        context: "Document everything you are told and save it to a .md file.",
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