import * as vscode from "vscode";
import { paths, ensureDirs, workspaceRoot, type OrchestrationPaths } from "./orchestration/paths.js";
import { Ledger } from "./orchestration/ledger.js";
import { WorkflowStore } from "./orchestration/workflow-store.js";
import { MessageBus } from "./orchestration/message-bus.js";
import { listAgents } from "./orchestration/agents.js";
import { Dispatcher } from "./runtime/dispatcher.js";
import { TriggerRegistry } from "./runtime/trigger-registry.js";
import { registerChatParticipant } from "./runtime/chat-participant.js";
import { GraphPanelManager } from "./webview/panel.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Agent Orchestrator");
  context.subscriptions.push(output);
  output.appendLine("Agent Orchestrator activating...");

  const root = workspaceRoot();
  const p: OrchestrationPaths | null = root ? paths(root) : null;
  if (p) await ensureDirs(p);

  const ledger = p ? new Ledger(p.ledgerJsonl) : null;
  const store = p ? new WorkflowStore(p) : null;
  const bus = p ? new MessageBus(p) : null;
  const dispatcher = ledger && store ? new Dispatcher(ledger, () => store.get()) : null;
  const triggers =
    dispatcher && p && bus ? new TriggerRegistry(dispatcher, p, bus, output) : null;

  if (store) {
    await store.load();
    await store.writeSchemaCopy().catch(() => undefined);
    triggers?.reconcile(store.get());
    store.onChange((w) => triggers?.reconcile(w));
  }

  if (store && bus && ledger && p) {
    registerChatParticipant(context, {
      paths: p,
      bus,
      ledger,
      getWorkflow: () => store.get()
    });
    output.appendLine("Chat participant @orchestrator registered.");
  } else {
    output.appendLine(
      "Workspace not available — chat participant registration deferred. Open a folder to enable orchestration."
    );
  }

  const panel = new GraphPanelManager(context, {
    loadWorkflow: async () => {
      if (!store) throw new Error("No workspace folder open.");
      return store.load();
    },
    saveWorkflow: async (w) => {
      if (!store) return { ok: false, error: "No workspace folder open." };
      try {
        await store.save(w);
        await ledger?.append({ type: "workflow.saved", detail: { id: w.id, nodes: w.nodes.length } });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    listAgents: async () => {
      const agents = await listAgents(root);
      return agents.map((a) => ({ id: a.id, label: a.label, path: a.path }));
    },
    runNode: async (nodeId: string) => {
      if (!store || !dispatcher) return { ok: false, error: "Not initialized." };
      const wf = store.get();
      const node = wf?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, error: `No node with id ${nodeId}` };
      try {
        await dispatcher.fireNode(node, { reason: "manual" });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    tailLedger: async () => (ledger ? ledger.tail(200) : []),
    onLedgerEntry: (cb) => (ledger ? ledger.onAppend(cb) : () => undefined)
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeAgentOrchestrator.openGraph", () => {
      panel.open();
    }),
    vscode.commands.registerCommand("vscodeAgentOrchestrator.runNode", async () => {
      if (!store || !dispatcher) {
        vscode.window.showErrorMessage("Agent Orchestrator: open a workspace first.");
        return;
      }
      const wf = store.get();
      if (!wf || wf.nodes.length === 0) {
        vscode.window.showInformationMessage("No nodes defined yet. Open the graph editor and create one.");
        return;
      }
      const choice = await vscode.window.showQuickPick(
        wf.nodes.map((n) => ({ label: n.label, description: n.id, node: n })),
        { placeHolder: "Pick a node to fire" }
      );
      if (!choice) return;
      try {
        await dispatcher.fireNode(choice.node, { reason: "manual" });
      } catch (err) {
        vscode.window.showErrorMessage(`Run failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
    vscode.commands.registerCommand("vscodeAgentOrchestrator.tailLedger", async () => {
      if (!p) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p.ledgerJsonl));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("vscodeAgentOrchestrator.emergencyStop", async () => {
      triggers?.disposeAll();
      await vscode.workspace
        .getConfiguration("vscodeAgentOrchestrator")
        .update("enabled", false, vscode.ConfigurationTarget.Workspace);
      vscode.window.showWarningMessage(
        "Agent Orchestrator: all triggers stopped and disabled. Re-enable in settings."
      );
    })
  );

  context.subscriptions.push({ dispose: () => triggers?.disposeAll() });
  output.appendLine("Agent Orchestrator activated.");
}

export function deactivate(): void {
  /* subscriptions handle cleanup */
}
