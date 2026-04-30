import type { Workflow, WorkflowNode } from "../../shared/types.js";

export interface NodeResolution {
  node: WorkflowNode | null;
  matches: WorkflowNode[];
  reason: "empty" | "not-found" | "ambiguous" | "matched";
}

export function resolveWorkflowNode(workflow: Workflow | null, rawReference: string): NodeResolution {
  const reference = rawReference.trim();
  if (!workflow || reference.length === 0) {
    return { node: null, matches: [], reason: "empty" };
  }

  const exactId = workflow.nodes.find((node) => equals(node.id, reference));
  if (exactId) return { node: exactId, matches: [exactId], reason: "matched" };

  const exactLabel = workflow.nodes.filter((node) => equals(node.label, reference));
  if (exactLabel.length === 1) return { node: exactLabel[0], matches: exactLabel, reason: "matched" };
  if (exactLabel.length > 1) return { node: null, matches: exactLabel, reason: "ambiguous" };

  const exactAgent = workflow.nodes.filter((node) => node.agent && equals(node.agent, reference));
  if (exactAgent.length === 1) return { node: exactAgent[0], matches: exactAgent, reason: "matched" };
  if (exactAgent.length > 1) return { node: null, matches: exactAgent, reason: "ambiguous" };

  const normalizedReference = normalize(reference);
  const fuzzy = workflow.nodes.filter((node) => {
    const labels = [node.label, node.id, node.agent].filter(Boolean).map(normalize);
    return labels.some(
      (value) => value === normalizedReference || value.includes(normalizedReference) || normalizedReference.includes(value)
    );
  });

  if (fuzzy.length === 1) return { node: fuzzy[0], matches: fuzzy, reason: "matched" };
  if (fuzzy.length > 1) return { node: null, matches: fuzzy, reason: "ambiguous" };
  return { node: null, matches: [], reason: "not-found" };
}

export function formatNodeReference(node: WorkflowNode): string {
  return node.label.trim() ? node.label.trim() : node.id;
}

export function nodeSuggestions(workflow: Workflow | null, limit = 5): string {
  if (!workflow || workflow.nodes.length === 0) return "";
  return workflow.nodes
    .slice(0, limit)
    .map((node) => `\`${formatNodeReference(node)}\``)
    .join(", ");
}

function equals(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
