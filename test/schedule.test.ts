import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCountdown,
  formatInterval,
  intervalToMs,
  nextCronDate,
  nextTriggerAt,
  nextIntervalDelayMs
} from "../shared/schedule.js";

test("schedule helpers convert and format simple intervals", () => {
  assert.equal(intervalToMs({ type: "interval", every: 30, unit: "seconds" }), 30_000);
  assert.equal(intervalToMs({ type: "interval", every: 15, unit: "minutes" }), 900_000);
  assert.equal(formatInterval({ type: "interval", every: 1, unit: "hours" }), "Every 1 hour");
  assert.equal(formatInterval({ type: "interval", every: 2, unit: "hours" }), "Every 2 hours");
});

test("schedule helpers calculate countdown text", () => {
  assert.equal(formatCountdown(1_000), "1s");
  assert.equal(formatCountdown(61_000), "1m 1s");
  assert.equal(formatCountdown(3_660_000), "1h 1m");
  assert.equal(formatCountdown(90_000_000), "1d 1h");
});

test("schedule helpers calculate next interval boundary", () => {
  assert.equal(nextIntervalDelayMs({ type: "interval", every: 30, unit: "minutes" }, 60_000), 1_740_000);
});

test("schedule helpers calculate next cron date", () => {
  const next = nextCronDate({ type: "timer", cron: "*/30 * * * *", tz: "utc" }, Date.UTC(2026, 4, 1, 10, 1, 0));

  assert.equal(next?.toISOString(), "2026-05-01T10:30:00.000Z");
});

test("schedule helpers use the next scheduled child for any triggers", () => {
  const nowMs = Date.UTC(2026, 4, 1, 10, 1, 0);
  const next = nextTriggerAt(
    {
      type: "any",
      triggers: [
        { type: "handoff" },
        { type: "timer", cron: "*/30 * * * *", tz: "utc" },
        { type: "interval", every: 2, unit: "hours" }
      ]
    },
    nowMs
  );

  assert.equal(next?.toISOString(), "2026-05-01T10:30:00.000Z");
});