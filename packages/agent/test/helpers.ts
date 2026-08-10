import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeStore } from "@nudge/store";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { NudgeAgent, SubscriptionAuthError } from "../src/index.js";
import type { Logger, ModelSource, NudgeAgentOptions } from "../src/index.js";

export const quietLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

export function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: "stop", usage },
  ];
}

export function toolCallChunks(toolName: string, input: object): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: "tool-calls", usage },
  ];
}

export type ScriptEntry =
  | string
  | LanguageModelV3StreamPart[]
  | (() => string | LanguageModelV3StreamPart[]);

/**
 * A model source scripted with an ordered list of responses. Each response is
 * plain reply text, a pre-built chunk array (e.g. a tool call), or a thunk —
 * which may throw, to script mid-conversation failures. Like a real provider,
 * a call with an already-aborted signal rejects instead of streaming.
 */
export class ScriptedSource implements ModelSource {
  readonly id: string;
  readonly mock: MockLanguageModelV3;
  #script: ScriptEntry[];

  constructor(id: string, script: ScriptEntry[]) {
    this.id = id;
    this.#script = [...script];
    this.mock = new MockLanguageModelV3({
      doStream: async (options) => {
        if (options.abortSignal?.aborted) {
          throw new DOMException("The model call was aborted", "AbortError");
        }
        const next = this.#script.shift();
        if (next === undefined) {
          throw new Error(`ScriptedSource "${id}" ran out of scripted responses`);
        }
        const resolved = typeof next === "function" ? next() : next;
        return {
          stream: simulateReadableStream({
            chunks: typeof resolved === "string" ? textChunks(resolved) : resolved,
          }),
        };
      },
    });
  }

  get calls(): LanguageModelV3CallOptions[] {
    return this.mock.doStreamCalls;
  }

  languageModel() {
    return Promise.resolve(this.mock);
  }

  isAuthError(error: unknown): boolean {
    return error instanceof SubscriptionAuthError;
  }
}

export interface Harness {
  agent: NudgeAgent;
  store: NudgeStore;
  source: ScriptedSource;
  dataDir: string;
  setNow(at: number): void;
}

export function makeAgent(script: ScriptEntry[], overrides: Partial<NudgeAgentOptions> = {}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "nudge-test-"));
  const store = new NudgeStore(":memory:");
  const source = new ScriptedSource("scripted", script);
  let now = Date.UTC(2026, 7, 10, 15, 0, 0);
  const agent = new NudgeAgent({
    sources: [source],
    store,
    logger: quietLogger,
    timeZone: "UTC",
    dataDir,
    systemFile: () => undefined,
    now: () => now,
    ...overrides,
  });
  return {
    agent,
    store,
    source,
    dataDir,
    setNow: (at) => {
      now = at;
    },
  };
}

/** Flatten a mock call's prompt into readable role/text pairs. */
export function promptMessages(
  call: LanguageModelV3CallOptions,
): { role: string; text: string }[] {
  return call.prompt.map((message) => ({
    role: message.role,
    text:
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join(""),
  }));
}
