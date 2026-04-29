import * as vscode from "vscode";
import * as path from "path";
import type { WorkflowNode } from "../../../shared/types.js";
import type { OrchestrationPaths } from "../../orchestration/paths.js";
import { inboxDir } from "../../orchestration/paths.js";
import type { Trigger, TriggerDeps } from "./types.js";

export class HandoffTrigger implements Trigger {
  readonly nodeId: string;
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingFiles = new Set<string>();

  constructor(
    private readonly node: WorkflowNode,
    private readonly p: OrchestrationPaths,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    const dir = inboxDir(this.p, this.node.id);
    // VS Code's FileSystemWatcher accepts a RelativePattern relative to a folder
    // — point it at the inbox dir and watch all .json children.
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), "*.json");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, true);
    this.watcher.onDidCreate((uri) => this.onFile(uri.fsPath));
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingFiles.clear();
  }

  private onFile(filePath: string): void {
    this.pendingFiles.add(path.basename(filePath));
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const count = this.pendingFiles.size;
      this.pendingFiles.clear();
      this.deps.fire(this.node, { handoffFiles: count }).catch((err) => {
        this.deps.log(
          `Handoff trigger fire for node ${this.node.id} threw: ${err instanceof Error ? err.message : err}`,
          "error"
        );
      });
    }, 500);
  }
}
