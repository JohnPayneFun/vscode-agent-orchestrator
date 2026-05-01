import type { LedgerEntry, TriggerType, Workflow, WorkflowNode } from "../../shared/types.js";

export interface DownstreamBusyResult {
  busy: boolean;
  downstream: Array<{ nodeId: string; status: NodeRuntimeStatus }>;
}

type NodeRuntimeStatus = "queued" | "running" | "completed" | "errored" | "blocked" | "idle";

export function scheduledDispatchDownstreamState(
  workflow: Workflow,
  node: WorkflowNode,
  trigger: TriggerType,
  entries: LedgerEntry[]
): DownstreamBusyResult {
  if (!isScheduledTrigger(trigger)) return { busy: false, downstream: [] };

  const targets = workflow.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to);
  const downstream = targets.map((nodeId) => ({ nodeId, status: latestNodeStatus(entries, nodeId) }));
  return { busy: downstream.some((target) => target.status === "running"), downstream };
}

function isScheduledTrigger(trigger: TriggerType): boolean {
  return trigger === "timer" || trigger === "interval";
}

function latestNodeStatus(entries: LedgerEntry[], nodeId: string): NodeRuntimeStatus {
  let status: NodeRuntimeStatus = "idle";
  for (const entry of entries) {
    const node = typeof entry.node === "string" ? entry.node : undefined;
    const to = typeof entry.to === "string" ? entry.to : undefined;
    const from = typeof entry.from === "string" ? entry.from : undefined;

    switch (entry.type) {
      case "handoff.delivered":
        if (to === nodeId) status = "queued";
        break;
      case "trigger.fired":
      case "handoff.consumed":
      case "retry.restored":
        if (node === nodeId) status = "running";
        break;
      case "session.spawned":
        if (node === nodeId) status = "completed";
        break;
      case "session.errored":
        if (node === nodeId) status = "errored";
        break;
      case "guardrail.tripped":
        if (node === nodeId) status = "blocked";
        break;
      case "handoff.emitted":
        if (from === nodeId) status = "completed";
        break;
    }
  }
  return status;
}
