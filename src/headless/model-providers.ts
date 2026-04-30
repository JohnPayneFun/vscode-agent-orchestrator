import type { ModelSelector } from "../../shared/types.js";
import type { RuntimeChatMessage, RuntimeLanguageModel, RuntimeModelProvider } from "../runtime/node-runner.js";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string> }>;

export interface HeadlessModelProviderOptions {
  mockResponse?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export function createHeadlessModelProvider(options: HeadlessModelProviderOptions = {}): RuntimeModelProvider {
  if (options.mockResponse !== undefined) return createStaticModelProvider(options.mockResponse);

  const env = options.env ?? process.env;
  const provider = (options.provider ?? env.AGENT_ORCHESTRATOR_MODEL_PROVIDER ?? inferProvider(env))
    ?.trim()
    .toLocaleLowerCase();

  if (!provider) return createUnavailableModelProvider();
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = env.AGENT_ORCHESTRATOR_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      return createUnavailableModelProvider(
        "OpenAI-compatible provider selected, but no API key is configured. Set OPENAI_API_KEY or AGENT_ORCHESTRATOR_OPENAI_API_KEY."
      );
    }
    return createOpenAiCompatibleModelProvider({
      apiKey,
      baseUrl: options.baseUrl ?? env.AGENT_ORCHESTRATOR_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL,
      model: options.model ?? env.AGENT_ORCHESTRATOR_MODEL ?? env.OPENAI_MODEL,
      fetchImpl: options.fetchImpl
    });
  }

  return createUnavailableModelProvider(
    `Unsupported headless model provider: ${provider}. Supported providers: openai, openai-compatible.`
  );
}

export function createStaticModelProvider(response: string): RuntimeModelProvider {
  return {
    async selectModel(selector: ModelSelector | undefined): Promise<RuntimeLanguageModel> {
      return {
        id: selector?.id ?? "static-headless-model",
        name: "Static Headless Model",
        vendor: selector?.vendor ?? "headless",
        family: selector?.family ?? "static",
        async *sendRequest(_messages: RuntimeChatMessage[]): AsyncIterable<string> {
          yield response;
        }
      };
    }
  };
}

export function createOpenAiCompatibleModelProvider(options: OpenAiCompatibleOptions): RuntimeModelProvider {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
  const fetchImpl = options.fetchImpl ?? globalFetch;
  return {
    async selectModel(selector: ModelSelector | undefined): Promise<RuntimeLanguageModel> {
      const model = options.model ?? selector?.id ?? selector?.family ?? DEFAULT_OPENAI_MODEL;
      return {
        id: model,
        name: model,
        vendor: selector?.vendor ?? "openai-compatible",
        family: selector?.family ?? model,
        async *sendRequest(messages: RuntimeChatMessage[]): AsyncIterable<string> {
          const response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ model, messages: toOpenAiMessages(messages) })
          });
          const body = await response.text();
          if (!response.ok) {
            throw new Error(
              `OpenAI-compatible provider failed (${response.status} ${response.statusText}): ${extractErrorMessage(body)}`
            );
          }
          yield extractAssistantMessage(body);
        }
      };
    }
  };
}

export function createUnavailableModelProvider(message?: string): RuntimeModelProvider {
  return {
    async selectModel(): Promise<RuntimeLanguageModel> {
      throw new Error(
        message ??
          "No headless model provider is configured. Use --dry-run, --mock-response, or configure an OpenAI-compatible provider."
      );
    }
  };
}

function inferProvider(env: NodeJS.ProcessEnv): string | undefined {
  return env.AGENT_ORCHESTRATOR_OPENAI_API_KEY || env.OPENAI_API_KEY ? "openai" : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/g, "");
}

function globalFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
): Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string> }> {
  const fn = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!fn) throw new Error("This Node.js runtime does not provide fetch. Use Node 20 or newer.");
  return fn(url, init);
}

function toOpenAiMessages(messages: RuntimeChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function extractAssistantMessage(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("OpenAI-compatible provider returned invalid JSON.");
  }

  const choices = getRecord(parsed).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenAI-compatible provider returned no choices.");
  }
  const content = getRecord(getRecord(choices[0]).message).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = getRecord(part);
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }
  throw new Error("OpenAI-compatible provider returned no assistant message content.");
}

function extractErrorMessage(rawBody: string): string {
  try {
    const message = getRecord(getRecord(JSON.parse(rawBody)).error).message;
    return typeof message === "string" && message.trim() ? message : rawBody.slice(0, 500);
  } catch {
    return rawBody.slice(0, 500) || "empty response";
  }
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}