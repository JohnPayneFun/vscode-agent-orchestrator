import type { TriggerInterval, WorkflowNode } from "../../../shared/types.js";
import { intervalToMs, nextIntervalDelayMs } from "../../../shared/schedule.js";
import type { Trigger, TriggerDeps } from "./types.js";
export { formatInterval, intervalToMs } from "../../../shared/schedule.js";

export class IntervalTrigger implements Trigger {
  readonly nodeId: string;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerInterval,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    const intervalMs = intervalToMs(this.cfg);
    if (this.cfg.runOnStart) {
      void this.fire(intervalMs);
    }
    this.scheduleNext(intervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private scheduleNext(intervalMs: number): void {
    if (this.disposed) return;
    const nextMs = nextIntervalDelayMs(this.cfg) ?? intervalMs;
    this.timeout = setTimeout(async () => {
      await this.fire(intervalMs);
      this.scheduleNext(intervalMs);
    }, Math.max(1000, nextMs));
  }

  private async fire(intervalMs: number): Promise<void> {
    if (this.disposed) return;
    try {
      await this.deps.fire(this.node, {
        every: this.cfg.every,
        unit: this.cfg.unit,
        intervalMs,
        runOnStart: this.cfg.runOnStart ? 1 : 0
      });
    } catch (err) {
      this.deps.log(
        `Interval trigger fire for node ${this.node.id} threw: ${err instanceof Error ? err.message : err}`,
        "error"
      );
    }
  }
}
