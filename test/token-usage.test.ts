import test from "node:test";
import assert from "node:assert/strict";
import { countMessageTokens, countTextTokens, estimateTokens } from "../src/runtime/token-usage.js";
import type { RuntimeLanguageModel } from "../src/runtime/node-runner.js";

test("token usage uses model-specific counters when available", async () => {
  const model: RuntimeLanguageModel = {
    id: "counting",
    name: "Counting",
    async countTokens(input) {
      return typeof input === "string" ? 7 : input.length * 11;
    },
    async *sendRequest() {
      yield "";
    }
  };

  assert.deepEqual(await countMessageTokens(model, [{ role: "user", content: "hello" }]), {
    tokens: 11,
    estimated: false
  });
  assert.deepEqual(await countTextTokens(model, "hello"), { tokens: 7, estimated: false });
});

test("token usage falls back to deterministic estimates", async () => {
  const model: RuntimeLanguageModel = {
    id: "fallback",
    name: "Fallback",
    async *sendRequest() {
      yield "";
    }
  };

  const counted = await countTextTokens(model, "Hello, world.");
  assert.equal(counted.estimated, true);
  assert.equal(counted.tokens, estimateTokens("Hello, world."));
});
