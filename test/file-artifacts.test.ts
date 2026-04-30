import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseWriteFileBlocks, writeNodeFileArtifacts } from "../src/runtime/file-artifacts.js";
import type { HandoffPayload, WorkflowNode } from "../shared/types.js";

test("file artifact parser reads write blocks", () => {
  const blocks = parseWriteFileBlocks(`ok
<<WRITE_FILE path="docs/result.md">>
# Result
<<END_WRITE_FILE>>`);

  assert.deepEqual(blocks, [{ path: "docs/result.md", content: "# Result\n" }]);
});

test("markdown fallback writes handoff logs to requested directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-artifacts-test-"));
  const outputDir = path.join(root, "Documents");
  try {
    const [artifact] = await writeNodeFileArtifacts({
      node: node(`Document everything you are told and save it to a .md file. Save it to ${outputDir}`),
      workspaceRoot: root,
      assistantText: "No direct filesystem tool is available.",
      drained: [handoff()]
    });

    assert.equal(artifact.source, "markdownFallback");
    assert.equal(artifact.path, path.join(outputDir, "agent2-handoff-log.md"));
    const content = await fs.readFile(artifact.path, "utf8");
    assert.match(content, /# agent2 Handoff Log/);
    assert.match(content, /Two sentences about geography\./);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function node(context: string): WorkflowNode {
  return {
    id: "node_2",
    label: "agent2",
    agent: "",
    trigger: { type: "handoff" },
    context,
    position: { x: 0, y: 0 },
    enabled: true
  };
}

function handoff(): HandoffPayload {
  return {
    schemaVersion: 1,
    id: "handoff-1",
    createdAt: "2026-04-30T00:00:00.000Z",
    from: "node_1",
    to: "node_2",
    edgeId: "edge-1",
    trigger: { type: "graphEdge" },
    payload: { response: "Two sentences about geography." },
    trace: { rootId: "root-1", depth: 1, parents: [] }
  };
}