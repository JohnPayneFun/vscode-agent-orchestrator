import type { RuntimeChatMessage, RuntimeLanguageModel } from "./node-runner.js";

export interface TokenCountResult {
  tokens: number;
  estimated: boolean;
}

export async function countMessageTokens(
  model: RuntimeLanguageModel,
  messages: RuntimeChatMessage[]
): Promise<TokenCountResult> {
  if (model.countTokens) {
    try {
      return { tokens: await model.countTokens(messages), estimated: false };
    } catch {
      // Fall through to deterministic estimate.
    }
  }
  return { tokens: estimateTokens(messages.map((message) => message.content).join("\n\n")), estimated: true };
}

export async function countTextTokens(model: RuntimeLanguageModel, text: string): Promise<TokenCountResult> {
  if (model.countTokens) {
    try {
      return { tokens: await model.countTokens(text), estimated: false };
    } catch {
      // Fall through to deterministic estimate.
    }
  }
  return { tokens: estimateTokens(text), estimated: true };
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const wordishTokens = trimmed.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(wordishTokens * 1.25));
}
