import * as vscode from "vscode";
import type { ModelSelector, Workflow, WorkflowNode } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";
import { formatNodeReference, nodeSuggestions, resolveWorkflowNode } from "../orchestration/node-resolver.js";
import { runWorkflowNode, type RuntimeChatMessage, type RuntimeModelProvider } from "./node-runner.js";

export interface ChatParticipantDeps {
  paths: OrchestrationPaths;
  bus: MessageBus;
  ledger: Ledger;
  getWorkflow: () => Workflow | null;
  getAgentInstructions: (agentId: string) => Promise<string | null>;
}

/**
 * Registers the single static chat participant declared in package.json
 * (`@orchestrator`) and routes its requests to per-node handlers based on the
 * slash command and the first word of the prompt.
 *
 * Conventions:
 *   @orchestrator /list
 *     → lists nodes in the active workflow.
 *   @orchestrator /run <node-label-or-id> [extra prompt text]
 *     → drains the node's inbox, calls request.model.sendRequest with the
 *        node's `context` as the system message, streams the response back to
 *        the chat, then parses any <<HANDOFF target=X>>{...}<<END>> blocks and
 *        routes them to target inboxes (which fires that node's handoff
 *        trigger and the chain continues).
 *   @orchestrator <node-label-or-id> ...
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

      // Both `/run Security ...` and `Security ...` work.
      let rawNodeReference: string;
      let userText: string;
      if (command === "run" || !command) {
        const split = prompt.split(/\s+/);
        rawNodeReference = split[0] ?? "";
        userText = split.slice(1).join(" ").trim();
      } else {
        rawNodeReference = command;
        userText = prompt;
      }

      const workflow = deps.getWorkflow();
      if (!workflow) {
        stream.markdown(
          "No workflow loaded. Open the graph editor with **Agent Orchestrator: Open Graph Editor** first."
        );
        return {};
      }
      const parsedRun = command === "run" || !command ? parseRunPrompt(workflow, prompt) : null;
      const nodeReference = parsedRun?.nodeReference ?? rawNodeReference;
      userText = parsedRun?.userText ?? userText;
      const resolution = resolveWorkflowNode(workflow, nodeReference);
      if (resolution.reason === "ambiguous") {
        stream.markdown(
          `More than one node matches \`${nodeReference}\`: ${resolution.matches
            .map((node) => `\`${formatNodeReference(node)}\` (${node.id})`)
            .join(", ")}. Use a more specific label or the node id.`
        );
        return {};
      }
      const node = resolution.node;
      if (!node) {
        const suggestions = nodeSuggestions(workflow);
        stream.markdown(
          `No node named \`${nodeReference || "(empty)"}\` in the active workflow.${
            suggestions ? ` Try ${suggestions}, or run \`@orchestrator /list\`.` : ""
          }`
        );
        return {};
      }
      if (!node.enabled) {
        stream.markdown(`Node \`${formatNodeReference(node)}\` is disabled. Enable it in the graph editor first.`);
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
      `- **${n.label}** · id: \`${n.id}\`${n.agent ? ` · agent: \`${n.agent}\`` : ""}${
        n.enabled ? "" : " *(disabled)*"
      } · trigger: \`${trig}\`\n`
    );
  }
  stream.markdown(`\nRun a node with \`@orchestrator /run <label>\`. Node ids still work too.`);
  return {};
}

function parseRunPrompt(workflow: Workflow, prompt: string): { nodeReference: string; userText: string } {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  for (let count = words.length; count > 0; count--) {
    const candidate = words.slice(0, count).join(" ");
    if (countExactPromptMatches(workflow, candidate) > 0) {
      return { nodeReference: candidate, userText: words.slice(count).join(" ").trim() };
    }
  }
  return { nodeReference: words[0] ?? "", userText: words.slice(1).join(" ").trim() };
}

function countExactPromptMatches(workflow: Workflow, reference: string): number {
  return workflow.nodes.filter(
    (node) =>
      promptEquals(node.id, reference) ||
      promptEquals(node.label, reference) ||
      (node.agent ? promptEquals(node.agent, reference) : false)
  ).length;
}

function promptEquals(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
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
  const config = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
  try {
    const result = await runWorkflowNode({
      deps: { ...deps, modelProvider: createVsCodeModelProvider(request, stream, token) },
      node,
      userText,
      history: chatHistoryToRuntimeMessages(ctx),
      dryRun: config.get<boolean>("dryRun", false),
      source: "chat",
      spawner: "chat-participant",
      onMarkdown: (markdown) => stream.markdown(markdown)
    });
    return { metadata: { nodeId: result.nodeId, eventId: result.eventId, handoffsEmitted: result.handoffsEmitted } };
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(
        `\n\n**LanguageModelError:** ${err.code} — ${err.message}\n\nCheck that you've selected a model in the chat picker and that you have access (e.g. GitHub Copilot subscription).`
      );
      return { errorDetails: { message: err.message } };
    } else {
      throw err;
    }
  }
}

function chatHistoryToRuntimeMessages(ctx: vscode.ChatContext): RuntimeChatMessage[] {
  const messages: RuntimeChatMessage[] = [];
  for (const turn of ctx.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: "user", content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = chatResponseTurnToText(turn);
      if (text) messages.push({ role: "assistant", content: text });
    }
  }
  return messages;
}

function createVsCodeModelProvider(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): RuntimeModelProvider {
  return {
    async selectModel(selector: ModelSelector | undefined) {
      const model = await selectModel(toLanguageModelSelector(selector), request.model, stream);
      return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        async *sendRequest(messages: RuntimeChatMessage[]) {
          const response = await model.sendRequest(messages.map(toVsCodeMessage), toLanguageModelRequestOptions(selector), token);
          for await (const fragment of response.text) {
            yield fragment;
          }
        }
      };
    }
  };
}

function toVsCodeMessage(message: RuntimeChatMessage): vscode.LanguageModelChatMessage {
  return message.role === "assistant"
    ? vscode.LanguageModelChatMessage.Assistant(message.content)
    : vscode.LanguageModelChatMessage.User(message.content);
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

function toLanguageModelSelector(model: ModelSelector | null | undefined): vscode.LanguageModelChatSelector | undefined {
  if (!model) return undefined;
  const selector: vscode.LanguageModelChatSelector = {};
  if (model.vendor?.trim()) selector.vendor = model.vendor.trim();
  if (model.family?.trim()) selector.family = model.family.trim();
  if (model.id?.trim()) selector.id = model.id.trim();
  if (model.version?.trim()) selector.version = model.version.trim();
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function toLanguageModelRequestOptions(model: ModelSelector | null | undefined): vscode.LanguageModelChatRequestOptions {
  if (!model?.reasoningEffort) return {};
  return { modelOptions: { reasoningEffort: model.reasoningEffort } };
}

async function selectModel(
  selector: vscode.LanguageModelChatSelector | undefined,
  fallback: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream
): Promise<vscode.LanguageModelChat> {
  if (!selector) return fallback;
  try {
    const models = await vscode.lm.selectChatModels(selector);
    if (models.length === 0) {
      stream.markdown(
        `*No chat model matched ${formatModelSelector(selector)}. Using the currently selected model (${fallback.name}).*\n\n`
      );
      return fallback;
    }
    const selected = models[0];
    if (selected.id !== fallback.id) {
      stream.markdown(`*Using node model ${selected.name} (${selected.id}).*\n\n`);
    }
    return selected;
  } catch (err) {
    stream.markdown(
      `*Could not select node model ${formatModelSelector(selector)}: ${err instanceof Error ? err.message : String(err)}. Using the currently selected model (${fallback.name}).*\n\n`
    );
    return fallback;
  }
}

function formatModelSelector(selector: vscode.LanguageModelChatSelector): string {
  const parts = [
    selector.vendor ? `vendor=${selector.vendor}` : "",
    selector.family ? `family=${selector.family}` : "",
    selector.id ? `id=${selector.id}` : "",
    selector.version ? `version=${selector.version}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "the empty selector";
}
