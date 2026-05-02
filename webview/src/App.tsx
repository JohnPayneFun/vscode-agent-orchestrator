import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  Workflow,
  WorkflowNode,
  LedgerEntry,
  ExtToWebview,
  AgentOption,
  ModelOption,
  SourceControlInfo
} from "../../shared/types.js";
import { send, onMessage } from "./api.js";
import { GraphView } from "./GraphView.js";
import { JsonView } from "./JsonView.js";
import { NodeForm } from "./NodeForm.js";
import { LedgerPanel } from "./LedgerPanel.js";

type View = "graph" | "json";

export interface NodeActivity {
  status: "idle" | "queued" | "running" | "completed" | "errored" | "blocked";
  label: string;
  detail: string;
  ts?: string;
  eventId?: string;
}

export interface EdgeActivity {
  label: string;
  ts: string;
}

interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runs: number;
  estimatedRuns: number;
}

interface WorkflowTokenUsage {
  total: TokenUsageSummary;
  byNode: Record<string, TokenUsageSummary>;
}

interface ToolUsageSummary {
  toolCalls: number;
  toolRounds: number;
  failedToolCalls: number;
  runs: number;
  limitHits: number;
  byTool: Record<string, { calls: number; failures: number }>;
}

interface WorkflowToolUsage {
  total: ToolUsageSummary;
  byNode: Record<string, ToolUsageSummary>;
}

interface NodeRunOutput {
  eventId: string;
  status: "running" | "completed" | "errored";
  chunks: string[];
  startedAt?: string;
  updatedAt?: string;
  error?: string;
}

const EMPTY_WORKFLOW: Workflow = {
  $schema: "./runtime/workflow.schema.json",
  version: 1,
  id: "default",
  name: "New workflow",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  settings: { dailyHandoffCap: 200, concurrencyLimit: 2, ledgerRetentionDays: 30 },
  nodes: [],
  edges: []
};

const EDGE_ACTIVITY_TTL_MS = 12_000;
const EDGE_ACTIVITY_TICK_MS = 1_000;

export function App(): JSX.Element {
  const [workflow, setWorkflow] = useState<Workflow>(EMPTY_WORKFLOW);
  const [view, setView] = useState<View>("graph");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [sourceControl, setSourceControl] = useState<SourceControlInfo | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dirty, setDirty] = useState(false);
  const initRef = useRef(false);
  const workflowRef = useRef(workflow);
  const pendingSaveRef = useRef<string | null>(null);

  useEffect(() => {
    workflowRef.current = workflow;
  }, [workflow]);

  useEffect(() => {
    const off = onMessage((msg: ExtToWebview) => {
      switch (msg.type) {
        case "workflow.loaded":
          setWorkflow(msg.workflow);
          setDirty(false);
          break;
        case "workflow.saved":
          if (msg.ok) {
            const currentSnapshot = JSON.stringify(workflowRef.current);
            if (!pendingSaveRef.current || pendingSaveRef.current === currentSnapshot) {
              setDirty(false);
              setStatus("Saved.");
            } else {
              setDirty(true);
              setStatus("Autosaving...");
            }
            pendingSaveRef.current = null;
            window.setTimeout(() => setStatus(""), 1500);
          } else {
            setStatus(`Save failed: ${msg.error ?? "unknown error"}`);
          }
          break;
        case "agents.list":
          setAgents(msg.agents);
          break;
        case "models.list":
          setModels(msg.models);
          break;
        case "sourceControl.detected":
          setSourceControl(msg.sourceControl);
          break;
        case "ledger.append":
          setNowMs(Date.now());
          setLedger((prev) => [...prev.slice(-1999), msg.entry]);
          break;
        case "node.runResult":
          setStatus(msg.ok ? `Ran node ${msg.nodeId}.` : `Run failed: ${msg.error}`);
          window.setTimeout(() => setStatus(""), 2000);
          break;
        case "trigger.testResult":
          setStatus(msg.ok ? `Validation trigger sent to ${msg.nodeId}.` : `Validation failed: ${msg.error}`);
          window.setTimeout(() => setStatus(""), 2500);
          break;
        case "toast":
          setStatus(msg.message);
          window.setTimeout(() => setStatus(""), 3000);
          break;
      }
    });
    if (!initRef.current) {
      initRef.current = true;
      send({ type: "ready" });
    }
    return off;
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      const snapshot = JSON.stringify(workflowRef.current);
      pendingSaveRef.current = snapshot;
      setStatus("Autosaving...");
      send({ type: "workflow.save", workflow: workflowRef.current });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, workflow]);

  useEffect(() => {
    if (view !== "graph") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), EDGE_ACTIVITY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [view]);

  const selectedNode = useMemo(
    () => (selectedNodeId ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [selectedNodeId, workflow]
  );
  const selectedEdge = useMemo(
    () => (selectedEdgeId ? workflow.edges.find((edge) => edge.id === selectedEdgeId) ?? null : null),
    [selectedEdgeId, workflow]
  );
  const activityByNode = useMemo(() => buildNodeActivity(workflow, ledger), [workflow, ledger]);
  const activityByEdge = useMemo(() => buildEdgeActivity(workflow, ledger, nowMs), [workflow, ledger, nowMs]);
  const tokenUsage = useMemo(() => buildTokenUsage(workflow, ledger), [workflow, ledger]);
  const toolUsage = useMemo(() => buildToolUsage(workflow, ledger), [workflow, ledger]);
  const runOutputByNode = useMemo(() => buildNodeRunOutput(workflow, ledger), [workflow, ledger]);
  const selectedActivity = selectedNode ? activityByNode[selectedNode.id] : null;
  const selectedUsage = selectedNode ? tokenUsage.byNode[selectedNode.id] ?? emptyUsage() : null;
  const selectedToolUsage = selectedNode ? toolUsage.byNode[selectedNode.id] ?? emptyToolUsage() : null;
  const selectedRunOutput = selectedNode ? runOutputByNode[selectedNode.id] ?? null : null;

  const selectNode = (id: string | null): void => {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  };

  const selectEdge = (id: string | null): void => {
    setSelectedEdgeId(id);
    setSelectedNodeId(null);
  };

  const clearSelection = (): void => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  };

  const updateNode = (next: WorkflowNode): void => {
    setWorkflow((wf) => ({
      ...wf,
      nodes: wf.nodes.map((n) => (n.id === next.id ? next : n))
    }));
    setDirty(true);
  };

  const addNode = (): void => {
    const id = nextNodeId(workflow.nodes);
    const newNode: WorkflowNode = {
      id,
      label: "New Persona",
      agent: "",
      trigger: { type: "manual" },
      context: "",
      position: { x: 100 + workflow.nodes.length * 60, y: 100 + workflow.nodes.length * 40 },
      enabled: true
    };
    setWorkflow((wf) => ({ ...wf, nodes: [...wf.nodes, newNode] }));
    selectNode(id);
    setDirty(true);
  };

  const deleteNode = (id: string): void => {
    setWorkflow((wf) => ({
      ...wf,
      nodes: wf.nodes.filter((n) => n.id !== id),
      edges: wf.edges.filter((e) => e.from !== id && e.to !== id)
    }));
    clearSelection();
    setDirty(true);
  };

  const addEdge = (from: string, to: string): void => {
    setWorkflow((wf) => {
      if (wf.edges.some((e) => e.from === from && e.to === to)) return wf;
      const id = `e_${from}_${to}_${Math.random().toString(36).slice(2, 6)}`;
      return { ...wf, edges: [...wf.edges, { id, from, to, payloadSchema: null, via: null }] };
    });
    setDirty(true);
  };

  const removeEdge = (id: string): void => {
    setWorkflow((wf) => ({ ...wf, edges: wf.edges.filter((e) => e.id !== id) }));
    if (selectedEdgeId === id) setSelectedEdgeId(null);
    setDirty(true);
  };

  const moveNode = (id: string, x: number, y: number): void => {
    setWorkflow((wf) => ({
      ...wf,
      nodes: wf.nodes.map((n) => (n.id === id ? { ...n, position: { x, y } } : n))
    }));
    setDirty(true);
  };

  const save = (): void => {
    pendingSaveRef.current = JSON.stringify(workflow);
    send({ type: "workflow.save", workflow });
  };

  const runSelected = (): void => {
    if (!selectedNode) return;
    setStatus("Saving and running...");
    send({ type: "node.run", nodeId: selectedNode.label || selectedNode.id, workflow });
  };

  const validateSelected = (): void => {
    if (!selectedNode) return;
    setStatus("Saving and validating trigger...");
    send({ type: "trigger.test", nodeId: selectedNode.label || selectedNode.id, workflow });
  };

  const replaceWorkflow = (next: Workflow): void => {
    setWorkflow(next);
    setDirty(true);
  };

  return (
    <div className="app">
      <div className="toolbar">
        <strong>Agent Orchestrator</strong>
        <span style={{ opacity: 0.6 }}>· {workflow.name} · {workflow.nodes.length} nodes</span>
        <span className="usage-chip" title="Total recorded token usage for loaded ledger entries">
          Tokens {formatTokenCount(tokenUsage.total.totalTokens)}
        </span>
        <span className="usage-chip" title="Total recorded tool calls for loaded ledger entries">
          Tools {formatTokenCount(toolUsage.total.toolCalls)}
        </span>
        <div className="spacer" />
        <button className="secondary" onClick={() => setView(view === "graph" ? "json" : "graph")}>
          {view === "graph" ? "View as JSON" : "View as Graph"}
        </button>
        <button onClick={addNode}>+ Node</button>
        <button onClick={runSelected} disabled={!selectedNode}>▶ Run selected</button>
        <button className="secondary" onClick={validateSelected} disabled={!selectedNode}>Validate trigger</button>
        <button onClick={save} disabled={!dirty}>{dirty ? "Save *" : "Saved"}</button>
        {status ? <span style={{ marginLeft: 8, opacity: 0.8 }}>{status}</span> : null}
      </div>

      <div className="canvas">
        {view === "graph" ? (
          <GraphView
            workflow={workflow}
            activityByNode={activityByNode}
            activityByEdge={activityByEdge}
            nowMs={nowMs}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={selectNode}
            onSelectEdge={selectEdge}
            onClearSelection={clearSelection}
            onMove={moveNode}
            onAddEdge={addEdge}
            onRemoveEdge={removeEdge}
          />
        ) : (
          <JsonView workflow={workflow} onChange={replaceWorkflow} />
        )}
      </div>

      <div className="side-panel">
        {selectedNode ? (
          <>
            <NodeForm
              node={selectedNode}
              agents={agents}
              models={models}
              sourceControl={sourceControl}
              onRefreshSourceControl={() => send({ type: "sourceControl.request" })}
              onChange={updateNode}
              onDelete={() => deleteNode(selectedNode.id)}
            />
            <NodeActivityPanel activity={selectedActivity} />
            <NodeRunOutputPanel output={selectedRunOutput} />
            <NodeUsagePanel usage={selectedUsage ?? emptyUsage()} />
            <NodeToolUsagePanel usage={selectedToolUsage ?? emptyToolUsage()} />
          </>
        ) : selectedEdge ? (
          <ConnectionPanel
            workflow={workflow}
            edgeId={selectedEdge.id}
            onDelete={() => removeEdge(selectedEdge.id)}
          />
        ) : (
          <div>
            <h3>Workflow</h3>
            <label>Name</label>
            <input
              type="text"
              value={workflow.name}
              onChange={(e) => {
                setWorkflow((wf) => ({ ...wf, name: e.target.value }));
                setDirty(true);
              }}
            />
            <label>Daily handoff cap</label>
            <input
              type="number"
              min={1}
              value={workflow.settings.dailyHandoffCap}
              onChange={(e) => {
                setWorkflow((wf) => ({
                  ...wf,
                  settings: { ...wf.settings, dailyHandoffCap: Number(e.target.value) || 1 }
                }));
                setDirty(true);
              }}
            />
            <label>Concurrency limit</label>
            <input
              type="number"
              min={1}
              max={32}
              value={workflow.settings.concurrencyLimit}
              onChange={(e) => {
                setWorkflow((wf) => ({
                  ...wf,
                  settings: { ...wf.settings, concurrencyLimit: Number(e.target.value) || 1 }
                }));
                setDirty(true);
              }}
            />
            <p style={{ marginTop: 16, opacity: 0.7, fontSize: 11 }}>
              Click a node to edit its fields. Drag from a node's right edge to another node to create an edge.
            </p>
            <WorkflowUsagePanel usage={tokenUsage.total} />
            <WorkflowToolUsagePanel usage={toolUsage.total} />
          </div>
        )}
      </div>

      <LedgerPanel entries={ledger} />
    </div>
  );
}

function NodeRunOutputPanel({ output }: { output: NodeRunOutput | null }): JSX.Element {
  const text = output?.chunks.join("") ?? "";
  return (
    <div className="activity-panel run-output-panel">
      <h3>Run Output</h3>
      {output ? (
        <>
          <p className="field-note">
            {output.status}{output.updatedAt ? ` · ${shortTime(output.updatedAt)}` : ""}
          </p>
          <pre className="run-output-text">{text || output.error || "No text output captured for this run yet."}</pre>
          <p className="field-note">Event: <code>{output.eventId}</code></p>
        </>
      ) : (
        <p className="field-note">No captured background output yet. Manual @orchestrator chat runs still appear in VS Code Chat.</p>
      )}
    </div>
  );
}

function NodeToolUsagePanel({ usage }: { usage: ToolUsageSummary }): JSX.Element {
  return (
    <div className="activity-panel">
      <h3>Tool Usage</h3>
      {usage.runs > 0 ? (
        <>
          <div className="usage-total">{formatTokenCount(usage.toolCalls)}</div>
          <p className="field-note">Rounds: {formatTokenCount(usage.toolRounds)} · Failed: {formatTokenCount(usage.failedToolCalls)}</p>
          <p className="field-note">Runs: {usage.runs}{usage.limitHits > 0 ? ` · limit hits: ${usage.limitHits}` : ""}</p>
          <ToolBreakdown usage={usage} />
        </>
      ) : (
        <p className="field-note">No tool usage recorded yet.</p>
      )}
    </div>
  );
}

function WorkflowToolUsagePanel({ usage }: { usage: ToolUsageSummary }): JSX.Element {
  return (
    <div className="activity-panel">
      <h3>Workflow Tools</h3>
      <div className="usage-total">{formatTokenCount(usage.toolCalls)}</div>
      <p className="field-note">Rounds: {formatTokenCount(usage.toolRounds)} · Failed: {formatTokenCount(usage.failedToolCalls)}</p>
      <p className="field-note">Runs: {usage.runs}{usage.limitHits > 0 ? ` · limit hits: ${usage.limitHits}` : ""}</p>
      <ToolBreakdown usage={usage} />
    </div>
  );
}

function ToolBreakdown({ usage }: { usage: ToolUsageSummary }): JSX.Element | null {
  const tools = Object.entries(usage.byTool)
    .sort((left, right) => right[1].calls - left[1].calls || left[0].localeCompare(right[0]))
    .slice(0, 5);
  if (tools.length === 0) return null;
  return (
    <ul className="tool-breakdown">
      {tools.map(([name, tool]) => (
        <li key={name}>
          <span>{name}</span>
          <span>{tool.calls}{tool.failures > 0 ? ` / ${tool.failures} failed` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function NodeUsagePanel({ usage }: { usage: TokenUsageSummary }): JSX.Element {
  return (
    <div className="activity-panel">
      <h3>Token Usage</h3>
      {usage.runs > 0 ? (
        <>
          <div className="usage-total">{formatTokenCount(usage.totalTokens)}</div>
          <p className="field-note">Input: {formatTokenCount(usage.inputTokens)} · Output: {formatTokenCount(usage.outputTokens)}</p>
          <p className="field-note">Runs: {usage.runs}{usage.estimatedRuns > 0 ? ` · estimated: ${usage.estimatedRuns}` : ""}</p>
        </>
      ) : (
        <p className="field-note">No token usage recorded yet.</p>
      )}
    </div>
  );
}

function WorkflowUsagePanel({ usage }: { usage: TokenUsageSummary }): JSX.Element {
  return (
    <div className="activity-panel">
      <h3>Workflow Usage</h3>
      <div className="usage-total">{formatTokenCount(usage.totalTokens)}</div>
      <p className="field-note">Input: {formatTokenCount(usage.inputTokens)} · Output: {formatTokenCount(usage.outputTokens)}</p>
      <p className="field-note">Runs: {usage.runs}{usage.estimatedRuns > 0 ? ` · estimated: ${usage.estimatedRuns}` : ""}</p>
    </div>
  );
}

function ConnectionPanel({
  workflow,
  edgeId,
  onDelete
}: {
  workflow: Workflow;
  edgeId: string;
  onDelete: () => void;
}): JSX.Element {
  const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
  const fromNode = edge ? workflow.nodes.find((node) => node.id === edge.from) : null;
  const toNode = edge ? workflow.nodes.find((node) => node.id === edge.to) : null;
  return (
    <div>
      <h3>Connection</h3>
      <p className="field-note">ID: <code>{edgeId}</code></p>
      <label>From</label>
      <input value={fromNode?.label ?? edge?.from ?? ""} readOnly />
      <label>To</label>
      <input value={toNode?.label ?? edge?.to ?? ""} readOnly />
      <div className="row" style={{ marginTop: 16 }}>
        <button className="danger" onClick={onDelete}>Delete connection</button>
      </div>
    </div>
  );
}

function NodeActivityPanel({ activity }: { activity: NodeActivity | null }): JSX.Element {
  return (
    <div className="activity-panel">
      <h3>Runtime</h3>
      {activity ? (
        <>
          <div className={`activity-status ${activity.status}`}>{activity.label}</div>
          <p className="field-note">{activity.detail}</p>
          {activity.ts ? <p className="field-note">Last event: {shortTime(activity.ts)}</p> : null}
          {activity.eventId ? <p className="field-note">Event: <code>{activity.eventId}</code></p> : null}
        </>
      ) : (
        <p className="field-note">No runtime activity yet.</p>
      )}
    </div>
  );
}

function buildNodeActivity(workflow: Workflow, entries: LedgerEntry[]): Record<string, NodeActivity> {
  const activity: Record<string, NodeActivity> = {};
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  for (const entry of entries) {
    const next = activityFromEntry(entry, nodeIds);
    if (!next) continue;
    activity[next.nodeId] = next.activity;
  }
  return activity;
}

function buildTokenUsage(workflow: Workflow, entries: LedgerEntry[]): WorkflowTokenUsage {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const byNode: Record<string, TokenUsageSummary> = {};
  const total = emptyUsage();
  for (const entry of entries) {
    if (entry.type !== "usage.recorded") continue;
    const node = typeof entry.node === "string" ? entry.node : undefined;
    if (!node || !nodeIds.has(node)) continue;
    const usage = byNode[node] ?? (byNode[node] = emptyUsage());
    const inputTokens = numberField(entry.inputTokens);
    const outputTokens = numberField(entry.outputTokens);
    const totalTokens = numberField(entry.totalTokens) || inputTokens + outputTokens;
    const estimated = entry.estimated === true;
    addUsage(usage, inputTokens, outputTokens, totalTokens, estimated);
    addUsage(total, inputTokens, outputTokens, totalTokens, estimated);
  }
  return { total, byNode };
}

function buildToolUsage(workflow: Workflow, entries: LedgerEntry[]): WorkflowToolUsage {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const byNode: Record<string, ToolUsageSummary> = {};
  const total = emptyToolUsage();
  for (const entry of entries) {
    if (entry.type !== "toolUsage.recorded") continue;
    const node = typeof entry.node === "string" ? entry.node : undefined;
    if (!node || !nodeIds.has(node)) continue;
    const usage = byNode[node] ?? (byNode[node] = emptyToolUsage());
    const toolCalls = numberField(entry.toolCalls);
    const toolRounds = numberField(entry.toolRounds);
    const failedToolCalls = numberField(entry.failedToolCalls);
    const reachedLimit = entry.reachedLimit === true;
    addToolUsage(usage, toolCalls, toolRounds, failedToolCalls, reachedLimit, entry.tools);
    addToolUsage(total, toolCalls, toolRounds, failedToolCalls, reachedLimit, entry.tools);
  }
  return { total, byNode };
}

function buildNodeRunOutput(workflow: Workflow, entries: LedgerEntry[]): Record<string, NodeRunOutput> {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const byEvent = new Map<string, NodeRunOutput & { nodeId: string }>();
  const latestByNode: Record<string, NodeRunOutput> = {};

  const touchLatest = (nodeId: string, output: NodeRunOutput): void => {
    const previous = latestByNode[nodeId];
    if (!previous || Date.parse(output.updatedAt ?? output.startedAt ?? "") >= Date.parse(previous.updatedAt ?? previous.startedAt ?? "")) {
      latestByNode[nodeId] = output;
    }
  };

  const ensureOutput = (nodeId: string, eventId: string, ts: string): NodeRunOutput & { nodeId: string } => {
    const key = `${nodeId}:${eventId}`;
    let output = byEvent.get(key);
    if (!output) {
      output = { nodeId, eventId, status: "running", chunks: [], startedAt: ts, updatedAt: ts };
      byEvent.set(key, output);
    }
    return output;
  };

  for (const entry of entries) {
    const node = typeof entry.node === "string" ? entry.node : undefined;
    const eventId = typeof entry.eventId === "string" ? entry.eventId : undefined;
    if (!node || !eventId || !nodeIds.has(node)) continue;

    if (entry.type === "trigger.fired") {
      const output = ensureOutput(node, eventId, entry.ts);
      output.status = "running";
      output.updatedAt = entry.ts;
      touchLatest(node, output);
      continue;
    }
    if (entry.type === "session.output") {
      const output = ensureOutput(node, eventId, entry.ts);
      if (typeof entry.content === "string") output.chunks.push(entry.content);
      if (output.status !== "completed" && output.status !== "errored") output.status = "running";
      output.updatedAt = entry.ts;
      touchLatest(node, output);
      continue;
    }
    if (entry.type === "session.spawned") {
      const output = ensureOutput(node, eventId, entry.ts);
      output.status = "completed";
      output.updatedAt = entry.ts;
      touchLatest(node, output);
      continue;
    }
    if (entry.type === "session.errored") {
      const output = ensureOutput(node, eventId, entry.ts);
      output.status = "errored";
      output.error = typeof entry.error === "string" ? entry.error : "Session errored.";
      output.updatedAt = entry.ts;
      touchLatest(node, output);
    }
  }

  return latestByNode;
}

function emptyUsage(): TokenUsageSummary {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, runs: 0, estimatedRuns: 0 };
}

function emptyToolUsage(): ToolUsageSummary {
  return { toolCalls: 0, toolRounds: 0, failedToolCalls: 0, runs: 0, limitHits: 0, byTool: {} };
}

function addUsage(
  usage: TokenUsageSummary,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  estimated: boolean
): void {
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.totalTokens += totalTokens;
  usage.runs += 1;
  if (estimated) usage.estimatedRuns += 1;
}

function addToolUsage(
  usage: ToolUsageSummary,
  toolCalls: number,
  toolRounds: number,
  failedToolCalls: number,
  reachedLimit: boolean,
  tools: unknown
): void {
  usage.toolCalls += toolCalls;
  usage.toolRounds += toolRounds;
  usage.failedToolCalls += failedToolCalls;
  usage.runs += 1;
  if (reachedLimit) usage.limitHits += 1;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "unknown";
    const current = usage.byTool[name] ?? (usage.byTool[name] = { calls: 0, failures: 0 });
    current.calls += numberField(record.calls);
    current.failures += numberField(record.failures);
  }
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function activityFromEntry(
  entry: LedgerEntry,
  nodeIds: Set<string>
): { nodeId: string; activity: NodeActivity } | null {
  const node = typeof entry.node === "string" ? entry.node : undefined;
  const to = typeof entry.to === "string" ? entry.to : undefined;
  const from = typeof entry.from === "string" ? entry.from : undefined;
  const eventId = typeof entry.eventId === "string" ? entry.eventId : undefined;
  switch (entry.type) {
    case "handoff.delivered":
      if (!to || !nodeIds.has(to)) return null;
      return {
        nodeId: to,
        activity: {
          status: "queued",
          label: entry.detail && (entry.detail as Record<string, unknown>).validation ? "Validation queued" : "Inbox received",
          detail: from ? `Handoff delivered from ${from}.` : "Handoff delivered to inbox.",
          ts: entry.ts,
          eventId
        }
      };
    case "handoff.consumed":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "running",
          label: "Handoff consumed",
          detail: from ? `Drained handoff from ${from}.` : "Drained an inbox handoff.",
          ts: entry.ts,
          eventId
        }
      };
    case "trigger.fired":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "running",
          label: "Running",
          detail: triggerDetail(entry),
          ts: entry.ts,
          eventId
        }
      };
    case "session.spawned":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "completed",
          label: "Completed",
          detail: sessionDetail(entry),
          ts: entry.ts,
          eventId
        }
      };
    case "session.errored":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "errored",
          label: "Errored",
          detail: typeof entry.error === "string" ? entry.error : "Session errored.",
          ts: entry.ts,
          eventId
        }
      };
    case "retry.scheduled":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "queued",
          label: "Retry scheduled",
          detail: retryDetail(entry),
          ts: entry.ts,
          eventId
        }
      };
    case "retry.restored":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "running",
          label: "Retry restored",
          detail: retryDetail(entry),
          ts: entry.ts,
          eventId
        }
      };
    case "guardrail.tripped":
      if (!node || !nodeIds.has(node)) return null;
      return {
        nodeId: node,
        activity: {
          status: "blocked",
          label: "Blocked",
          detail: typeof entry.rule === "string" ? `Guardrail: ${entry.rule}.` : "Guardrail tripped.",
          ts: entry.ts,
          eventId
        }
      };
    case "handoff.emitted":
      if (!from || !nodeIds.has(from)) return null;
      return {
        nodeId: from,
        activity: {
          status: "completed",
          label: "Handoff sent",
          detail: to ? `Sent handoff to ${to}.` : "Sent a handoff.",
          ts: entry.ts,
          eventId
        }
      };
    default:
      return null;
  }
}

function buildEdgeActivity(workflow: Workflow, entries: LedgerEntry[], nowMs: number): Record<string, EdgeActivity> {
  const activity: Record<string, EdgeActivity> = {};
  for (const entry of entries) {
    if (entry.type !== "handoff.emitted") continue;
    const timestamp = Date.parse(entry.ts);
    if (Number.isNaN(timestamp) || nowMs - timestamp > EDGE_ACTIVITY_TTL_MS) continue;
    const from = typeof entry.from === "string" ? entry.from : undefined;
    const to = typeof entry.to === "string" ? entry.to : undefined;
    if (!from || !to) continue;
    const edge = workflow.edges.find((candidate) => candidate.from === from && candidate.to === to);
    if (!edge) continue;
    activity[edge.id] = { label: `Handoff ${shortTime(entry.ts)}`, ts: entry.ts };
  }
  return activity;
}

function triggerDetail(entry: LedgerEntry): string {
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const drained = typeof detail.drainedHandoffs === "number" ? detail.drainedHandoffs : 0;
  const trigger = typeof entry.trigger === "string" ? entry.trigger : "manual";
  return drained > 0 ? `${trigger} trigger, drained ${drained} handoff(s).` : `${trigger} trigger fired.`;
}

function sessionDetail(entry: LedgerEntry): string {
  const drained = typeof entry.drainedHandoffs === "number" ? entry.drainedHandoffs : 0;
  const responseLength = typeof entry.responseLength === "number" ? entry.responseLength : 0;
  const handoffText = drained > 0 ? ` Drained ${drained} handoff(s).` : "";
  return responseLength > 0 ? `Response: ${responseLength} chars.${handoffText}` : `Session completed.${handoffText}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}K`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function retryDetail(entry: LedgerEntry): string {
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const retryAt = typeof detail.retryAt === "string" ? detail.retryAt : "";
  const drained = typeof detail.drainedHandoffs === "number" ? detail.drainedHandoffs : 0;
  const retryAtText = retryAt ? `Retry at ${shortTime(retryAt)}.` : "Retry queued.";
  return drained > 0 ? `${retryAtText} Preserved ${drained} handoff(s).` : retryAtText;
}

function shortTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function nextNodeId(nodes: WorkflowNode[]): string {
  const used = new Set(nodes.map((node) => node.id));
  for (let index = nodes.length + 1; index < nodes.length + 1000; index++) {
    const id = `node_${index}`;
    if (!used.has(id)) return id;
  }
  return `node_${Date.now().toString(36)}`;
}
