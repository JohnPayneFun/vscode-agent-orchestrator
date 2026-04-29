import React, { useCallback, useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange
} from "@xyflow/react";
import type { Workflow, WorkflowNode } from "../../shared/types.js";

interface Props {
  workflow: Workflow;
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onAddEdge: (from: string, to: string) => void;
  onRemoveEdge: (id: string) => void;
}

type FlowNode = Node<{ wfNode: WorkflowNode; selected: boolean }>;

function PersonaNode({ data, selected }: NodeProps<FlowNode>): JSX.Element {
  const node = data.wfNode;
  const triggerLabel = describeTrigger(node);
  return (
    <div className={`persona-node ${selected ? "selected" : ""} ${node.enabled ? "" : "disabled"}`}>
      <Handle
        type="target"
        position={Position.Left}
        className="handle-in"
        title="Input — handoffs from upstream nodes arrive here"
      />
      <span className="handle-label handle-label-in">IN</span>
      <div className="trigger-badge">On Trigger: {triggerLabel}</div>
      <div className="label">{node.label}</div>
      <div className="agent">{node.agent}</div>
      <div className="context">{node.context || <em style={{ opacity: 0.5 }}>(no context)</em>}</div>
      <span className="handle-label handle-label-out">OUT →</span>
      <Handle
        type="source"
        position={Position.Right}
        className="handle-out"
        title="Output — drag from here to connect to a downstream node"
      />
    </div>
  );
}

function describeTrigger(node: WorkflowNode): string {
  switch (node.trigger.type) {
    case "ghPr":
      return `GH PR · ${node.trigger.repo}`;
    case "timer":
      return `Timer · ${node.trigger.cron}`;
    case "handoff":
      return "New Message";
    case "manual":
      return "Manual";
    case "fileChange":
      return `File · ${node.trigger.glob}`;
  }
}

const nodeTypes = { persona: PersonaNode };

export function GraphView(props: Props): JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphViewInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphViewInner({
  workflow,
  selectedNodeId,
  onSelect,
  onMove,
  onAddEdge,
  onRemoveEdge
}: Props): JSX.Element {
  const flowNodes: FlowNode[] = useMemo(
    () =>
      workflow.nodes.map((n) => ({
        id: n.id,
        type: "persona",
        position: n.position,
        data: { wfNode: n, selected: n.id === selectedNodeId },
        selected: n.id === selectedNodeId
      })),
    [workflow.nodes, selectedNodeId]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      workflow.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.via ? `via ${e.via}` : undefined,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "#d18616" }
      })),
    [workflow.edges]
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeChanges(changes, flowNodes);
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          onMove(change.id, change.position.x, change.position.y);
        }
      }
      // Selection
      const sel = next.find((n) => (n as FlowNode).selected);
      if (sel && sel.id !== selectedNodeId) onSelect(sel.id);
      else if (!sel && selectedNodeId) onSelect(null);
    },
    [flowNodes, onMove, onSelect, selectedNodeId]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === "remove") onRemoveEdge(change.id);
      }
      applyEdgeChanges(changes, flowEdges);
    },
    [flowEdges, onRemoveEdge]
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (conn.source && conn.target) onAddEdge(conn.source, conn.target);
    },
    [onAddEdge]
  );

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
