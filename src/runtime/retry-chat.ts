import * as vscode from "vscode";

const CHAT_PARTICIPANT_NAME = "@orchestrator";

export function retryQuery(nodeId: string, retryId: string): string {
  return `${CHAT_PARTICIPANT_NAME} /run ${nodeId} [triggered:manual:retryId=${retryId},usageLimitRetry=1]`;
}

export function scheduleRetryChat(context: vscode.ExtensionContext, query: string, delayMs: number): void {
  const timeout = setTimeout(() => {
    void openRetryChat(query);
  }, Math.max(0, delayMs));
  context.subscriptions.push({ dispose: () => clearTimeout(timeout) });
}

async function openRetryChat(query: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", { query });
  } catch {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open");
    } catch {
      // Best effort fallback below still copies the query for manual paste.
    }
    try {
      await vscode.env.clipboard.writeText(query);
    } catch {
      // Nothing else to do if clipboard access fails.
    }
    vscode.window.showWarningMessage("Agent Orchestrator: usage-limit retry is ready. The retry query was copied to the clipboard.");
  }
}
