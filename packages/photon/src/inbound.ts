export interface InboundTextMessage {
  id: string;
  handle: string;
  text: string;
  spaceId: string;
  platform: string;
}

export interface InboundBatch {
  handle: string;
  spaceId: string;
  texts: string[];
  messageIds: string[];
}

export interface InboundLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface InboundProcessorOptions<Context> {
  ownerHandle: string;
  logger: InboundLogger;
  /** Durable dedupe check, e.g. backed by the store. */
  isDuplicate: (messageId: string) => boolean;
  /**
   * Handle one debounced batch. Receives the context of the batch's most
   * recent message (e.g. its rehydrated space).
   */
  onBatch: (batch: InboundBatch, context: Context) => Promise<void>;
  /** How long to wait for follow-up texts before replying. */
  debounceMs?: number;
}

interface PendingBatch<Context> {
  handle: string;
  spaceId: string;
  texts: string[];
  messageIds: string[];
  context: Context;
  timer: NodeJS.Timeout;
}

/**
 * Filters inbound messages (owner-only, iMessage-only, deduplicated) and
 * debounces bursts of consecutive texts into a single batch per handle, so a
 * flurry of short messages gets one considered reply instead of several.
 */
export class InboundProcessor<Context> {
  readonly #options: InboundProcessorOptions<Context>;
  readonly #debounceMs: number;
  readonly #pending = new Map<string, PendingBatch<Context>>();
  readonly #buffered = new Set<string>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: InboundProcessorOptions<Context>) {
    this.#options = options;
    this.#debounceMs = options.debounceMs ?? 2_500;
  }

  process(message: InboundTextMessage, context: Context): void {
    const { logger, ownerHandle } = this.#options;
    if (message.platform.toLowerCase() !== "imessage") {
      logger.debug("Ignoring a non-iMessage delivery", {
        platform: message.platform,
        messageId: message.id,
      });
      return;
    }
    if (message.handle !== ownerHandle) {
      logger.warn("Ignoring a message from a non-owner handle", {
        handle: message.handle,
        messageId: message.id,
      });
      return;
    }
    if (this.#buffered.has(message.id) || this.#options.isDuplicate(message.id)) {
      logger.debug("Ignoring a duplicate Photon delivery", { messageId: message.id });
      return;
    }

    this.#buffered.add(message.id);
    const existing = this.#pending.get(message.handle);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(message.text);
      existing.messageIds.push(message.id);
      existing.context = context;
      existing.spaceId = message.spaceId;
      existing.timer = setTimeout(() => this.#flush(message.handle), this.#debounceMs);
      return;
    }
    this.#pending.set(message.handle, {
      handle: message.handle,
      spaceId: message.spaceId,
      texts: [message.text],
      messageIds: [message.id],
      context,
      timer: setTimeout(() => this.#flush(message.handle), this.#debounceMs),
    });
  }

  /** Deliver any buffered batches immediately (used on shutdown and in tests). */
  async flushNow(): Promise<void> {
    for (const handle of [...this.#pending.keys()]) {
      this.#flush(handle);
    }
    await Promise.all([...this.#queues.values()]);
  }

  #flush(handle: string): void {
    const pending = this.#pending.get(handle);
    if (!pending) return;
    this.#pending.delete(handle);
    clearTimeout(pending.timer);

    const batch: InboundBatch = {
      handle: pending.handle,
      spaceId: pending.spaceId,
      texts: pending.texts,
      messageIds: pending.messageIds,
    };
    const previous = this.#queues.get(handle) ?? Promise.resolve();
    const run = previous
      .then(() => this.#options.onBatch(batch, pending.context))
      .catch((error: unknown) => {
        this.#options.logger.error("Failed to process an inbound batch", {
          messageIds: batch.messageIds,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const id of batch.messageIds) {
          this.#buffered.delete(id);
        }
      });
    this.#queues.set(handle, run);
    void run.finally(() => {
      if (this.#queues.get(handle) === run) {
        this.#queues.delete(handle);
      }
    });
  }
}
