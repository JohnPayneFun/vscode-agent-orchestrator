import parser from "cron-parser";
import type { TriggerConfig, TriggerInterval, TriggerTimer } from "./types.js";

const UNIT_MS: Record<TriggerInterval["unit"], number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000
};

export function intervalToMs(cfg: TriggerInterval): number {
  const every = Math.max(1, Math.floor(cfg.every));
  return every * UNIT_MS[cfg.unit];
}

export function formatInterval(cfg: TriggerInterval): string {
  const unit = cfg.every === 1 ? cfg.unit.replace(/s$/, "") : cfg.unit;
  return `Every ${cfg.every} ${unit}`;
}

export function nextTriggerAt(trigger: TriggerConfig, nowMs = Date.now()): Date | null {
  switch (trigger.type) {
    case "interval": {
      const delayMs = nextIntervalDelayMs(trigger, nowMs);
      return delayMs === null ? null : new Date(nowMs + delayMs);
    }
    case "timer":
      return nextCronDate(trigger, nowMs);
    default:
      return null;
  }
}

export function nextIntervalDelayMs(cfg: TriggerInterval, nowMs = Date.now()): number | null {
  const intervalMs = intervalToMs(cfg);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const elapsedMs = nowMs % intervalMs;
  return elapsedMs === 0 ? intervalMs : intervalMs - elapsedMs;
}

export function nextCronDate(cfg: TriggerTimer, nowMs = Date.now()): Date | null {
  try {
    const interval = parser.parseExpression(cfg.cron, {
      currentDate: new Date(nowMs),
      tz: cfg.tz === "utc" ? "UTC" : undefined
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}