import test from "node:test";
import assert from "node:assert/strict";
import { formatInterval, intervalToMs } from "../src/runtime/triggers/interval-trigger.js";

test("simple interval trigger converts units to milliseconds", () => {
  assert.equal(intervalToMs({ type: "interval", every: 30, unit: "seconds" }), 30_000);
  assert.equal(intervalToMs({ type: "interval", every: 15, unit: "minutes" }), 900_000);
  assert.equal(intervalToMs({ type: "interval", every: 2, unit: "hours" }), 7_200_000);
  assert.equal(intervalToMs({ type: "interval", every: 1, unit: "days" }), 86_400_000);
});

test("simple interval trigger formats labels", () => {
  assert.equal(formatInterval({ type: "interval", every: 1, unit: "hours" }), "Every 1 hour");
  assert.equal(formatInterval({ type: "interval", every: 2, unit: "hours" }), "Every 2 hours");
});