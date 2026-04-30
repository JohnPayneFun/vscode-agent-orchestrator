import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type {
  WebviewToExt,
  ExtToWebview,
  Workflow,
  LedgerEntry,
  AgentOption,
  ModelOption
} from "../../shared/types.js";

export interface PanelDeps {
  loadWorkflow: () => Promise<Workflow>;
  saveWorkflow: (w: Workflow) => Promise<{ ok: boolean; error?: string }>;
  listAgents: () => Promise<AgentOption[]>;
  listModels: () => Promise<ModelOption[]>;
  getAgentInstructions: (agentId: string) => Promise<string | null>;
  runNode: (nodeId: string) => Promise<{ ok: boolean; error?: string }>;
  testTrigger: (nodeId: string) => Promise<{ ok: boolean; error?: string }>;
  tailLedger: () => Promise<LedgerEntry[]>;
  onLedgerEntry: (cb: (e: LedgerEntry) => void) => () => void;
}

export class GraphPanelManager {
  private current: vscode.WebviewPanel | null = null;
  private disposeListeners: Array<() => void> = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: PanelDeps
  ) {}

  open(): void {
    if (this.current) {
      this.current.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentOrchestratorGraph",
      "Agent Orchestrator",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "dist"))]
      }
    );
    this.current = panel;

    panel.webview.html = this.renderHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (msg: WebviewToExt) => {
      try {
        await this.handle(msg, panel);
      } catch (err) {
        this.post(panel, {
          type: "toast",
          level: "error",
          message: err instanceof Error ? err.message : String(err)
        });
      }
    });

    const ledgerSub = this.deps.onLedgerEntry((entry) => {
      this.post(panel, { type: "ledger.append", entry });
    });
    this.disposeListeners.push(ledgerSub);

    panel.onDidDispose(() => {
      for (const d of this.disposeListeners) d();
      this.disposeListeners = [];
      this.current = null;
    });
  }

  private async handle(msg: WebviewToExt, panel: vscode.WebviewPanel): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "workflow.requestLoad": {
        const workflow = await this.deps.loadWorkflow();
        this.post(panel, { type: "workflow.loaded", workflow });
        const agents = await this.deps.listAgents();
        this.post(panel, { type: "agents.list", agents });
        const models = await this.deps.listModels();
        this.post(panel, { type: "models.list", models });
        const tail = await this.deps.tailLedger();
        for (const entry of tail.slice(-50)) {
          this.post(panel, { type: "ledger.append", entry });
        }
        return;
      }
      case "workflow.save": {
        const result = await this.deps.saveWorkflow(msg.workflow);
        this.post(panel, { type: "workflow.saved", ok: result.ok, error: result.error });
        return;
      }
      case "agents.requestList": {
        const agents = await this.deps.listAgents();
        this.post(panel, { type: "agents.list", agents });
        return;
      }
      case "models.requestList": {
        const models = await this.deps.listModels();
        this.post(panel, { type: "models.list", models });
        return;
      }
      case "node.run": {
        if (msg.workflow) {
          const saveResult = await this.deps.saveWorkflow(msg.workflow);
          if (!saveResult.ok) {
            this.post(panel, {
              type: "node.runResult",
              nodeId: msg.nodeId,
              ok: false,
              error: saveResult.error
            });
            return;
          }
          this.post(panel, { type: "workflow.saved", ok: true });
        }
        const r = await this.deps.runNode(msg.nodeId);
        this.post(panel, { type: "node.runResult", nodeId: msg.nodeId, ok: r.ok, error: r.error });
        return;
      }
      case "trigger.test": {
        if (msg.workflow) {
          const saveResult = await this.deps.saveWorkflow(msg.workflow);
          if (!saveResult.ok) {
            this.post(panel, {
              type: "trigger.testResult",
              nodeId: msg.nodeId,
              ok: false,
              error: saveResult.error
            });
            return;
          }
          this.post(panel, { type: "workflow.saved", ok: true });
        }
        const r = await this.deps.testTrigger(msg.nodeId);
        this.post(panel, { type: "trigger.testResult", nodeId: msg.nodeId, ok: r.ok, error: r.error });
        return;
      }
      case "ledger.tail": {
        const entries = await this.deps.tailLedger();
        for (const entry of entries) this.post(panel, { type: "ledger.append", entry });
        return;
      }
      default:
        return;
    }
  }

  private post(panel: vscode.WebviewPanel, msg: ExtToWebview): void {
    void panel.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview): string {
    const distRoot = vscode.Uri.file(path.join(this.context.extensionPath, "dist"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "webview.js"));
    const cssPath = path.join(this.context.extensionPath, "dist", "webview.css");
    const cssTag = fs.existsSync(cssPath)
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "webview.css"))}">`
      : "";
    const nonce = randomNonce();
    const csp = [
      `default-src 'none';`,
      `style-src ${webview.cspSource} 'unsafe-inline';`,
      `script-src 'nonce-${nonce}' ${webview.cspSource};`,
      `img-src ${webview.cspSource} data:;`,
      `font-src ${webview.cspSource};`
    ].join(" ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Agent Orchestrator</title>
${cssTag}
<style>
  html, body, #root { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let n = "";
  for (let i = 0; i < 32; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
  return n;
}
