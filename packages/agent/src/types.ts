import type { LanguageModel } from "ai";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

/**
 * A configured way to obtain a language model. Sources are tried in order;
 * a source's auth failure (and only an auth failure) moves the loop to the
 * next source, preserving the MVP's "auth-only fallback" contract.
 */
export interface ModelSource {
  readonly id: string;
  languageModel(): Promise<LanguageModel>;
  isAuthError(error: unknown): boolean;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
