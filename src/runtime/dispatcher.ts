import * as vscode from "vscode";
import type { Workflow, WorkflowNode, TriggerType } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";
import { createVsCodeModelProvider, resolveToolRoundLimit } from "./chat-participant.js";
import { scheduledDispatchDownstreamState } from "./downstream-state.js";
import { runWorkflowNode, WorkflowNodeRunError } from "./node-runner.js";
import { saveRetryState } from "./retry-state.js";
import { DEFAULT_BLOCKED_TOOL_NAMES } from "./tool-filter.js";
import { parseUsageLimitRetry } from "./usage-limit.js";

export interface DispatchContext {
  reason: TriggerType;
  triggerDetail?: Record<string, unknown>;
  rootEventId?: string;
}

export interface DispatcherDeps {
  ledger: Ledger;
  paths: OrchestrationPaths;
  bus: MessageBus;
  getWorkflow: () => Workflow | null;
  getAgentInstructions: (agentId: string) => Promise<string | null>;
}

const CHAT_PARTICIPANT_NAME = "@orchestrator";
const DEFAULT_TOOL_ROUND_LIMIT = 64;
const TOOL_ROUND_LIMIT_RE = /tool round limit|Stopped after \d+ tool round/i;

/**
 * Dispatches trigger/graph work to a node. By default this runs inside the
 * extension host via VS Code's Language Model API instead of opening chat UI,
 * so multiple nodes can run independently up to the workflow concurrency cap.
 * The old chat-opening path remains available via configuration for debugging.
 */
export class Dispatcher {
  private inFlight = 0;

  constructor(private readonly deps: DispatcherDeps) {}

  async fireNode(node: WorkflowNode, ctx: DispatchContext): Promise<void> {
    const config = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
    if (!config.get<boolean>("enabled", true)) {
      await this.deps.ledger.append({
        type: "guardrail.tripped",
        rule: "globally-disabled",
        node: node.id,
        eventId: ctx.rootEventId
      });
      return;
    }

    const wf = this.deps.getWorkflow();
    if (wf) {
      const downstreamState = scheduledDispatchDownstreamState(wf, node, ctx.reason, await this.deps.ledger.tail(1000));
      if (downstreamState.busy) {
        await this.deps.ledger.append({
          type: "guardrail.tripped",
          rule: "downstream-running",
          node: node.id,
          trigger: ctx.reason,
          eventId: ctx.rootEventId,
          detail: {
            action: "deferred-to-next-tick",
            downstream: downstreamState.downstream.filter((target) => target.status === "running")
          }
        });
        return;
      }
    }

    if (wf && this.inFlight >= wf.settings.concurrencyLimit) {
      await this.deps.ledger.append({
        type: "guardrail.tripped",
        rule: "concurrencyLimit",
        node: node.id,
        limit: wf.settings.concurrencyLimit,
        eventId: ctx.rootEventId
      });
      return;
    }

    if (wf) {
      const today = await this.deps.ledger.countToday("session.spawned");
      if (today >= wf.settings.dailyHandoffCap) {
        await this.deps.ledger.append({
          type: "guardrail.tripped",
          rule: "dailyHandoffCap",
          limit: wf.settings.dailyHandoffCap,
          current: today,
          action: "halted",
          eventId: ctx.rootEventId
        });
        vscode.window.showWarningMessage(
          `Agent Orchestrator: daily spawn cap (${wf.settings.dailyHandoffCap}) reached. Edit workflows.json or use Emergency Stop.`
        );
        return;
      }
    }

    const dryRun = config.get<boolean>("dryRun", false);
    if (!dryRun && config.get<"background" | "chat">("dispatchMode", "background") === "chat") {
      await this.openNodeChat(node, ctx);
      return;
    }

    await this.runNodeInBackground(node, ctx, dryRun);
  }

  private async runNodeInBackground(node: WorkflowNode, ctx: DispatchContext, dryRun: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
    const tokenSource = new vscode.CancellationTokenSource();
    const toolRoundLimit = resolveToolRoundLimit(
      node.toolRoundLimit,
      config.get<number>("toolRoundLimit", DEFAULT_TOOL_ROUND_LIMIT)
    );
    const blockedTools = config.get<string[]>("blockedTools", [...DEFAULT_BLOCKED_TOOL_NAMES]);

    this.inFlight++;
    try {
      await runWorkflowNode({
        deps: {
          paths: this.deps.paths,
          bus: this.deps.bus,
          ledger: this.deps.ledger,
          getWorkflow: this.deps.getWorkflow,
          getAgentInstructions: this.deps.getAgentInstructions,
          modelProvider: createVsCodeModelProvider({
            token: tokenSource.token,
            toolRoundLimit,
            blockedTools
          })
        },
        node,
        userText: formatTriggerTag(ctx),
        dryRun,
        source: "dispatcher",
        spawner: "extension-host"
      });
    } catch (err) {
      await this.handleBackgroundRunError(node, err);
    } finally {
      tokenSource.dispose();
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async handleBackgroundRunError(node: WorkflowNode, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const runError = err instanceof WorkflowNodeRunError ? err : null;
    const usageRetry = parseUsageLimitRetry(message);
    if (usageRetry) {
      const retryState = await saveRetryState(this.deps.paths, {
        retryKind: "usageLimit",
        retryAt: usageRetry.retryAt,
        nodeId: node.id,
        triggerType: runError?.triggerType ?? "manual",
        userText: runError?.cleanedUserText ?? "",
        drainedHandoffs: runError?.drainedHandoffs ?? [],
        reason: message
      });
      await this.deps.ledger.append({
        type: "retry.scheduled",
        node: node.id,
        eventId: runError?.eventId,
        detail: {
          retryId: retryState.id,
          retryAt: usageRetry.retryAt,
          waitMs: usageRetry.waitMs,
          retryDelayMs: usageRetry.retryDelayMs,
          matchedText: usageRetry.matchedText,
          background: true,
          drainedHandoffs: retryState.drainedHandoffs.length
        }
      });
      setTimeout(() => {
        void this.fireNode(node, {
          reason: "manual",
          triggerDetail: { retryId: retryState.id, usageLimitRetry: 1 }
        });
      }, usageRetry.retryDelayMs);
      return;
    }

    if (TOOL_ROUND_LIMIT_RE.test(message)) {
      const retryAt = new Date().toISOString();
      const retryState = await saveRetryState(this.deps.paths, {
        retryKind: "toolRoundLimit",
        retryAt,
        nodeId: node.id,
        triggerType: runError?.triggerType ?? "manual",
        userText: runError?.cleanedUserText ?? "",
        drainedHandoffs: runError?.drainedHandoffs ?? [],
        reason: message
      });
      await this.deps.ledger.append({
        type: "retry.scheduled",
        node: node.id,
        eventId: runError?.eventId,
        detail: {
          retryId: retryState.id,
          retryAt,
          retryKind: retryState.retryKind,
          manualResume: true,
          background: true,
          drainedHandoffs: retryState.drainedHandoffs.length,
          reason: message
        }
      });
    }
  }

  private async openNodeChat(node: WorkflowNode, ctx: DispatchContext): Promise<void> {
    const triggerTag = formatTriggerTag(ctx);
    const query = `${CHAT_PARTICIPANT_NAME} /run ${node.id} ${triggerTag}`;

    this.inFlight++;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    } catch (err) {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open");
        await vscode.env.clipboard.writeText(query);
        vscode.window.showInformationMessage(
          `Agent Orchestrator: trigger fired but the chat command refused a prefilled query. Query was copied to your clipboard. Underlying error: ${err instanceof Error ? err.message : err}`
        );
      } catch {
        vscode.window.showErrorMessage(
          `Agent Orchestrator: failed to open chat for ${node.id}. Make sure VS Code's chat view is available.`
        );
      }
    } finally {
      setTimeout(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
      }, 5000);
    }
  }
}

function formatTriggerTag(ctx: DispatchContext): string {
  const detailParts: string[] = [];
  if (ctx.triggerDetail) {
    for (const [key, value] of Object.entries(ctx.triggerDetail)) {
      if (typeof value === "string" || typeof value === "number") detailParts.push(`${key}=${value}`);
    }
  }
  const detail = detailParts.length > 0 ? `:${detailParts.join(",")}` : "";
  return `[triggered:${ctx.reason}${detail}]`;
}
