import test from "node:test";
import assert from "node:assert/strict";
import {
  createHeadlessModelProvider,
  createOpenAiCompatibleModelProvider
} from "../src/headless/model-providers.js";
import type { RuntimeChatMessage } from "../src/runtime/node-runner.js";

test("headless provider infers OpenAI-compatible config from environment", async () => {
  const calls: FetchCall[] = [];
  const provider = createHeadlessModelProvider({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://example.test/v1/",
      OPENAI_MODEL: "test-model"
    },
    fetchImpl: fakeFetch(calls, { choices: [{ message: { content: "Hello from OpenAI." } }] })
  });

  const model = await provider.selectModel(undefined);
  const text = await collect(model.sendRequest([{ role: "user", content: "Hi" }]));

  assert.equal(text, "Hello from OpenAI.");
  assert.equal(model.id, "test-model");
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "test-model",
    messages: [{ role: "user", content: "Hi" }]
  });
});

test("OpenAI-compatible provider uses node model selector when no CLI model override exists", async () => {
  const calls: FetchCall[] = [];
  const provider = createOpenAiCompatibleModelProvider({
    apiKey: "test-key",
    fetchImpl: fakeFetch(calls, { choices: [{ message: { content: "Selected model." } }] })
  });

  const model = await provider.selectModel({ vendor: "openai", id: "gpt-test" });
  const text = await collect(model.sendRequest([{ role: "assistant", content: "Earlier" }]));

  assert.equal(text, "Selected model.");
  assert.equal(model.id, "gpt-test");
  assert.equal(JSON.parse(calls[0].init.body).model, "gpt-test");
});

test("OpenAI-compatible provider surfaces API errors", async () => {
  const provider = createOpenAiCompatibleModelProvider({
    apiKey: "test-key",
    fetchImpl: fakeFetch([], { error: { message: "bad request" } }, { ok: false, status: 400, statusText: "Bad Request" })
  });

  const model = await provider.selectModel(undefined);
  await assert.rejects(() => collect(model.sendRequest([{ role: "user", content: "Hi" }])), /bad request/);
});

type FetchCall = {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
};

function fakeFetch(
  calls: FetchCall[],
  body: unknown,
  response: { ok?: boolean; status?: number; statusText?: string } = {}
) {
  return async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      text: async () => JSON.stringify(body)
    };
  };
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks.join("");
}