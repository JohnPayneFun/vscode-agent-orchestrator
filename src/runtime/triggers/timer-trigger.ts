import parser from "cron-parser";
import type { WorkflowNode, TriggerTimer } from "../../../shared/types.js";
import type { Trigger, TriggerDeps } from "./types.js";

export class TimerTrigger implements Trigger {
  readonly nodeId: string;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerTimer,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    this.scheduleNext();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    let nextMs: number;
    try {
      const interval = parser.parseExpression(this.cfg.cron, {
        tz: this.cfg.tz === "utc" ? "UTC" : undefined
      });
      const next = interval.next().toDate();
      nextMs = Math.max(1000, next.getTime() - Date.now());
    } catch (err) {
      this.deps.log(
        `Timer trigger for node ${this.node.id}: invalid cron "${this.cfg.cron}" (${err instanceof Error ? err.message : err}). Will retry in 5 min.`,
        "error"
      );
      nextMs = 5 * 60 * 1000;
    }
    this.timeout = setTimeout(async () => {
      if (this.disposed) return;
      try {
        await this.deps.fire(this.node, { cron: this.cfg.cron });
      } catch (err) {
        this.deps.log(
          `Timer trigger fire for node ${this.node.id} threw: ${err instanceof Error ? err.message : err}`,
          "error"
        );
      } finally {
        this.scheduleNext();
      }
    }, nextMs);
  }
}
