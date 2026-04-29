import * as vscode from "vscode";
import type { Workflow, WorkflowNode, TriggerType } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";

export interface DispatchContext {
  reason: TriggerType;
  triggerDetail?: Record<string, unknown>;
  rootEventId?: string;
}

const CHAT_PARTICIPANT_NAME = "@orchestrator";

/**
 * Dispatches work to a node by opening a fresh native VS Code chat targeted
 * at our chat participant. The participant's handler does the actual LLM call
 * — see `chat-participant.ts`.
 *
 * This separation keeps the trigger watchers free of any LLM concerns and
 * means that human-initiated invocations (`@orchestrator /run sec ...` typed
 * in chat) and trigger-initiated invocations go through the *exact same*
 * code path.
 */
export class Dispatcher {
  private inFlight = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly getWorkflow: () => Workflow | null
  ) {}

  async fireNode(node: WorkflowNode, ctx: DispatchContext): Promise<void> {
    const config = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
    if (!config.get<boolean>("enabled", true)) {
      await this.ledger.append({
        type: "guardrail.tripped",
        rule: "globally-disabled",
        node: node.id,
        eventId: ctx.rootEventId
      });
      return;
    }

    const wf = this.getWorkflow();
    if (wf && this.inFlight >= wf.settings.concurrencyLimit) {
      await this.ledger.append({
        type: "guardrail.tripped",
        rule: "concurrencyLimit",
        node: node.id,
        limit: wf.settings.concurrencyLimit,
        eventId: ctx.rootEventId
      });
      return;
    }

    if (wf) {
      const today = await this.ledger.countToday("session.spawned");
      if (today >= wf.settings.dailyHandoffCap) {
        await this.ledger.append({
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

    if (config.get<boolean>("dryRun", false)) {
      await this.ledger.append({
        type: "trigger.fired",
        node: node.id,
        trigger: ctx.reason,
        detail: { ...ctx.triggerDetail, dryRun: true },
        eventId: ctx.rootEventId
      });
      return;
    }

    const triggerTag = formatTriggerTag(ctx);
    const query = `${CHAT_PARTICIPANT_NAME} /run ${node.id} ${triggerTag}`;

    this.inFlight++;
    try {
      // `workbench.action.chat.open` accepts an options object; the `query`
      // field prefills the input. This opens a new chat thread bound to our
      // participant.
      await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    } catch (err) {
      // If the structured-options form isn't supported, fall back to opening
      // the chat panel and copying the query to the clipboard so the user can
      // paste it (very degraded but recoverable).
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open");
        await vscode.env.clipboard.writeText(query);
        vscode.window.showInformationMessage(
          `Agent Orchestrator: trigger fired but the chat command refused a prefilled query. Query was copied to your clipboard — paste it into the chat input. Underlying error: ${err instanceof Error ? err.message : err}`
        );
      } catch {
        vscode.window.showErrorMessage(
          `Agent Orchestrator: failed to open chat for ${node.id}. Make sure VS Code's chat view is available.`
        );
      }
    } finally {
      // The dispatcher doesn't observe when the participant finishes;
      // release the slot so the next trigger can fire after a short delay.
      setTimeout(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
      }, 5000);
    }
  }
}

function formatTriggerTag(ctx: DispatchContext): string {
  const detailParts: string[] = [];
  if (ctx.triggerDetail) {
    for (const [k, v] of Object.entries(ctx.triggerDetail)) {
      if (typeof v === "string" || typeof v === "number") detailParts.push(`${k}=${v}`);
    }
  }
  const detail = detailParts.length > 0 ? `:${detailParts.join(",")}` : "";
  return `[triggered:${ctx.reason}${detail}]`;
}
