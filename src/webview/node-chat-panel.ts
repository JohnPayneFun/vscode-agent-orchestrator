import * as vscode from "vscode";
import type { LedgerEntry, Workflow, WorkflowNode } from "../../shared/types.js";

export interface NodeChatPanelDeps {
  loadWorkflow: () => Promise<Workflow>;
  tailLedger: () => Promise<LedgerEntry[]>;
  onLedgerEntry: (cb: (e: LedgerEntry) => void) => () => void;
}

interface OpenPanelState {
  panel: vscode.WebviewPanel;
  disposeLedger: () => void;
}

export class NodeChatPanelManager {
  private readonly panels = new Map<string, OpenPanelState>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: NodeChatPanelDeps
  ) {}

  async open(nodeId: string, workflow?: Workflow): Promise<void> {
    const existing = this.panels.get(nodeId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const activeWorkflow = workflow ?? (await this.deps.loadWorkflow());
    const node = activeWorkflow.nodes.find((candidate) => candidate.id === nodeId);
    const label = node?.label || nodeId;
    const panel = vscode.window.createWebviewPanel(
      "agentOrchestratorNodeChat",
      `${label} Chat`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.iconPath = new vscode.ThemeIcon("comment-discussion");
    panel.webview.html = this.renderHtml(panel.webview, nodeId, label);

    const postInitialState = async (): Promise<void> => {
      const entries = (await this.deps.tailLedger()).filter((entry) => isNodeChatEntry(entry, nodeId));
      this.post(panel, {
        type: "init",
        node: nodeSummary(nodeId, node),
        entries
      });
    };

    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === "ready") void postInitialState();
    });

    const disposeLedger = this.deps.onLedgerEntry((entry) => {
      if (isNodeChatEntry(entry, nodeId)) this.post(panel, { type: "ledger.append", entry });
    });
    this.panels.set(nodeId, { panel, disposeLedger });

    panel.onDidDispose(() => {
      disposeLedger();
      this.panels.delete(nodeId);
    });
  }

  private post(panel: vscode.WebviewPanel, message: unknown): void {
    void panel.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview, nodeId: string, label: string): string {
    const nonce = randomNonce();
    const csp = [
      `default-src 'none';`,
      `style-src ${webview.cspSource} 'unsafe-inline';`,
      `script-src 'nonce-${nonce}';`,
      `font-src ${webview.cspSource};`
    ].join(" ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(label)} Chat</title>
<style>
  :root { color-scheme: dark light; }
  html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground, var(--vscode-foreground)); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  body { overflow: hidden; }
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100%; }
  .header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); background: var(--vscode-editorWidget-background); }
  .title { font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .node-id { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); font-size: 11px; }
  .status { margin-left: auto; padding: 2px 7px; border-radius: 3px; font-size: 11px; text-transform: capitalize; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .status.running { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
  .status.completed { background: var(--vscode-charts-green, #3fb950); color: #fff; }
  .status.errored { background: var(--vscode-errorForeground, #f85149); color: #fff; }
  .content { overflow: auto; padding: 18px; }
  .chat-card { max-width: 980px; margin: 0 auto; border: 1px solid var(--vscode-editorWidget-border, transparent); background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); border-radius: 6px; }
  .meta { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); color: var(--vscode-descriptionForeground, var(--vscode-foreground)); font-size: 11px; }
  .transcript { margin: 0; min-height: 420px; padding: 16px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; }
  .empty { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); font-style: italic; }
  .runs { max-width: 980px; margin: 12px auto 0; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); font-size: 11px; }
  .runs ul { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .runs li { display: flex; gap: 8px; align-items: center; overflow: hidden; }
  code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
</style>
</head>
<body>
<div class="shell">
  <div class="header">
    <div class="title" id="title">${escapeHtml(label)} Chat</div>
    <div class="node-id"><code>${escapeHtml(nodeId)}</code></div>
    <div class="status" id="status">Waiting</div>
  </div>
  <main class="content">
    <section class="chat-card">
      <div class="meta" id="meta">Loading transcript...</div>
      <pre class="transcript empty" id="transcript">Loading transcript...</pre>
    </section>
    <section class="runs" id="runs"></section>
  </main>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = { node: { id: ${JSON.stringify(nodeId)}, label: ${JSON.stringify(label)} }, entries: [] };
  const title = document.getElementById('title');
  const status = document.getElementById('status');
  const meta = document.getElementById('meta');
  const transcript = document.getElementById('transcript');
  const runs = document.getElementById('runs');

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'init') {
      state.node = message.node || state.node;
      state.entries = Array.isArray(message.entries) ? message.entries : [];
      render();
      return;
    }
    if (message.type === 'ledger.append' && message.entry) {
      state.entries.push(message.entry);
      if (state.entries.length > 2000) state.entries = state.entries.slice(-2000);
      render(true);
    }
  });

  function ensureOutput(eventId, ts, byEvent) {
    let output = byEvent.get(eventId);
    if (!output) {
      output = { eventId, status: 'running', chunks: [], startedAt: ts, updatedAt: ts };
      byEvent.set(eventId, output);
    }
    return output;
  }

  function buildRuns() {
    const byEvent = new Map();
    for (const entry of state.entries) {
      if (!entry || entry.node !== state.node.id || typeof entry.eventId !== 'string') continue;
      if (entry.type === 'trigger.fired') {
        const output = ensureOutput(entry.eventId, entry.ts, byEvent);
        output.status = 'running';
        output.updatedAt = entry.ts;
      } else if (entry.type === 'session.output') {
        const output = ensureOutput(entry.eventId, entry.ts, byEvent);
        if (typeof entry.content === 'string') output.chunks.push(entry.content);
        if (output.status !== 'completed' && output.status !== 'errored' && output.status !== 'cancelled') output.status = 'running';
        output.updatedAt = entry.ts;
      } else if (entry.type === 'session.spawned') {
        const output = ensureOutput(entry.eventId, entry.ts, byEvent);
        output.status = 'completed';
        output.updatedAt = entry.ts;
      } else if (entry.type === 'session.errored') {
        const output = ensureOutput(entry.eventId, entry.ts, byEvent);
        output.status = 'errored';
        output.error = typeof entry.error === 'string' ? entry.error : 'Session errored.';
        output.updatedAt = entry.ts;
      } else if (entry.type === 'session.cancelled') {
        const output = ensureOutput(entry.eventId, entry.ts, byEvent);
        output.status = 'cancelled';
        output.error = 'Run was force-stopped.';
        output.updatedAt = entry.ts;
      }
    }
    return Array.from(byEvent.values()).sort((left, right) => Date.parse(right.updatedAt || right.startedAt || '') - Date.parse(left.updatedAt || left.startedAt || ''));
  }

  function shortTime(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return ts || '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function render(fromAppend = false) {
    const label = state.node.label || state.node.id;
    title.textContent = label + ' Chat';
    const allRuns = buildRuns();
    const latest = allRuns[0];
    if (!latest) {
      status.textContent = 'Waiting';
      status.className = 'status';
      meta.textContent = 'No captured background run yet.';
      transcript.textContent = 'Run this node from the graph, a trigger, or @orchestrator to capture background output here.';
      transcript.className = 'transcript empty';
      runs.textContent = '';
      return;
    }
    const text = latest.chunks.join('') || latest.error || 'No text output captured for this run yet.';
    status.textContent = latest.status;
    status.className = 'status ' + latest.status;
    meta.innerHTML = '<span>Event <code>' + latest.eventId + '</code></span><span>Updated ' + shortTime(latest.updatedAt) + '</span>';
    transcript.textContent = text;
    transcript.className = latest.chunks.length || latest.error ? 'transcript' : 'transcript empty';
    runs.innerHTML = allRuns.length > 1
      ? '<div>Recent runs</div><ul>' + allRuns.slice(0, 8).map((run) => '<li><code>' + run.eventId + '</code><span>' + run.status + '</span><span>' + shortTime(run.updatedAt) + '</span></li>').join('') + '</ul>'
      : '';
    if (fromAppend) transcript.scrollIntoView({ block: 'end' });
  }

  render();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function isNodeChatEntry(entry: LedgerEntry, nodeId: string): boolean {
  return entry.node === nodeId && (
    entry.type === "trigger.fired" ||
    entry.type === "session.output" ||
    entry.type === "session.spawned" ||
    entry.type === "session.errored" ||
    entry.type === "session.cancelled"
  );
}

function nodeSummary(nodeId: string, node: WorkflowNode | undefined): { id: string; label: string } {
  return { id: nodeId, label: node?.label || nodeId };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char] ?? char));
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}