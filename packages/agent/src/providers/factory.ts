import type { ModelSource } from "../types.js";
import { ChatGptSubscriptionSource, OpenAiApiSource } from "./ai-sdk.js";
import { ChatGptAuthManager } from "./chatgpt-auth.js";

export interface ProviderConfig {
  selected: "chatgpt-subscription" | "openai-api";
  chatGptModel: string;
  chatGptAuthFile: string;
  openAiApiKey?: string;
  openAiModel: string;
  openAiFallbackEnabled: boolean;
}

/**
 * Ordered model sources: the selected provider first, then (for the
 * subscription provider only, when configured) the API-key fallback used
 * exclusively on auth failures.
 */
export function createModelSources(config: ProviderConfig): ModelSource[] {
  const apiSource = config.openAiApiKey
    ? new OpenAiApiSource({ apiKey: config.openAiApiKey, model: config.openAiModel })
    : undefined;

  if (config.selected === "openai-api") {
    if (!apiSource) {
      throw new Error("MODEL_PROVIDER=openai-api requires OPENAI_API_KEY");
    }
    return [apiSource];
  }

  const subscription = new ChatGptSubscriptionSource({
    auth: new ChatGptAuthManager({ authFile: config.chatGptAuthFile }),
    model: config.chatGptModel,
  });
  return apiSource && config.openAiFallbackEnabled ? [subscription, apiSource] : [subscription];
}
