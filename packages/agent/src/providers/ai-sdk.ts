import { APICallError } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelSource } from "../types.js";
import { ChatGptAuthManager } from "./chatgpt-auth.js";
import { SubscriptionAuthError } from "./errors.js";

export interface ChatGptSubscriptionSourceOptions {
  auth: ChatGptAuthManager;
  model: string;
  fetch?: typeof globalThis.fetch;
}

export class ChatGptSubscriptionSource implements ModelSource {
  readonly id = "chatgpt-subscription";
  readonly modelId: string;

  constructor(private readonly options: ChatGptSubscriptionSourceOptions) {
    this.modelId = options.model;
  }

  async languageModel(): Promise<LanguageModel> {
    const credentials = await this.options.auth.credentials();
    const openai = createOpenAI({
      apiKey: credentials.accessToken,
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: {
        "chatgpt-account-id": credentials.accountId,
        originator: "nudge",
      },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return openai.responses(this.options.model);
  }

  isAuthError(error: unknown): boolean {
    return (
      error instanceof SubscriptionAuthError ||
      (APICallError.isInstance(error) &&
        (error.statusCode === 401 || error.statusCode === 403))
    );
  }
}

export interface OpenAiApiSourceOptions {
  apiKey: string;
  model: string;
}

export interface CustomEndpointSourceOptions {
  baseUrl: string;
  model: string;
  api: "chat-completions" | "responses";
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Any OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, LM Studio, a
 * proxy, ...). Defaults to the Chat Completions API, which is what most
 * compatible servers implement; switch to Responses only when the endpoint
 * supports it.
 */
export class CustomEndpointSource implements ModelSource {
  readonly id = "custom";
  readonly modelId: string;
  readonly #model: LanguageModel;

  constructor(options: CustomEndpointSourceOptions) {
    this.modelId = options.model;
    const provider = createOpenAI({
      baseURL: options.baseUrl,
      // Keyless local servers ignore the header, but the SDK insists on a
      // value — send a placeholder when no key is configured.
      apiKey: options.apiKey ?? "none",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.#model =
      options.api === "responses"
        ? provider.responses(options.model)
        : provider.chat(options.model);
  }

  languageModel(): Promise<LanguageModel> {
    return Promise.resolve(this.#model);
  }

  isAuthError(): boolean {
    return false;
  }
}

export class OpenAiApiSource implements ModelSource {
  readonly id = "openai-api";
  readonly modelId: string;
  readonly #model: LanguageModel;

  constructor(options: OpenAiApiSourceOptions) {
    this.modelId = options.model;
    this.#model = createOpenAI({ apiKey: options.apiKey }).responses(options.model);
  }

  languageModel(): Promise<LanguageModel> {
    return Promise.resolve(this.#model);
  }

  isAuthError(): boolean {
    return false;
  }
}
