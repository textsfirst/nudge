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

  constructor(private readonly options: ChatGptSubscriptionSourceOptions) {}

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

export class OpenAiApiSource implements ModelSource {
  readonly id = "openai-api";
  readonly #model: LanguageModel;

  constructor(options: OpenAiApiSourceOptions) {
    this.#model = createOpenAI({ apiKey: options.apiKey }).responses(options.model);
  }

  languageModel(): Promise<LanguageModel> {
    return Promise.resolve(this.#model);
  }

  isAuthError(): boolean {
    return false;
  }
}
