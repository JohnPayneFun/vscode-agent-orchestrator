import type { TriggerInterval, WorkflowNode } from "../../../shared/types.js";
import type { Trigger, TriggerDeps } from "./types.js";

const UNIT_MS: Record<TriggerInterval["unit"], number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000
};

export class IntervalTrigger implements Trigger {
  readonly nodeId: string;
  private interval: NodeJS.Timeout | null = null;
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
    this.interval = setInterval(() => void this.fire(intervalMs), intervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
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

export function intervalToMs(cfg: TriggerInterval): number {
  const every = Math.max(1, Math.floor(cfg.every));
  return every * UNIT_MS[cfg.unit];
}

export function formatInterval(cfg: TriggerInterval): string {
  const unit = cfg.every === 1 ? cfg.unit.replace(/s$/, "") : cfg.unit;
  return `Every ${cfg.every} ${unit}`;
}