import type { ModelSelector } from "../../shared/types.js";
import type { RuntimeChatMessage, RuntimeLanguageModel, RuntimeModelProvider } from "../runtime/node-runner.js";

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

export function createUnavailableModelProvider(): RuntimeModelProvider {
  return {
    async selectModel(): Promise<RuntimeLanguageModel> {
      throw new Error(
        "No headless model provider is configured yet. Use --dry-run or --mock-response for this preview CLI."
      );
    }
  };
}