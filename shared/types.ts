// Shared types between extension host and webview.
// Pure types only — no imports, no runtime code.

export type TriggerType =
  | "ghPr"
  | "timer"
  | "interval"
  | "handoff"
  | "manual"
  | "fileChange"
  | "startup"
  | "diagnostics"
  | "webhook"
  | "any";

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

export interface TriggerInterval {
  type: "interval";
  every: number;
  unit: "seconds" | "minutes" | "hours" | "days";
  runOnStart?: boolean;
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

export interface TriggerStartup {
  type: "startup";
  delaySeconds?: number;
}

export interface TriggerDiagnostics {
  type: "diagnostics";
  glob: string;
  severity: "any" | "error" | "warning" | "info" | "hint";
  debounceMs?: number;
}

export interface TriggerWebhook {
  type: "webhook";
  path: string;
  port?: number;
  secretEnv?: string | null;
  secretHeader?: string;
}

export type TriggerLeafConfig =
  | TriggerGhPr
  | TriggerTimer
  | TriggerInterval
  | TriggerHandoff
  | TriggerManual
  | TriggerFileChange
  | TriggerStartup
  | TriggerDiagnostics
  | TriggerWebhook;

export interface TriggerAny {
  type: "any";
  triggers: TriggerLeafConfig[];
}

export type TriggerConfig = TriggerLeafConfig | TriggerAny;

export interface NodePosition {
  x: number;
  y: number;
}

export interface WorkflowNodeDisplay {
  showFullContext?: boolean;
}

export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface WorkflowNode {
  id: string;
  label: string;
  /** VS Code custom agent id from *.agent.md, used to load the agent instructions at runtime. */
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
  toolRoundLimit?: number | null;
  display?: WorkflowNodeDisplay;
  position: NodePosition;
  enabled: boolean;
}

export interface ModelSelector {
  vendor?: string;
  family?: string;
  id?: string;
  version?: string;
  reasoningEffort?: ModelReasoningEffort;
}

export interface AgentOption {
  id: string;
  label: string;
  path: string;
  source: "user" | "workspace";
  description?: string;
  defaultModel?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
}

export interface SourceControlInfo {
  repositoryRoot?: string;
  remoteUrl?: string;
  ownerRepo?: string;
  currentBranch?: string;
  currentBranchFilter?: string;
  error?: string;
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
  | "attempt.started"
  | "attempt.phase"
  | "attempt.succeeded"
  | "attempt.failed"
  | "attempt.hookSucceeded"
  | "attempt.hookFailed"
  | "trigger.fired"
  | "session.spawned"
  | "session.errored"
  | "usage.recorded"
  | "toolUsage.recorded"
  | "retry.scheduled"
  | "retry.restored"
  | "handoff.emitted"
  | "handoff.delivered"
  | "handoff.consumed"
  | "file.written"
  | "file.writeFailed"
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
  | { type: "models.requestList" }
  | { type: "sourceControl.request" }
  | { type: "node.run"; nodeId: string; workflow?: Workflow }
  | { type: "ledger.tail" }
  | { type: "trigger.test"; nodeId: string; workflow?: Workflow };

export type ExtToWebview =
  | { type: "workflow.loaded"; workflow: Workflow }
  | { type: "workflow.saved"; ok: boolean; error?: string }
  | { type: "agents.list"; agents: AgentOption[] }
  | { type: "models.list"; models: ModelOption[] }
  | { type: "sourceControl.detected"; sourceControl: SourceControlInfo }
  | { type: "node.runResult"; nodeId: string; ok: boolean; error?: string }
  | { type: "trigger.testResult"; nodeId: string; ok: boolean; error?: string }
  | { type: "ledger.append"; entry: LedgerEntry }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string };
