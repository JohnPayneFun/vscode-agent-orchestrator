import * as vscode from "vscode";
import type { ModelSelector, Workflow, WorkflowNode } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";
import { formatNodeReference, nodeSuggestions, resolveWorkflowNode } from "../orchestration/node-resolver.js";
import { runWorkflowNode, WorkflowNodeRunError, type RuntimeChatMessage, type RuntimeModelProvider } from "./node-runner.js";
import { retryQuery, scheduleRetryChat } from "./retry-chat.js";
import { saveRetryState } from "./retry-state.js";
import { DEFAULT_BLOCKED_TOOL_NAMES, exposedTools } from "./tool-filter.js";
import { parseUsageLimitRetry } from "./usage-limit.js";

const DEFAULT_TOOL_ROUND_LIMIT = 16;
const MIN_TOOL_ROUND_LIMIT = 1;
const MAX_TOOL_ROUND_LIMIT = 50;
const REPEATED_TOOL_FAILURE_LIMIT = 2;

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

      return await runNode({ context, deps, node, request, ctx, stream, token, userText });
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
  context: vscode.ExtensionContext;
  deps: ChatParticipantDeps;
  node: WorkflowNode;
  request: vscode.ChatRequest;
  ctx: vscode.ChatContext;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  userText: string;
}

async function runNode(args: RunArgs): Promise<vscode.ChatResult> {
  const { context, deps, node, request, ctx, stream, token, userText } = args;
  const config = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
  const toolRoundLimit = clampToolRoundLimit(config.get<number>("toolRoundLimit", DEFAULT_TOOL_ROUND_LIMIT));
  const blockedTools = config.get<string[]>("blockedTools", [...DEFAULT_BLOCKED_TOOL_NAMES]);
  try {
    const result = await runWorkflowNode({
      deps: { ...deps, modelProvider: createVsCodeModelProvider(request, stream, token, toolRoundLimit, blockedTools) },
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
    const scheduledRetry = await scheduleUsageLimitRetry({ context, deps, node, err, stream });
    if (scheduledRetry) return { metadata: { nodeId: node.id, retryId: scheduledRetry.retryId, retryAt: scheduledRetry.retryAt } };
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

async function scheduleUsageLimitRetry(args: {
  context: vscode.ExtensionContext;
  deps: ChatParticipantDeps;
  node: WorkflowNode;
  err: unknown;
  stream: vscode.ChatResponseStream;
}): Promise<{ retryId: string; retryAt: string } | null> {
  const message = errorMessage(args.err);
  const retry = parseUsageLimitRetry(message);
  if (!retry) return null;

  const runError = args.err instanceof WorkflowNodeRunError ? args.err : null;
  const retryState = await saveRetryState(args.deps.paths, {
    retryAt: retry.retryAt,
    nodeId: args.node.id,
    triggerType: runError?.triggerType ?? "manual",
    userText: runError?.cleanedUserText ?? "",
    drainedHandoffs: runError?.drainedHandoffs ?? [],
    reason: message
  });
  scheduleRetryChat(args.context, retryQuery(args.node.id, retryState.id), retry.retryDelayMs);

  await args.deps.ledger.append({
    type: "retry.scheduled",
    node: args.node.id,
    eventId: runError?.eventId,
    detail: {
      retryId: retryState.id,
      retryAt: retry.retryAt,
      waitMs: retry.waitMs,
      retryDelayMs: retry.retryDelayMs,
      matchedText: retry.matchedText,
      drainedHandoffs: retryState.drainedHandoffs.length
    }
  });
  args.stream.markdown(
    `\n\n**Usage limit hit.** Scheduled \`${formatNodeReference(args.node)}\` to retry at ${new Date(retry.retryAt).toLocaleString()} after ${formatRetryDelay(retry.retryDelayMs)}.\n`
  );
  return { retryId: retryState.id, retryAt: retry.retryAt };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatRetryDelay(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} minute(s)`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours} hour(s) ${remainder} minute(s)` : `${hours} hour(s)`;
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
  token: vscode.CancellationToken,
  toolRoundLimit: number,
  blockedTools: readonly string[]
): RuntimeModelProvider {
  return {
    async selectModel(selector: ModelSelector | undefined) {
      const model = await selectModel(toLanguageModelSelector(selector), request.model, stream);
      return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        async countTokens(input: RuntimeChatMessage[] | string): Promise<number> {
          if (typeof input === "string") return model.countTokens(input, token);
          const counts = await Promise.all(input.map((message) => model.countTokens(toVsCodeMessage(message), token)));
          return counts.reduce((sum, count) => sum + count, 0);
        },
        async *sendRequest(messages: RuntimeChatMessage[]) {
          const requestMessages = messages.map(toVsCodeMessage);
          const tools = exposedTools(vscode.lm.tools, blockedTools).map(toLanguageModelChatTool);
          const failedToolCalls = new Map<string, number>();
          for (let round = 0; round < toolRoundLimit; round++) {
            const response = await model.sendRequest(
              requestMessages,
              toLanguageModelRequestOptions(selector, tools),
              token
            );
            const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            for await (const part of response.stream) {
              if (part instanceof vscode.LanguageModelTextPart) {
                assistantParts.push(part);
                yield part.value;
              } else if (part instanceof vscode.LanguageModelToolCallPart) {
                assistantParts.push(part);
                toolCalls.push(part);
              }
            }
            if (toolCalls.length === 0) return;
            requestMessages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
            const toolResults: vscode.LanguageModelToolResultPart[] = [];
            for (const toolCall of toolCalls) {
              stream.progress(`Running tool ${toolCall.name}...`);
              const outcome = await invokeToolResultPart(toolCall, request, token, stream);
              if (outcome.failureSignature) {
                const failureCount = (failedToolCalls.get(outcome.failureSignature) ?? 0) + 1;
                failedToolCalls.set(outcome.failureSignature, failureCount);
                if (failureCount >= REPEATED_TOOL_FAILURE_LIMIT) {
                  throw new Error(
                    `${outcome.message} The same tool call failed ${failureCount} time(s), so the run was stopped to avoid a retry loop.`
                  );
                }
              }
              toolResults.push(outcome.resultPart);
            }
            requestMessages.push(vscode.LanguageModelChatMessage.User(toolResults));
          }
          throw new Error(
            `Stopped after ${toolRoundLimit} tool round(s). The model kept requesting tools, so the run did not complete.`
          );
        }
      };
    }
  };
}

interface ToolInvocationOutcome {
  resultPart: vscode.LanguageModelToolResultPart;
  failureSignature?: string;
  message?: string;
}

function clampToolRoundLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TOOL_ROUND_LIMIT;
  return Math.max(MIN_TOOL_ROUND_LIMIT, Math.min(MAX_TOOL_ROUND_LIMIT, Math.floor(value)));
}

async function invokeToolResultPart(
  toolCall: vscode.LanguageModelToolCallPart,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream
): Promise<ToolInvocationOutcome> {
  try {
    const result = await vscode.lm.invokeTool(
      toolCall.name,
      { input: toolCall.input, toolInvocationToken: request.toolInvocationToken },
      token
    );
    return { resultPart: new vscode.LanguageModelToolResultPart(toolCall.callId, result.content) };
  } catch (err) {
    const message = toolErrorMessage(toolCall.name, err);
    stream.progress(message);
    return {
      resultPart: new vscode.LanguageModelToolResultPart(toolCall.callId, [new vscode.LanguageModelTextPart(message)]),
      failureSignature: `${toolCall.name}:${stableStringify(toolCall.input)}:${message}`,
      message
    };
  }
}

function toolErrorMessage(toolName: string, err: unknown): string {
  return `Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return String(value);
  }
}

function sortJsonValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJsonValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)])
  );
}

function toLanguageModelChatTool(tool: vscode.LanguageModelToolInformation): vscode.LanguageModelChatTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
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

function toLanguageModelRequestOptions(
  model: ModelSelector | null | undefined,
  tools: vscode.LanguageModelChatTool[]
): vscode.LanguageModelChatRequestOptions {
  const options: vscode.LanguageModelChatRequestOptions = {};
  if (model?.reasoningEffort) options.modelOptions = { reasoningEffort: model.reasoningEffort };
  if (tools.length > 0) {
    options.tools = tools;
    options.toolMode = vscode.LanguageModelChatToolMode.Auto;
  }
  return options;
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
