import { ulid } from "ulid";
import type { HandoffPayload, ModelSelector, TriggerType, Workflow, WorkflowNode } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";
import { writeNodeFileArtifacts, type FileArtifactResult } from "./file-artifacts.js";
import { takeRetryState } from "./retry-state.js";

const TRIGGER_TAG_RE = /\[triggered:(\w+)(?::([^\]]+))?\]/;
const HANDOFF_BLOCK_RE = /<<HANDOFF\s+target=([a-zA-Z0-9_-]+)>>([\s\S]*?)<<END>>/g;

export interface RuntimeChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RuntimeLanguageModel {
  id: string;
  name: string;
  vendor?: string;
  family?: string;
  sendRequest(messages: RuntimeChatMessage[]): AsyncIterable<string>;
}

export interface RuntimeModelProvider {
  selectModel(selector: ModelSelector | undefined): Promise<RuntimeLanguageModel>;
}

export interface NodeRunnerDeps {
  paths: OrchestrationPaths;
  bus: MessageBus;
  ledger: Ledger;
  getWorkflow: () => Workflow | null;
  getAgentInstructions: (agentId: string) => Promise<string | null>;
  modelProvider: RuntimeModelProvider;
}

export interface RunWorkflowNodeArgs {
  deps: NodeRunnerDeps;
  node: WorkflowNode;
  userText?: string;
  history?: RuntimeChatMessage[];
  dryRun?: boolean;
  source?: string;
  spawner?: string;
  onMarkdown?: (markdown: string) => void | Promise<void>;
}

export interface RunWorkflowNodeResult {
  nodeId: string;
  eventId: string;
  assistantText: string;
  handoffsEmitted: number;
  drainedHandoffs: number;
  fileArtifacts: FileArtifactResult[];
}

export class WorkflowNodeRunError extends Error {
  readonly eventId: string;
  readonly drainedHandoffs: HandoffPayload[];
  readonly cleanedUserText: string;
  readonly triggerType: string;

  constructor(
    message: string,
    options: { cause: unknown; eventId: string; drainedHandoffs: HandoffPayload[]; cleanedUserText: string; triggerType: string }
  ) {
    super(message);
    this.name = "WorkflowNodeRunError";
    this.cause = options.cause;
    this.eventId = options.eventId;
    this.drainedHandoffs = options.drainedHandoffs;
    this.cleanedUserText = options.cleanedUserText;
    this.triggerType = options.triggerType;
  }
}

type OutgoingHandoff = {
  target: string;
  payload: Record<string, unknown>;
  edgeId?: string | null;
  source: "spawnedSession" | "graphEdge";
};

export async function runWorkflowNode(args: RunWorkflowNodeArgs): Promise<RunWorkflowNodeResult> {
  const { deps, node, userText = "", history = [] } = args;
  const eventId = ulid();
  const source = args.source ?? "direct";
  const spawner = args.spawner ?? "node-runner";
  const emit = async (markdown: string): Promise<void> => {
    await args.onMarkdown?.(markdown);
  };

  const triggerInfo = parseTriggerTag(userText);
  let triggerType = triggerInfo.type;
  let cleanedUserText = userText.replace(TRIGGER_TAG_RE, "").trim();

  let drained = await deps.bus.drain(node.id);
  const retryId = triggerInfo.detail.retryId;
  if (retryId) {
    const retryState = await takeRetryState(deps.paths, retryId);
    if (retryState?.nodeId === node.id) {
      triggerType = retryState.triggerType;
      cleanedUserText = [retryState.userText, cleanedUserText].filter(Boolean).join("\n\n");
      drained = [...retryState.drainedHandoffs, ...drained];
      await deps.ledger.append({
        type: "retry.restored",
        node: node.id,
        eventId,
        detail: { retryId, drainedHandoffs: retryState.drainedHandoffs.length, retryAt: retryState.retryAt }
      });
    }
  }

  await deps.ledger.append({
    type: "trigger.fired",
    eventId,
    node: node.id,
    trigger: triggerType as TriggerType,
    detail: { source, drainedHandoffs: drained.length }
  });

  for (const handoff of drained) {
    await deps.ledger.append({
      type: "handoff.consumed",
      eventId: handoff.trace.rootId ?? eventId,
      node: node.id,
      from: handoff.from,
      to: handoff.to,
      handoffId: handoff.id,
      detail: { edgeId: handoff.edgeId, depth: handoff.trace.depth }
    });
  }

  const agentInstructions = node.agent ? await deps.getAgentInstructions(node.agent) : null;
  const systemContent = buildSystemMessage(node, deps.paths.inboxRoot, agentInstructions);
  const userContent = buildUserMessage(node, drained, cleanedUserText, triggerType);
  const messages: RuntimeChatMessage[] = [
    { role: "user", content: systemContent },
    ...history,
    { role: "user", content: userContent }
  ];

  if (drained.length > 0) {
    await emit(`*Drained ${drained.length} pending handoff(s) from inbox.*\n\n`);
  }

  const modelSelector = normalizeModelSelector(node.model);
  if (args.dryRun) {
    await emit("`dryRun` is enabled - skipping the model call.");
    await deps.ledger.append({
      type: "session.spawned",
      node: node.id,
      eventId,
      dryRun: true,
      modelSelector,
      promptLength: systemContent.length + userContent.length
    });
    return {
      nodeId: node.id,
      eventId,
      assistantText: "",
      handoffsEmitted: 0,
      drainedHandoffs: drained.length,
      fileArtifacts: []
    };
  }

  let assistantText = "";
  let model: RuntimeLanguageModel;
  try {
    model = await deps.modelProvider.selectModel(modelSelector);
    for await (const fragment of model.sendRequest(messages)) {
      assistantText += fragment;
      await emit(fragment);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.ledger.append({
      type: "session.errored",
      node: node.id,
      eventId,
      error: message
    });
    throw new WorkflowNodeRunError(message, { cause: err, eventId, drainedHandoffs: drained, cleanedUserText, triggerType });
  }

  await deps.ledger.append({
    type: "session.spawned",
    node: node.id,
    eventId,
    spawner,
    model: model.id,
    modelVendor: model.vendor,
    modelFamily: model.family,
    modelSelector,
    promptLength: systemContent.length + userContent.length,
    responseLength: assistantText.length,
    drainedHandoffs: drained.length
  });

  const fileArtifacts = await writeArtifacts({ deps, node, eventId, assistantText, drained, emit });
  const explicitHandoffs = parseHandoffs(assistantText);
  const graphHandoffs = explicitHandoffs.length > 0 ? [] : buildGraphHandoffs(deps.getWorkflow(), node, assistantText);
  const handoffs = explicitHandoffs.length > 0 ? explicitHandoffs : graphHandoffs;

  if (handoffs.length > 0) {
    const handoffSourceLabel = explicitHandoffs.length > 0 ? "outgoing" : "graph edge";
    await emit(`\n\n---\n*Routing ${handoffs.length} ${handoffSourceLabel} handoff(s)...*\n`);
    for (const handoff of handoffs) {
      const payload = deps.bus.buildPayload({
        from: node.id,
        to: handoff.target,
        edgeId: handoff.edgeId ?? findEdgeId(deps.getWorkflow(), node.id, handoff.target),
        trigger: { type: handoff.source, source: spawner },
        payload: handoff.payload,
        rootId: drained[0]?.trace.rootId ?? eventId,
        depth: (drained[0]?.trace.depth ?? 0) + 1,
        parentId: drained[0]?.id
      });
      const { inboxPath, outboxPath } = await deps.bus.deliver(payload);
      await deps.ledger.append({
        type: "handoff.emitted",
        eventId,
        from: node.id,
        to: handoff.target,
        handoffId: payload.id,
        payloadBytes: JSON.stringify(payload).length,
        outboxPath,
        detail: { edgeId: payload.edgeId, source: handoff.source }
      });
      await deps.ledger.append({
        type: "handoff.delivered",
        eventId,
        from: node.id,
        to: handoff.target,
        handoffId: payload.id,
        inboxPath,
        detail: { edgeId: payload.edgeId, source: handoff.source }
      });
      await emit(`  -> \`${handoff.target}\` (id ${payload.id})\n`);
    }
  }

  return {
    nodeId: node.id,
    eventId,
    assistantText,
    handoffsEmitted: handoffs.length,
    drainedHandoffs: drained.length,
    fileArtifacts
  };
}

async function writeArtifacts(args: {
  deps: NodeRunnerDeps;
  node: WorkflowNode;
  eventId: string;
  assistantText: string;
  drained: HandoffPayload[];
  emit: (markdown: string) => Promise<void>;
}): Promise<FileArtifactResult[]> {
  try {
    const fileArtifacts = await writeNodeFileArtifacts({
      node: args.node,
      workspaceRoot: args.deps.paths.workspaceRoot,
      assistantText: args.assistantText,
      drained: args.drained
    });
    for (const artifact of fileArtifacts) {
      await args.deps.ledger.append({
        type: "file.written",
        node: args.node.id,
        eventId: args.eventId,
        path: artifact.path,
        bytes: artifact.bytes,
        mode: artifact.mode,
        detail: { source: artifact.source }
      });
    }
    if (fileArtifacts.length > 0) {
      await args.emit(
        `\n\n---\n*Wrote ${fileArtifacts.length} file artifact(s):*\n${fileArtifacts
          .map((artifact) => `  -> \`${artifact.path}\``)
          .join("\n")}\n`
      );
    }
    return fileArtifacts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await args.deps.ledger.append({
      type: "file.writeFailed",
      node: args.node.id,
      eventId: args.eventId,
      error: message
    });
    await args.emit(`\n\n**File write failed:** ${message}\n`);
    return [];
  }
}

function parseTriggerTag(userText: string): { type: string; detail: Record<string, string> } {
  const match = userText.match(TRIGGER_TAG_RE);
  return { type: match?.[1] ?? "manual", detail: parseTriggerDetail(match?.[2] ?? "") };
}

function parseTriggerDetail(raw: string): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [key, ...rest] = part.split("=");
    if (!key || rest.length === 0) continue;
    detail[key.trim()] = rest.join("=").trim();
  }
  return detail;
}

function buildSystemMessage(
  node: WorkflowNode,
  inboxRoot: string,
  agentInstructions: string | null
): string {
  const lines: string[] = [];
  lines.push(`You are the **${node.label}** node (id: \`${node.id}\`) in a multi-agent VS Code workflow.`);
  if (node.agent) lines.push(`Selected VS Code custom agent: \`${node.agent}\`.`);
  lines.push("");
  if (agentInstructions?.trim()) {
    lines.push("**Selected agent instructions:**");
    lines.push(agentInstructions.trim());
    lines.push("");
  }
  lines.push("**Node-specific standing instructions:**");
  lines.push(node.context.trim() || "(none - proceed with your best judgment)");
  lines.push("");
  lines.push(
    "**Handoff protocol** - when you want to hand work to another node in this workflow, emit one or more blocks with this exact format anywhere in your response:"
  );
  lines.push("");
  lines.push("```");
  lines.push("<<HANDOFF target=NODE_ID>>");
  lines.push('{ "any": "json", "payload": "here" }');
  lines.push("<<END>>");
  lines.push("```");
  lines.push("");
  lines.push(
    "The orchestrator parses these from your final reply and writes JSON files to that node's inbox at:"
  );
  lines.push("");
  lines.push("```");
  lines.push(`${inboxRoot.replace(/\\/g, "/")}/<TARGET_NODE_ID>/<timestamp>_<id>.json`);
  lines.push("```");
  lines.push("");
  lines.push(
    "If your runtime can write files directly (you have a Bash/file tool), writing the file yourself is also accepted - the orchestrator's FileSystemWatcher picks them up either way."
  );
  lines.push("");
  lines.push(
    "**File write protocol** - if your node needs to create or update a file, emit one or more blocks with this exact format. The extension host will write the file after your response:"
  );
  lines.push("Do not call Copilot file creation or edit tools for this. Use the block format below instead.");
  lines.push("");
  lines.push("```");
  lines.push("<<WRITE_FILE path=relative/or/absolute/path.md>>");
  lines.push("file contents here");
  lines.push("<<END_WRITE_FILE>>");
  lines.push("```");
  return lines.join("\n");
}

function buildUserMessage(
  node: WorkflowNode,
  drained: HandoffPayload[],
  cleanedUserText: string,
  triggerType: string
): string {
  const lines: string[] = [];
  if (triggerType !== "manual") {
    lines.push(`(Triggered by: \`${triggerType}\`.)`);
    lines.push("");
  }
  if (drained.length > 0) {
    lines.push(`**Pending handoffs in your inbox** (${drained.length}):`);
    for (const handoff of drained) {
      lines.push("```json");
      lines.push(JSON.stringify({ from: handoff.from, edgeId: handoff.edgeId, payload: handoff.payload, trace: handoff.trace }, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  if (cleanedUserText) {
    lines.push("**User message:**");
    lines.push(cleanedUserText);
  } else if (drained.length === 0) {
    lines.push(`Run your standing instructions for the **${node.label}** node now.`);
  }
  return lines.join("\n");
}

function normalizeModelSelector(model: ModelSelector | null | undefined): ModelSelector | undefined {
  if (!model) return undefined;
  const selector: ModelSelector = {};
  if (model.vendor?.trim()) selector.vendor = model.vendor.trim();
  if (model.family?.trim()) selector.family = model.family.trim();
  if (model.id?.trim()) selector.id = model.id.trim();
  if (model.version?.trim()) selector.version = model.version.trim();
  if (isModelReasoningEffort(model.reasoningEffort)) selector.reasoningEffort = model.reasoningEffort;
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function isModelReasoningEffort(value: unknown): value is NonNullable<ModelSelector["reasoningEffort"]> {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function parseHandoffs(text: string): OutgoingHandoff[] {
  const out: OutgoingHandoff[] = [];
  let match: RegExpExecArray | null;
  HANDOFF_BLOCK_RE.lastIndex = 0;
  while ((match = HANDOFF_BLOCK_RE.exec(text)) !== null) {
    const target = match[1];
    let body = match[2].trim();
    body = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      out.push({ target, payload: JSON.parse(body) as Record<string, unknown>, source: "spawnedSession" });
    } catch {
      out.push({ target, payload: { _rawText: body, _parseError: true }, source: "spawnedSession" });
    }
  }
  return out;
}

function buildGraphHandoffs(workflow: Workflow | null, node: WorkflowNode, assistantText: string): OutgoingHandoff[] {
  if (!workflow || assistantText.trim().length === 0) return [];
  const targetsById = new Map(workflow.nodes.map((candidate) => [candidate.id, candidate]));
  return workflow.edges
    .filter((edge) => edge.from === node.id)
    .map((edge) => ({ edge, target: targetsById.get(edge.to) }))
    .filter(({ target }) => target?.enabled && target.trigger.type === "handoff")
    .map(({ edge, target }) => ({
      target: edge.to,
      edgeId: edge.id,
      source: "graphEdge" as const,
      payload: {
        fromNode: node.id,
        fromLabel: node.label,
        toNode: target?.id,
        toLabel: target?.label,
        response: assistantText.trim()
      }
    }));
}

function findEdgeId(workflow: Workflow | null, from: string, to: string): string | null {
  if (!workflow) return null;
  return workflow.edges.find((edge) => edge.from === from && edge.to === to)?.id ?? null;
}