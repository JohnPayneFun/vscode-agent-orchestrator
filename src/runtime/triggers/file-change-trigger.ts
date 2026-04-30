import * as path from "path";
import * as vscode from "vscode";
import type { TriggerFileChange, WorkflowNode } from "../../../shared/types.js";
import type { MessageBus } from "../../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../../orchestration/paths.js";
import type { Trigger, TriggerDeps } from "./types.js";

type FileEventKind = "created" | "changed" | "deleted";

interface PendingFileEvent {
  path: string;
  event: FileEventKind;
}

export class FileChangeTrigger implements Trigger {
  readonly nodeId: string;
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingFiles = new Map<string, PendingFileEvent>();

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerFileChange,
    private readonly p: OrchestrationPaths,
    private readonly bus: MessageBus,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(this.p.workspaceRoot), this.cfg.glob);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    this.watcher.onDidCreate((uri) => this.onFile("created", uri));
    this.watcher.onDidChange((uri) => this.onFile("changed", uri));
    this.watcher.onDidDelete((uri) => this.onFile("deleted", uri));
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

  private onFile(event: FileEventKind, uri: vscode.Uri): void {
    const relativePath = path.relative(this.p.workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    this.pendingFiles.set(relativePath, { path: relativePath, event });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), 500);
  }

  private async flush(): Promise<void> {
    const files = Array.from(this.pendingFiles.values());
    this.pendingFiles.clear();
    if (files.length === 0) return;
    try {
      const payload = this.bus.buildPayload({
        from: "external",
        to: this.node.id,
        edgeId: null,
        trigger: { type: "fileChange", glob: this.cfg.glob, fileCount: files.length },
        payload: { glob: this.cfg.glob, files }
      });
      await this.bus.deliver(payload);
      await this.deps.fire(this.node, { glob: this.cfg.glob, fileCount: files.length });
    } catch (err) {
      this.deps.log(
        `File change trigger fire for node ${this.node.id} threw: ${err instanceof Error ? err.message : err}`,
        "error"
      );
    }
  }
}