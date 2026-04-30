import * as path from "path";
import * as vscode from "vscode";
import type { TriggerDiagnostics, WorkflowNode } from "../../../shared/types.js";
import type { MessageBus } from "../../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../../orchestration/paths.js";
import type { Trigger, TriggerDeps } from "./types.js";

export class DiagnosticsTrigger implements Trigger {
  readonly nodeId: string;
  private disposable: vscode.Disposable | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingUris = new Map<string, vscode.Uri>();
  private readonly globPattern: RegExp;

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerDiagnostics,
    private readonly p: OrchestrationPaths,
    private readonly bus: MessageBus,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
    this.globPattern = compileGlob(cfg.glob);
  }

  start(): void {
    this.disposable = vscode.languages.onDidChangeDiagnostics((event) => {
      this.queue(event.uris);
    });
  }

  dispose(): void {
    if (this.disposable) {
      this.disposable.dispose();
      this.disposable = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingUris.clear();
  }

  private queue(uris: readonly vscode.Uri[]): void {
    for (const uri of uris) {
      if (uri.scheme !== "file") continue;
      const relativePath = path.relative(this.p.workspaceRoot, uri.fsPath).replace(/\\/g, "/");
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      if (!this.globPattern.test(relativePath)) continue;
      this.pendingUris.set(uri.fsPath, uri);
    }
    if (this.pendingUris.size === 0) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.cfg.debounceMs ?? 1000);
  }

  private async flush(): Promise<void> {
    const uris = Array.from(this.pendingUris.values());
    this.pendingUris.clear();
    const files = uris
      .map((uri) => ({ uri, path: path.relative(this.p.workspaceRoot, uri.fsPath).replace(/\\/g, "/") }))
      .map(({ uri, path: relativePath }) => ({
        path: relativePath,
        diagnostics: vscode.languages
          .getDiagnostics(uri)
          .filter((diagnostic) => severityMatches(diagnostic.severity, this.cfg.severity))
          .slice(0, 20)
          .map((diagnostic) => ({
            severity: severityLabel(diagnostic.severity),
            message: diagnostic.message,
            source: diagnostic.source,
            code: typeof diagnostic.code === "object" ? String(diagnostic.code.value) : diagnostic.code,
            range: {
              startLine: diagnostic.range.start.line + 1,
              startCharacter: diagnostic.range.start.character + 1,
              endLine: diagnostic.range.end.line + 1,
              endCharacter: diagnostic.range.end.character + 1
            }
          }))
      }))
      .filter((file) => file.diagnostics.length > 0)
      .slice(0, 25);

    const diagnosticCount = files.reduce((total, file) => total + file.diagnostics.length, 0);
    if (diagnosticCount === 0) return;

    try {
      const payload = this.bus.buildPayload({
        from: "external",
        to: this.node.id,
        edgeId: null,
        trigger: {
          type: "diagnostics",
          glob: this.cfg.glob,
          severity: this.cfg.severity,
          fileCount: files.length,
          diagnosticCount
        },
        payload: { glob: this.cfg.glob, severity: this.cfg.severity, files }
      });
      await this.bus.deliver(payload);
      await this.deps.fire(this.node, { fileCount: files.length, diagnosticCount, severity: this.cfg.severity });
    } catch (err) {
      this.deps.log(
        `Diagnostics trigger fire for node ${this.node.id} threw: ${err instanceof Error ? err.message : err}`,
        "error"
      );
    }
  }
}

function severityMatches(actual: vscode.DiagnosticSeverity, configured: TriggerDiagnostics["severity"]): boolean {
  if (configured === "any") return true;
  return severityLabel(actual) === configured;
}

function severityLabel(severity: vscode.DiagnosticSeverity): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
    default:
      return "hint";
  }
}

function compileGlob(glob: string): RegExp {
  const normalized = glob.trim().replace(/\\/g, "/") || "**/*";
  let pattern = "^";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(char);
    }
  }
  return new RegExp(`${pattern}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}