import test from "node:test";
import assert from "node:assert/strict";
import { buildWebhookPayload, normalizeWebhookPath } from "../src/runtime/triggers/webhook-trigger.js";

test("webhook trigger normalizes paths", () => {
  assert.equal(normalizeWebhookPath("security"), "/security");
  assert.equal(normalizeWebhookPath("/security"), "/security");
  assert.equal(normalizeWebhookPath(""), "/webhook");
});

test("webhook trigger builds payload from request metadata", () => {
  const payload = buildWebhookPayload({
    request: {
      method: "post",
      headers: {
        "content-type": "application/json",
        "x-example": ["a", "b"]
      }
    },
    url: new URL("http://127.0.0.1:8787/agent-orchestrator/security?tag=a&tag=b&source=test"),
    body: { message: "hello" },
    receivedAt: "2026-04-30T00:00:00.000Z"
  });

  assert.deepEqual(payload, {
    method: "POST",
    path: "/agent-orchestrator/security",
    query: { tag: ["a", "b"], source: "test" },
    headers: {
      "content-type": "application/json",
      "x-example": "a, b"
    },
    body: { message: "hello" },
    receivedAt: "2026-04-30T00:00:00.000Z"
  });
});