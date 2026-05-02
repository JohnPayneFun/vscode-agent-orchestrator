import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import type { TriggerConfig, Workflow, WorkflowNode } from "../../shared/types.js";
import { formatCountdown, formatInterval, nextTriggerAt } from "../../shared/schedule.js";
import type { EdgeActivity, NodeActivity } from "./App.js";

interface Props {
  workflow: Workflow;
  activityByNode: Record<string, NodeActivity>;
  activityByEdge: Record<string, EdgeActivity>;
  nowMs: number;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onViewNodeChat: (id: string) => void;
  onClearSelection: () => void;
  onMove: (id: string, x: number, y: number) => void;
  onAddEdge: (from: string, to: string) => void;
  onRemoveEdge: (id: string) => void;
}

type FlowNode = Node<{ wfNode: WorkflowNode; selected: boolean; nowMs: number; activity?: NodeActivity }>;

interface NodeContextMenuState {
  nodeId: string;
  label: string;
  x: number;
  y: number;
}

const PERSONA_NODE_WIDTH = 260;
const PERSONA_NODE_HEIGHT = 116;

function PersonaNode({ data, selected }: NodeProps<FlowNode>): JSX.Element {
  const node = data.wfNode;
  const activity = data.activity;
  const triggerLabel = describeTrigger(node);
  const countdown = describeCountdown(node, data.nowMs);
  const showFullContext = node.display?.showFullContext ?? false;
  return (
    <div className="persona-node-shell">
      {countdown ? <div className={`trigger-countdown ${countdown.tone ?? ""}`} title={countdown.title}>{countdown.label}</div> : null}
      <div className={`persona-node ${selected ? "selected" : ""} ${node.enabled ? "" : "disabled"} ${activity ? `activity-${activity.status}` : ""} ${showFullContext ? "show-full-context" : ""}`}>
        <Handle
          type="target"
          position={Position.Left}
          className="handle-in"
          title="Input — handoffs from upstream nodes arrive here"
        />
        <span className="handle-label handle-label-in">IN</span>
        <div className="trigger-badge">On Trigger: {triggerLabel}</div>
        {activity ? <div className={`runtime-badge ${activity.status}`} title={activity.detail}>{activity.label}</div> : null}
        <div className="label">{node.label}</div>
        <div className="agent">{node.agent}</div>
        <div className="context" title={node.context || undefined}>{node.context || <em style={{ opacity: 0.5 }}>(no context)</em>}</div>
        <span className="handle-label handle-label-out">OUT</span>
        <Handle
          type="source"
          position={Position.Right}
          className="handle-out"
          title="Output — drag from here to connect to a downstream node"
        />
      </div>
    </div>
  );
}

interface CountdownDescription {
  label: string;
  title: string;
  tone?: "warning";
}

function describeCountdown(node: WorkflowNode, nowMs: number): CountdownDescription | null {
  if (!node.enabled || !hasScheduledTrigger(node.trigger)) return null;
  const next = nextTriggerAt(node.trigger, nowMs);
  if (!next) return { label: "Schedule invalid", title: "The timer schedule could not be parsed.", tone: "warning" };
  return {
    label: `Next in ${formatCountdown(next.getTime() - nowMs)}`,
    title: `Next trigger: ${next.toLocaleString()}`
  };
}

function describeTrigger(node: WorkflowNode): string {
  return describeTriggerConfig(node.trigger);
}

function describeTriggerConfig(trigger: TriggerConfig): string {
  switch (trigger.type) {
    case "ghPr":
      return `GH PR · ${trigger.repo}`;
    case "timer":
      return `Timer · ${trigger.cron}`;
    case "interval":
      return formatInterval(trigger);
    case "handoff":
      return "New Message";
    case "manual":
      return "Manual";
    case "fileChange":
      return `File · ${trigger.glob}`;
    case "startup":
      return "Workspace start";
    case "diagnostics":
      return `Problems · ${trigger.severity}`;
    case "webhook":
      return `Webhook · ${trigger.path}`;
    case "any":
      return `Any · ${trigger.triggers.map(describeTriggerConfig).join(" / ")}`;
  }
}

function hasScheduledTrigger(trigger: TriggerConfig): boolean {
  return trigger.type === "timer" || trigger.type === "interval" || (trigger.type === "any" && trigger.triggers.some(hasScheduledTrigger));
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
  activityByNode,
  activityByEdge,
  nowMs,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onViewNodeChat,
  onClearSelection,
  onMove,
  onAddEdge,
  onRemoveEdge
}: Props): JSX.Element {
  const [contextMenu, setContextMenu] = useState<NodeContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [contextMenu]);

  const flowNodes: FlowNode[] = useMemo(
    () =>
      workflow.nodes.map((n) => ({
        id: n.id,
        type: "persona",
        position: n.position,
        initialWidth: PERSONA_NODE_WIDTH,
        initialHeight: PERSONA_NODE_HEIGHT,
        data: { wfNode: n, selected: n.id === selectedNodeId, nowMs, activity: activityByNode[n.id] },
        selected: n.id === selectedNodeId
      })),
    [activityByNode, workflow.nodes, nowMs, selectedNodeId]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      workflow.edges.map((e) => ({
        className: activityByEdge[e.id] ? "edge-active" : undefined,
        id: e.id,
        source: e.from,
        target: e.to,
        selected: e.id === selectedEdgeId,
        label: activityByEdge[e.id]?.label ?? (e.via ? `via ${e.via}` : undefined),
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color: activityByEdge[e.id] ? "#3fb950" : "#d18616"
        }
      })),
    [activityByEdge, selectedEdgeId, workflow.edges]
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
      if (sel && sel.id !== selectedNodeId) onSelectNode(sel.id);
      else if (!sel && selectedNodeId) onClearSelection();
    },
    [flowNodes, onClearSelection, onMove, onSelectNode, selectedNodeId]
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

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const flowNode = node as FlowNode;
      onSelectNode(flowNode.id);
      const menuWidth = 168;
      const menuHeight = 48;
      setContextMenu({
        nodeId: flowNode.id,
        label: flowNode.data.wfNode.label || flowNode.id,
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
      });
    },
    [onSelectNode]
  );

  const viewContextNodeChat = useCallback(() => {
    if (!contextMenu) return;
    onViewNodeChat(contextMenu.nodeId);
    setContextMenu(null);
  }, [contextMenu, onViewNodeChat]);

  return (
    <div className="graph-view-root">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_, n) => {
          closeContextMenu();
          onSelectNode(n.id);
        }}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeClick={(_, edge) => {
          closeContextMenu();
          onSelectEdge(edge.id);
        }}
        onEdgeDoubleClick={(_, edge) => onRemoveEdge(edge.id)}
        onPaneClick={() => {
          closeContextMenu();
          onClearSelection();
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          closeContextMenu();
        }}
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          className="workflow-minimap"
          bgColor="var(--vscode-editorWidget-background)"
          maskColor="rgba(0, 0, 0, 0.24)"
          maskStrokeColor="var(--vscode-focusBorder)"
          nodeBorderRadius={2}
          nodeColor={(node) => miniMapNodeColor(node as FlowNode)}
          nodeStrokeColor={(node) => miniMapNodeStrokeColor(node as FlowNode)}
          nodeStrokeWidth={2}
        />
      </ReactFlow>
      {contextMenu ? (
        <div
          className="node-context-menu"
          role="menu"
          aria-label={`Actions for ${contextMenu.label}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button type="button" role="menuitem" onClick={viewContextNodeChat}>View chat</button>
        </div>
      ) : null}
    </div>
  );
}

function miniMapNodeColor(node: FlowNode): string {
  if (node.selected) return "#d18616";
  if (node.data.activity) return activityColor(node.data.activity.status);
  return node.data.wfNode.enabled ? "#3794ff" : "#6e7681";
}

function miniMapNodeStrokeColor(node: FlowNode): string {
  return node.selected ? "#f0f6fc" : "#c9d1d9";
}

function activityColor(status: NodeActivity["status"]): string {
  switch (status) {
    case "queued":
    case "running":
      return "#d18616";
    case "completed":
      return "#3fb950";
    case "errored":
    case "blocked":
      return "#f85149";
    case "idle":
    default:
      return "#3794ff";
  }
}
