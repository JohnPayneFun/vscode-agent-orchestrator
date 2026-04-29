import type { WorkflowNode } from "../../../shared/types.js";

export interface Trigger {
  readonly nodeId: string;
  start(): void;
  dispose(): void;
}

export interface TriggerDeps {
  fire: (node: WorkflowNode, detail?: Record<string, unknown>) => Promise<void>;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}
