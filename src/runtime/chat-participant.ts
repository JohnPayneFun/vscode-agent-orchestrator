import * as vscode from "vscode";
import { ulid } from "ulid";
import type { Workflow, WorkflowNode, HandoffPayload } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";

const TRIGGER_TAG_RE = /\[triggered:(\w+)(?::([^\]]+))?\]/;
const HANDOFF_BLOCK_RE = /<<HANDOFF\s+target=([a-zA-Z0-9_-]+)>>([\s\S]*?)<<END>>/g;

export interface ChatParticipantDeps {
  paths: OrchestrationPaths;
  bus: MessageBus;
  ledger: Ledger;
  getWorkflow: () => Workflow | null;
}

/**
 * Registers the single static chat participant declared in package.json
 * (`@orchestrator`) and routes its requests to per-node handlers based on the
 * slash command and the first word of the prompt.
 *
 * Conventions:
 *   @orchestrator /list
 *     → lists nodes in the active workflow.
 *   @orchestrator /run <node-id> [extra prompt text]
 *     → drains <node-id>'s inbox, calls request.model.sendRequest with the
 *        node's `context` as the system message, streams the response back to
 *        the chat, then parses any <<HANDOFF target=X>>{...}<<END>> blocks and
 *        routes them to target inboxes (which fires that node's handoff
 *        trigger and the chain continues).
 *   @orchestrator <node-id> ...
 *     → equivalent to /run <node-id> ... (slash command optional).
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  deps: ChatParticipantDeps
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (request, ctx, stream, token) => {
    try {
      const command = request.command;
      const prompt = (request.prompt ?? "").trim();

      if (command === "list" || (!command && prompt === "")) {
        return listNodes(deps, stream);
      }

      // Both `/run sec ...` and `sec ...` work.
      let nodeId: string;
      let userText: string;
      if (command === "run" || !command) {
        const split = prompt.split(/\s+/);
        nodeId = split[0] ?? "";
        userText = split.slice(1).join(" ").trim();
      } else {
        nodeId = command;
        userText = prompt;
      }

      const workflow = deps.getWorkflow();
      if (!workflow) {
        stream.markdown(
          "No workflow loaded. Open the graph editor with **Agent Orchestrator: Open Graph Editor** first."
        );
        return {};
      }
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (!node) {
        stream.markdown(
          `No node with id \`${nodeId || "(empty)"}\` in the active workflow. Try \`@orchestrator /list\`.`
        );
        return {};
      }
      if (!node.enabled) {
        stream.markdown(`Node \`${nodeId}\` is disabled. Enable it in the graph editor first.`);
        return {};
      }

      return await runNode({ deps, node, request, ctx, stream, token, userText });
    } catch (err) {
      stream.markdown(
        `**Orchestrator error:** ${err instanceof Error ? err.message : String(err)}`
      );
      await deps.ledger.append({
        type: "session.errored",
        error: err instanceof Error ? err.message : String(err)
      });
      return { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
    }
  };

  const participant = vscode.chat.createChatParticipant("vscode-agent-orchestrator.main", handler);
  participant.iconPath = new vscode.ThemeIcon("organization");
  context.subscriptions.push(participant);
  return participant;
}

function listNodes(deps: ChatParticipantDeps, stream: vscode.ChatResponseStream): vscode.ChatResult {
  const wf = deps.getWorkflow();
  if (!wf || wf.nodes.length === 0) {
    stream.markdown("No nodes defined. Open the graph editor and create one.");
    return {};
  }
  stream.markdown(`**Workflow: ${wf.name}** (${wf.nodes.length} nodes)\n\n`);
  for (const n of wf.nodes) {
    const trig = n.trigger.type;
    stream.markdown(
      `- **\`${n.id}\`** — ${n.label}${n.enabled ? "" : " *(disabled)*"} · trigger: \`${trig}\`\n`
    );
  }
  stream.markdown(`\nRun a node with \`@orchestrator /run <id>\`.`);
  return {};
}

interface RunArgs {
  deps: ChatParticipantDeps;
  node: WorkflowNode;
  request: vscode.ChatRequest;
  ctx: vscode.ChatContext;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  userText: string;
}

async function runNode(args: RunArgs): Promise<vscode.ChatResult> {
  const { deps, node, request, ctx, stream, token, userText } = args;
  const eventId = ulid();

  const triggerMatch = userText.match(TRIGGER_TAG_RE);
  const triggerType = triggerMatch?.[1] ?? "manual";
  const cleanedUserText = userText.replace(TRIGGER_TAG_RE, "").trim();

  const drained = await deps.bus.drain(node.id);

  await deps.ledger.append({
    type: "trigger.fired",
    eventId,
    node: node.id,
    trigger: triggerType as never,
    detail: { source: "chat", drainedHandoffs: drained.length }
  });

  // System message: persona definition. VS Code's stable LM API doesn't expose
  // a System role — convention is to put it as the first User message.
  const systemContent = buildSystemMessage(node, deps.paths.inboxRoot);
  const userContent = buildUserMessage(node, drained, cleanedUserText, triggerType);

  const messages: vscode.LanguageModelChatMessage[] = [];
  messages.push(vscode.LanguageModelChatMessage.User(systemContent));

  // Replay prior turns in this thread so multi-turn within one chat works.
  for (const turn of ctx.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = chatResponseTurnToText(turn);
      if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
    }
  }
  messages.push(vscode.LanguageModelChatMessage.User(userContent));

  if (drained.length > 0) {
    stream.markdown(`*Drained ${drained.length} pending handoff(s) from inbox.*\n\n`);
  }

  const config = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
  if (config.get<boolean>("dryRun", false)) {
    stream.markdown("`dryRun` is enabled — skipping the model call.");
    await deps.ledger.append({
      type: "session.spawned",
      node: node.id,
      eventId,
      dryRun: true,
      promptLength: systemContent.length + userContent.length
    });
    return { metadata: { nodeId: node.id, eventId } };
  }

  let assistantText = "";
  try {
    const response = await request.model.sendRequest(messages, {}, token);
    for await (const fragment of response.text) {
      assistantText += fragment;
      stream.markdown(fragment);
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(
        `\n\n**LanguageModelError:** ${err.code} — ${err.message}\n\nCheck that you've selected a model in the chat picker and that you have access (e.g. GitHub Copilot subscription).`
      );
    } else {
      throw err;
    }
    await deps.ledger.append({
      type: "session.errored",
      node: node.id,
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
  }

  await deps.ledger.append({
    type: "session.spawned",
    node: node.id,
    eventId,
    spawner: "chat-participant",
    model: request.model.id,
    promptLength: systemContent.length + userContent.length,
    responseLength: assistantText.length,
    drainedHandoffs: drained.length
  });

  // Parse outgoing handoffs and route them.
  const handoffs = parseHandoffs(assistantText);
  if (handoffs.length > 0) {
    stream.markdown(`\n\n---\n*Routing ${handoffs.length} outgoing handoff(s)...*\n`);
    for (const h of handoffs) {
      const payload = deps.bus.buildPayload({
        from: node.id,
        to: h.target,
        edgeId: findEdgeId(deps.getWorkflow(), node.id, h.target),
        trigger: { type: "spawnedSession", source: "chat-participant" },
        payload: h.payload,
        rootId: drained[0]?.trace.rootId ?? eventId,
        depth: (drained[0]?.trace.depth ?? 0) + 1,
        parentId: drained[0]?.id
      });
      const { inboxPath, outboxPath } = await deps.bus.deliver(payload);
      await deps.ledger.append({
        type: "handoff.emitted",
        eventId,
        from: node.id,
        to: h.target,
        handoffId: payload.id,
        payloadBytes: JSON.stringify(payload).length,
        outboxPath
      });
      await deps.ledger.append({
        type: "handoff.delivered",
        eventId,
        to: h.target,
        handoffId: payload.id,
        inboxPath
      });
      stream.markdown(`  → \`${h.target}\` (id ${payload.id})\n`);
    }
  }

  return { metadata: { nodeId: node.id, eventId, handoffsEmitted: handoffs.length } };
}

function buildSystemMessage(node: WorkflowNode, inboxRoot: string): string {
  const lines: string[] = [];
  lines.push(`You are the **${node.label}** node (id: \`${node.id}\`) in a multi-agent VS Code workflow.`);
  if (node.agent) lines.push(`Agent identifier: \`${node.agent}\` (free-form label).`);
  lines.push("");
  lines.push("**Standing instructions for this node:**");
  lines.push(node.context.trim() || "(none — proceed with your best judgment)");
  lines.push("");
  lines.push(
    "**Handoff protocol** — when you want to hand work to another node in this workflow, emit one or more blocks with this exact format anywhere in your response:"
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
    "If your runtime can write files directly (you have a Bash/file tool), writing the file yourself is also accepted — the orchestrator's FileSystemWatcher picks them up either way."
  );
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
    for (const h of drained) {
      lines.push("```json");
      lines.push(JSON.stringify({ from: h.from, edgeId: h.edgeId, payload: h.payload, trace: h.trace }, null, 2));
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

function chatResponseTurnToText(turn: vscode.ChatResponseTurn): string {
  const parts: string[] = [];
  for (const r of turn.response) {
    if (r instanceof vscode.ChatResponseMarkdownPart) {
      parts.push(typeof r.value === "string" ? r.value : r.value.value);
    }
  }
  return parts.join("");
}

function parseHandoffs(text: string): Array<{ target: string; payload: Record<string, unknown> }> {
  const out: Array<{ target: string; payload: Record<string, unknown> }> = [];
  let m: RegExpExecArray | null;
  HANDOFF_BLOCK_RE.lastIndex = 0;
  while ((m = HANDOFF_BLOCK_RE.exec(text)) !== null) {
    const target = m[1];
    let body = m[2].trim();
    body = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      out.push({ target, payload: JSON.parse(body) });
    } catch {
      out.push({ target, payload: { _rawText: body, _parseError: true } });
    }
  }
  return out;
}

function findEdgeId(workflow: Workflow | null, from: string, to: string): string | null {
  if (!workflow) return null;
  return workflow.edges.find((e) => e.from === from && e.to === to)?.id ?? null;
}
