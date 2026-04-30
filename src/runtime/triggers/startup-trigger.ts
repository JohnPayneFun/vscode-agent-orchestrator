import type { TriggerStartup, WorkflowNode } from "../../../shared/types.js";
import type { Trigger, TriggerDeps } from "./types.js";

export class StartupTrigger implements Trigger {
  readonly nodeId: string;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerStartup,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    const delayMs = Math.max(0, this.cfg.delaySeconds ?? 3) * 1000;
    this.timeout = setTimeout(() => {
      if (this.disposed) return;
      this.deps.fire(this.node, { delaySeconds: this.cfg.delaySeconds ?? 3 }).catch((err) => {
        this.deps.log(
          `Startup trigger fire for node ${this.node.id} threw: ${err instanceof Error ? err.message : err}`,
          "error"
        );
      });
    }, delayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}