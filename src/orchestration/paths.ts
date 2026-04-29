import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

export interface OrchestrationPaths {
  workspaceRoot: string;
  orchestrationRoot: string;
  workflowsJson: string;
  inboxRoot: string;
  outboxRoot: string;
  ledgerJsonl: string;
  triggersStateJson: string;
  runtimeRoot: string;
  schemaJson: string;
}

export function workspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

export function paths(root: string): OrchestrationPaths {
  const orch = path.join(root, ".agent-orchestrator");
  const runtime = path.join(orch, "runtime");
  return {
    workspaceRoot: root,
    orchestrationRoot: orch,
    workflowsJson: path.join(orch, "workflows.json"),
    inboxRoot: path.join(orch, "inbox"),
    outboxRoot: path.join(orch, "outbox"),
    ledgerJsonl: path.join(orch, "ledger.jsonl"),
    triggersStateJson: path.join(orch, "triggers", "state.json"),
    runtimeRoot: runtime,
    schemaJson: path.join(runtime, "workflow.schema.json")
  };
}

export async function ensureDirs(p: OrchestrationPaths): Promise<void> {
  const dirs = [
    p.orchestrationRoot,
    p.inboxRoot,
    p.outboxRoot,
    path.dirname(p.triggersStateJson),
    p.runtimeRoot
  ];
  for (const d of dirs) {
    await fs.promises.mkdir(d, { recursive: true });
  }
}

export function inboxDir(p: OrchestrationPaths, persona: string): string {
  return path.join(p.inboxRoot, persona);
}

export function outboxDir(p: OrchestrationPaths, persona: string): string {
  return path.join(p.outboxRoot, persona);
}
