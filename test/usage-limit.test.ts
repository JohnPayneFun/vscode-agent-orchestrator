import test from "node:test";
import assert from "node:assert/strict";
import { parseUsageLimitRetry } from "../src/runtime/usage-limit.js";

test("usage-limit parser schedules one minute after try-again minutes", () => {
  const now = new Date("2026-05-01T10:00:00.000Z");
  const retry = parseUsageLimitRetry(
    "FailoverError: :warning: You have hit your ChatGPT usage limit (plus plan). Try again in ~63 min.",
    now
  );

  assert.ok(retry);
  assert.equal(retry.waitMs, 63 * 60_000);
  assert.equal(retry.retryDelayMs, 64 * 60_000);
  assert.equal(retry.retryAt, "2026-05-01T11:04:00.000Z");
});

test("usage-limit parser ignores unrelated errors", () => {
  assert.equal(parseUsageLimitRetry("Tool failed: Invalid stream"), null);
});
