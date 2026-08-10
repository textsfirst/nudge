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
   * recent message (e.g. its rehydrated space). The signal aborts when a
   * newer message from the same handle arrives mid-run (steering): abandon
   * the reply — the newer batch runs next against full history.
   */
  onBatch: (batch: InboundBatch, context: Context, signal: AbortSignal) => Promise<void>;
  /** How long to wait for follow-up texts before replying. */
  debounceMs?: number;
  /**
   * Called with the freshest context whenever a batch is buffered and waiting
   * out its debounce — on each accepted message, and again when a steered run
   * settles with a batch still waiting — so the transport can show a typing
   * indicator through the whole wait instead of only while the reply
   * generates. Must not throw.
   */
  onWaiting?: (context: Context) => void;
}

interface PendingBatch<Context> {
  handle: string;
  spaceId: string;
  texts: string[];
  messageIds: string[];
  context: Context;
  timer: NodeJS.Timeout;
  /** True when the debounce expired while a run was in flight: flush on settle. */
  ripe: boolean;
}

interface RunningBatch {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Filters inbound messages (owner-only, iMessage-only, deduplicated) and
 * debounces bursts of consecutive texts into a single batch per handle, so a
 * flurry of short messages gets one considered reply instead of several.
 *
 * A message arriving while a reply is already being generated steers it: the
 * in-flight run's signal aborts immediately, and the new text keeps buffering
 * until the handle is free, so everything sent while busy folds into one
 * follow-up turn instead of queueing stale replies.
 */
export class InboundProcessor<Context> {
  readonly #options: InboundProcessorOptions<Context>;
  readonly #debounceMs: number;
  readonly #pending = new Map<string, PendingBatch<Context>>();
  readonly #buffered = new Set<string>();
  readonly #running = new Map<string, RunningBatch>();

  constructor(options: InboundProcessorOptions<Context>) {
    this.#options = options;
    this.#debounceMs = options.debounceMs ?? 2_500;
  }

  process(message: InboundTextMessage, context: Context): void {
    const { logger, ownerHandle } = this.#options;
    if (message.platform.toLowerCase() !== "imessage") {
      logger.warn("Ignoring a delivery from an unsupported platform", {
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
    // Steer: a newer message supersedes whatever reply is being generated.
    this.#running.get(message.handle)?.controller.abort();

    const existing = this.#pending.get(message.handle);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(message.text);
      existing.messageIds.push(message.id);
      existing.context = context;
      existing.spaceId = message.spaceId;
      existing.ripe = false;
      existing.timer = setTimeout(() => this.#flush(message.handle), this.#debounceMs);
    } else {
      this.#pending.set(message.handle, {
        handle: message.handle,
        spaceId: message.spaceId,
        texts: [message.text],
        messageIds: [message.id],
        context,
        timer: setTimeout(() => this.#flush(message.handle), this.#debounceMs),
        ripe: false,
      });
    }
    this.#options.onWaiting?.(context);
  }

  /** Deliver any buffered batches immediately (used on shutdown and in tests). */
  async flushNow(): Promise<void> {
    while (this.#pending.size > 0 || this.#running.size > 0) {
      await Promise.all([...this.#running.values()].map((run) => run.done));
      for (const [handle, pending] of [...this.#pending.entries()]) {
        if (!this.#running.has(handle)) {
          pending.ripe = true;
          this.#flush(handle);
        }
      }
    }
  }

  #flush(handle: string): void {
    const pending = this.#pending.get(handle);
    if (!pending) return;
    if (this.#running.has(handle)) {
      // The handle is busy (its run is already signalled to abort); hold the
      // batch so anything else arriving folds in, and flush when it settles.
      pending.ripe = true;
      return;
    }
    this.#pending.delete(handle);
    clearTimeout(pending.timer);

    const batch: InboundBatch = {
      handle: pending.handle,
      spaceId: pending.spaceId,
      texts: pending.texts,
      messageIds: pending.messageIds,
    };
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.#options.onBatch(batch, pending.context, controller.signal))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          this.#options.logger.debug("A reply was steered by a newer message", {
            messageIds: batch.messageIds,
          });
          return;
        }
        this.#options.logger.error("Failed to process an inbound batch", {
          messageIds: batch.messageIds,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const id of batch.messageIds) {
          this.#buffered.delete(id);
        }
        if (this.#running.get(handle)?.controller === controller) {
          this.#running.delete(handle);
        }
        const held = this.#pending.get(handle);
        if (held?.ripe) {
          this.#flush(handle);
        } else if (held) {
          // The settling run just cleared its typing indicator; re-show it
          // while the held batch waits out the rest of its debounce.
          this.#options.onWaiting?.(held.context);
        }
      });
    this.#running.set(handle, { controller, done });
  }
}
