import { wrapLanguageModel, type LanguageModel } from "ai";
import type { Logger } from "../types.js";

/**
 * Transient backend failures (e.g. the ChatGPT Codex backend's
 * server_is_overloaded) arrive as an in-stream error event on an HTTP 200 —
 * the AI SDK's built-in retries never see them, and streamText reports them
 * only via onError. When the error arrives before the model has produced any
 * output, retrying the single model call is free of side effects: no tool has
 * run and nothing has streamed. This middleware buffers the head of each
 * stream, retries early errors with backoff, and passes everything else
 * through untouched. Errors that arrive after real output are not retried —
 * they propagate to the caller's error path as before.
 */
export interface StreamRetryOptions {
  /** Total attempts per model call, including the first (default 4). */
  attempts?: number;
  /**
   * Backoff base: attempt n waits baseDelayMs * 2^(n-1) (default 1000, so
   * 1s/2s/4s). Observed overload windows outlast sub-second retries, and an
   * extra few seconds is cheap for a texting assistant.
   */
  baseDelayMs?: number;
  logger?: Logger;
  /** Called once per retried attempt, so callers can count retries per turn. */
  onRetry?: () => void;
}

/** Stream parts that can precede an error without the call having "produced output". */
const PREAMBLE_PARTS = new Set(["stream-start", "response-metadata", "raw"]);

export function withStreamRetry(model: LanguageModel, options: StreamRetryOptions = {}): LanguageModel {
  if (typeof model === "string") return model;
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 1000;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream, params }) => {
        for (let attempt = 1; ; attempt += 1) {
          const result = await doStream();
          const probe = await readUntilOutputOrError(result.stream);
          if (!probe.earlyError || attempt >= attempts) {
            return { ...result, stream: replay(probe.buffered, probe.reader) };
          }
          await probe.reader.cancel().catch(() => undefined);
          options.onRetry?.();
          options.logger?.warn("The model stream failed before any output; retrying the call", {
            attempt,
            attempts,
            error: describeError(probe.errorValue),
          });
          await sleep(baseDelayMs * 2 ** (attempt - 1), params.abortSignal);
        }
      },
    },
  });
}

// Generic over the stream-part type so the middleware tracks whatever language
// model spec version the installed ai package uses.
interface Probe<Part> {
  buffered: Part[];
  reader: ReadableStreamDefaultReader<Part>;
  earlyError: boolean;
  errorValue?: unknown;
}

/** Buffer parts until the first real output or an error; later parts stay unread. */
async function readUntilOutputOrError<Part extends { type: string }>(
  stream: ReadableStream<Part>,
): Promise<Probe<Part>> {
  const reader = stream.getReader();
  const buffered: Part[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { buffered, reader, earlyError: false };
    buffered.push(value);
    if (value.type === "error") {
      return {
        buffered,
        reader,
        earlyError: true,
        errorValue: (value as { error?: unknown }).error,
      };
    }
    if (!PREAMBLE_PARTS.has(value.type)) {
      return { buffered, reader, earlyError: false };
    }
  }
}

/** The buffered head followed by the rest of the original stream. */
function replay<Part>(
  buffered: Part[],
  reader: ReadableStreamDefaultReader<Part>,
): ReadableStream<Part> {
  return new ReadableStream<Part>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 300 ? `${text.slice(0, 300)}…` : (text ?? String(value));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The turn was aborted while waiting to retry", "AbortError"));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("The turn was aborted while waiting to retry", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}
