import { APICallError } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelSource } from "../types.js";
import { ChatGptAuthManager } from "./chatgpt-auth.js";
import { SubscriptionAuthError } from "./errors.js";
import {
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_VERSION,
  GrokAuthManager,
} from "./grok-auth.js";

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

  async languageModel(modelOverride?: string): Promise<LanguageModel> {
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
    return openai.responses(modelOverride ?? this.options.model);
  }

  isAuthError(error: unknown): boolean {
    return (
      error instanceof SubscriptionAuthError ||
      (APICallError.isInstance(error) &&
        (error.statusCode === 401 || error.statusCode === 403))
    );
  }
}

/**
 * xAI's CLI proxy: it serves the Responses API and maps model ids to their
 * subscription variants (grok-4.6 → grok-4.6-build), so requests ride the
 * owner's Grok subscription quota instead of api.x.ai credits.
 */
export const GROK_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

export interface GrokSubscriptionSourceOptions {
  auth: GrokAuthManager;
  model: string;
  /** Overrides the pinned CLI version the proxy checks (it answers 426 to old ones). */
  clientVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export class GrokSubscriptionSource implements ModelSource {
  readonly id = "grok-subscription";
  readonly modelId: string;

  constructor(private readonly options: GrokSubscriptionSourceOptions) {
    this.modelId = options.model;
  }

  async languageModel(modelOverride?: string): Promise<LanguageModel> {
    const credentials = await this.options.auth.credentials();
    const version = this.options.clientVersion ?? GROK_CLIENT_VERSION;
    const openai = createOpenAI({
      apiKey: credentials.accessToken,
      baseURL: GROK_PROXY_BASE_URL,
      // The header set the proxy expects from the official Grok Build CLI;
      // missing or outdated ones are rejected (426).
      headers: {
        "user-agent": `${GROK_CLIENT_IDENTIFIER}/${version}`,
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
        "x-grok-client-version": version,
        "x-grok-client-mode": "interactive",
        "x-xai-token-auth": "xai-grok-cli",
        "x-authenticateresponse": "authenticate-response",
      },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return openai.responses(modelOverride ?? this.options.model);
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
  readonly #api: "chat-completions" | "responses";
  readonly #provider: ReturnType<typeof createOpenAI>;

  constructor(options: CustomEndpointSourceOptions) {
    this.modelId = options.model;
    this.#api = options.api;
    this.#provider = createOpenAI({
      baseURL: options.baseUrl,
      // Keyless local servers ignore the header, but the SDK insists on a
      // value — send a placeholder when no key is configured.
      apiKey: options.apiKey ?? "none",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  languageModel(modelOverride?: string): Promise<LanguageModel> {
    const model = modelOverride ?? this.modelId;
    return Promise.resolve(
      this.#api === "responses" ? this.#provider.responses(model) : this.#provider.chat(model),
    );
  }

  isAuthError(): boolean {
    return false;
  }
}

export class OpenAiApiSource implements ModelSource {
  readonly id = "openai-api";
  readonly modelId: string;
  readonly #provider: ReturnType<typeof createOpenAI>;

  constructor(options: OpenAiApiSourceOptions) {
    this.modelId = options.model;
    this.#provider = createOpenAI({ apiKey: options.apiKey });
  }

  languageModel(modelOverride?: string): Promise<LanguageModel> {
    return Promise.resolve(this.#provider.responses(modelOverride ?? this.modelId));
  }

  isAuthError(): boolean {
    return false;
  }
}
