// Shared types between extension host and webview.
// Pure types only — no imports, no runtime code.

export type TriggerType = "ghPr" | "timer" | "handoff" | "manual" | "fileChange";

export interface TriggerGhPr {
  type: "ghPr";
  repo: string; // "owner/repo"
  events: Array<"opened" | "synchronize" | "reopened" | "closed">;
  branchFilter: string | null;
}

export interface TriggerTimer {
  type: "timer";
  cron: string;
  tz: "local" | "utc";
}

export interface TriggerHandoff {
  type: "handoff";
}

export interface TriggerManual {
  type: "manual";
}

export interface TriggerFileChange {
  type: "fileChange";
  glob: string;
}

export type TriggerConfig =
  | TriggerGhPr
  | TriggerTimer
  | TriggerHandoff
  | TriggerManual
  | TriggerFileChange;

export interface NodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  label: string;
  /** Free-form agent label, displayed in the graph. Has no runtime effect — the chat participant uses `context` as the system prompt. */
  agent: string;
  trigger: TriggerConfig;
  context: string;
  /**
   * Optional model selector. Maps to vscode.lm.selectChatModels — for example
   *   { vendor: "copilot", family: "gpt-4o" }
   * If null/undefined, the participant uses request.model (whatever the user
   * picked in the chat model dropdown).
   */
  model?: ModelSelector | null;
  position: NodePosition;
  enabled: boolean;
}

export interface ModelSelector {
  vendor?: string;
  family?: string;
  id?: string;
  version?: string;
}

export interface WorkflowEdge {
  id: string;
  from: string; // node id
  to: string; // node id
  payloadSchema?: Record<string, unknown> | null; // JSON Schema fragment
  via?: "monday" | "jira" | null;
}

export interface WorkflowSettings {
  dailyHandoffCap: number;
  concurrencyLimit: number;
  ledgerRetentionDays: number;
}

export interface Workflow {
  $schema?: string;
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: WorkflowSettings;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface HandoffPayload {
  schemaVersion: 1;
  id: string; // ULID
  createdAt: string;
  from: string; // node id (or "external" for first triggers)
  to: string; // node id
  edgeId: string | null;
  /** Origin tag — usually a TriggerType but also "spawnedSession" when emitted by a chat participant. */
  trigger: { type: string; [k: string]: unknown };
  payload: Record<string, unknown>;
  trace: {
    rootId: string;
    depth: number;
    parents: string[];
  };
}

export type LedgerEventType =
  | "trigger.fired"
  | "session.spawned"
  | "session.errored"
  | "handoff.emitted"
  | "handoff.delivered"
  | "handoff.consumed"
  | "guardrail.tripped"
  | "workflow.saved";

export interface LedgerEntry {
  ts: string;
  type: LedgerEventType;
  eventId?: string; // chain root id
  node?: string;
  trigger?: TriggerType;
  detail?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---- Webview <-> Extension message protocol ----

export type WebviewToExt =
  | { type: "ready" }
  | { type: "workflow.requestLoad" }
  | { type: "workflow.save"; workflow: Workflow }
  | { type: "agents.requestList" }
  | { type: "node.run"; nodeId: string }
  | { type: "ledger.tail" }
  | { type: "trigger.test"; nodeId: string };

export type ExtToWebview =
  | { type: "workflow.loaded"; workflow: Workflow }
  | { type: "workflow.saved"; ok: boolean; error?: string }
  | { type: "agents.list"; agents: Array<{ id: string; label: string; path: string }> }
  | { type: "node.runResult"; nodeId: string; ok: boolean; error?: string }
  | { type: "ledger.append"; entry: LedgerEntry }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string };
