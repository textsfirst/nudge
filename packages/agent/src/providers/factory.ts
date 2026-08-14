import type { ModelSource } from "../types.js";
import {
  ChatGptSubscriptionSource,
  CustomEndpointSource,
  GrokSubscriptionSource,
  OpenAiApiSource,
} from "./ai-sdk.js";
import { ChatGptAuthManager } from "./chatgpt-auth.js";
import { GrokAuthManager } from "./grok-auth.js";

export interface ProviderConfig {
  selected: "chatgpt-subscription" | "grok-subscription" | "openai-api" | "custom";
  chatGptModel: string;
  chatGptAuthFile: string;
  grokModel: string;
  grokAuthFile: string;
  grokClientVersion?: string;
  openAiApiKey?: string;
  openAiModel: string;
  customBaseUrl?: string;
  customModel?: string;
  customApi?: "chat-completions" | "responses";
  customApiKey?: string;
}

/**
 * Exactly one model source: the selected provider. There is deliberately no
 * API-key fallback — a subscription auth failure surfaces as an error telling
 * the owner to reconnect, never as silent API-credit spending.
 */
export function createModelSources(config: ProviderConfig): ModelSource[] {
  if (config.selected === "custom") {
    if (!config.customBaseUrl || !config.customModel) {
      throw new Error(
        "The custom provider needs both a base URL and a model id — set them on the console's Settings page.",
      );
    }
    return [
      new CustomEndpointSource({
        baseUrl: config.customBaseUrl,
        model: config.customModel,
        api: config.customApi ?? "chat-completions",
        ...(config.customApiKey ? { apiKey: config.customApiKey } : {}),
      }),
    ];
  }

  if (config.selected === "openai-api") {
    if (!config.openAiApiKey) {
      throw new Error("MODEL_PROVIDER=openai-api requires OPENAI_API_KEY");
    }
    return [new OpenAiApiSource({ apiKey: config.openAiApiKey, model: config.openAiModel })];
  }

  if (config.selected === "grok-subscription") {
    return [
      new GrokSubscriptionSource({
        auth: new GrokAuthManager({
          authFile: config.grokAuthFile,
          ...(config.grokClientVersion ? { clientVersion: config.grokClientVersion } : {}),
        }),
        model: config.grokModel,
        ...(config.grokClientVersion ? { clientVersion: config.grokClientVersion } : {}),
      }),
    ];
  }

  return [
    new ChatGptSubscriptionSource({
      auth: new ChatGptAuthManager({ authFile: config.chatGptAuthFile }),
      model: config.chatGptModel,
    }),
  ];
}
