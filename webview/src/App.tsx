import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Workflow, WorkflowNode, LedgerEntry, ExtToWebview } from "../../shared/types.js";
import { send, onMessage } from "./api.js";
import { GraphView } from "./GraphView.js";
import { JsonView } from "./JsonView.js";
import { NodeForm } from "./NodeForm.js";
import { LedgerPanel } from "./LedgerPanel.js";

type View = "graph" | "json";

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

export function App(): JSX.Element {
  const [workflow, setWorkflow] = useState<Workflow>(EMPTY_WORKFLOW);
  const [view, setView] = useState<View>("graph");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; label: string; path: string }>>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    const off = onMessage((msg: ExtToWebview) => {
      switch (msg.type) {
        case "workflow.loaded":
          setWorkflow(msg.workflow);
          setDirty(false);
          break;
        case "workflow.saved":
          if (msg.ok) {
            setStatus("Saved.");
            setDirty(false);
            window.setTimeout(() => setStatus(""), 1500);
          } else {
            setStatus(`Save failed: ${msg.error ?? "unknown error"}`);
          }
          break;
        case "agents.list":
          setAgents(msg.agents);
          break;
        case "ledger.append":
          setLedger((prev) => [...prev.slice(-499), msg.entry]);
          break;
        case "node.runResult":
          setStatus(msg.ok ? `Ran node ${msg.nodeId}.` : `Run failed: ${msg.error}`);
          window.setTimeout(() => setStatus(""), 2000);
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

  const selectedNode = useMemo(
    () => (selectedNodeId ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [selectedNodeId, workflow]
  );

  const updateNode = (next: WorkflowNode): void => {
    setWorkflow((wf) => ({
      ...wf,
      nodes: wf.nodes.map((n) => (n.id === next.id ? next : n))
    }));
    setDirty(true);
  };

  const addNode = (): void => {
    const id = `node_${Math.random().toString(36).slice(2, 8)}`;
    const newNode: WorkflowNode = {
      id,
      label: "New Persona",
      agent: "agent",
      trigger: { type: "manual" },
      context: "",
      position: { x: 100 + workflow.nodes.length * 60, y: 100 + workflow.nodes.length * 40 },
      enabled: true
    };
    setWorkflow((wf) => ({ ...wf, nodes: [...wf.nodes, newNode] }));
    setSelectedNodeId(id);
    setDirty(true);
  };

  const deleteNode = (id: string): void => {
    setWorkflow((wf) => ({
      ...wf,
      nodes: wf.nodes.filter((n) => n.id !== id),
      edges: wf.edges.filter((e) => e.from !== id && e.to !== id)
    }));
    setSelectedNodeId(null);
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
    send({ type: "workflow.save", workflow });
  };

  const runSelected = (): void => {
    if (!selectedNode) return;
    send({ type: "node.run", nodeId: selectedNode.id });
  };

  const replaceWorkflow = (next: Workflow): void => {
    setWorkflow(next);
    setDirty(true);
  };

  return (
    <div className="app">
      <div className="toolbar">
        <strong>Claude Orchestrator</strong>
        <span style={{ opacity: 0.6 }}>· {workflow.name} · {workflow.nodes.length} nodes</span>
        <div className="spacer" />
        <button className="secondary" onClick={() => setView(view === "graph" ? "json" : "graph")}>
          {view === "graph" ? "View as JSON" : "View as Graph"}
        </button>
        <button onClick={addNode}>+ Node</button>
        <button onClick={runSelected} disabled={!selectedNode}>▶ Run selected</button>
        <button onClick={save} disabled={!dirty}>{dirty ? "Save *" : "Saved"}</button>
        {status ? <span style={{ marginLeft: 8, opacity: 0.8 }}>{status}</span> : null}
      </div>

      <div className="canvas">
        {view === "graph" ? (
          <GraphView
            workflow={workflow}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
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
          <NodeForm
            node={selectedNode}
            agents={agents}
            onChange={updateNode}
            onDelete={() => deleteNode(selectedNode.id)}
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
          </div>
        )}
      </div>

      <LedgerPanel entries={ledger} />
    </div>
  );
}
