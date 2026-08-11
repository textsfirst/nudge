// Deliberately only the `attachment` builder: spectrum's `voice()` (which
// sends a true iMessage voice message) must never enter this codebase —
// Nudge receives voice memos but never speaks.
import { attachment, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { splitMessage } from "./chunk.js";
import {
  InboundProcessor,
  type InboundBatch,
  type InboundLogger,
  type InboundMedia,
} from "./inbound.js";
import { TypingController } from "./typing.js";

export interface PhotonTransportConfig {
  projectId: string;
  projectSecret: string;
  webhookSecret: string;
  ownerHandle: string;
  /** Durable dedupe check for webhook redeliveries. */
  isDuplicate: (messageId: string) => boolean;
  /** Persist the freshest space id per handle for proactive sends. */
  rememberSpace: (handle: string, spaceId: string, platform: string) => void;
  /**
   * Handle one debounced inbound batch. `send` delivers text to the batch's
   * space, one paced bubble per paragraph (see splitMessage); a typing
   * indicator appears a humanizing beat after the first buffered text and
   * holds until the reply lands, so the wait reads as someone typing. The
   * signal aborts when a newer text arrives mid-run (steering) — abandon the
   * reply instead of sending it.
   */
  onBatch: (
    batch: InboundBatch,
    send: (text: string, options?: SendOptions) => Promise<void>,
    signal: AbortSignal,
    controls: BatchControls,
  ) => Promise<void>;
  debounceMs?: number;
  /**
   * Base pause between the bubbles of a multi-bubble send (default 500ms;
   * 0 disables pacing). Each pause grows with the length of the bubble it
   * precedes — see sendAll — so long bubbles read as typed, not pasted.
   */
  chunkDelayMs?: number;
  /**
   * Pause before the typing indicator appears (default 1100ms, jittered).
   * 0 restores the instant indicator.
   */
  typingDelayMs?: number;
  /** Mark the owner's texts read shortly after they arrive (default true). */
  readReceipts?: boolean;
  /** Randomness for choreography jitter; tests inject a fixed source. */
  random?: () => number;
  logLevel?: "debug" | "info" | "warn" | "error";
  logger: InboundLogger;
}

const DEFAULT_CHUNK_DELAY_MS = 500;
/** Simulated typing speed: extra pause per character of the upcoming bubble. */
const PACE_PER_CHAR_MS = 25;
/** Cap on the length-based extra for any single inter-bubble pause. */
const PACE_MAX_EXTRA_MS = 2_500;
/** Cap on the summed length-based extra across one send, so long replies don't drag. */
const PACE_TOTAL_EXTRA_CAP_MS = 4_000;
/** A read receipt lands 300–800ms after the text — seen, not machine-scanned. */
const READ_RECEIPT_MIN_DELAY_MS = 300;
const READ_RECEIPT_JITTER_MS = 500;

/** Levers on a text send, for ledger-tracked delivery and recovery. */
export interface SendOptions {
  /**
   * Resume a partially delivered message: skip this many leading bubbles of
   * the chunked text. Chunking is deterministic, so the indices are stable
   * across process restarts.
   */
  skipChunks?: number;
  /**
   * An extra bubble sent ahead of the content (a recovery notice). Skipped
   * entirely when every content bubble was already delivered, and excluded
   * from `onChunkSent` accounting.
   */
  preamble?: string;
  /**
   * Called after each content bubble lands, with the cumulative count of
   * delivered bubbles (skipped ones included).
   */
  onChunkSent?: (sent: number) => void;
}

/** Levers on the batch's space beyond plain text sends. */
export interface BatchControls {
  /**
   * Clear the typing indicator early — call it the moment the turn is known
   * to send nothing, so a deliberately silent reply doesn't read as typing
   * that trailed off. Fire-and-forget; failures are logged at debug.
   */
  stopTyping: () => void;
  /** Tapback the newest text of the batch with `emoji`. Rejects on failure. */
  react: (emoji: string) => Promise<void>;
  /**
   * Send a file to the batch's space. Rejects audio outright — Nudge never
   * sends voice messages — and anything outside the image/pdf/text allowlist.
   */
  sendAttachment: (data: Buffer, options: AttachmentSendOptions) => Promise<void>;
}

export interface AttachmentSendOptions {
  name: string;
  mimeType: string;
}

/**
 * What the agent may send. Audio is deliberately unmatchable — combined with
 * never importing spectrum's `voice()` builder, this is the structural
 * guarantee that Nudge cannot send voice messages.
 */
const OUTBOUND_MIME_ALLOWLIST: readonly RegExp[] = [
  /^image\//,
  /^application\/pdf$/,
  /^text\//,
];

export interface RawWebhookRequest {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PhotonTransport {
  webhook(request: RawWebhookRequest): Promise<WebhookResponse>;
  /** Proactively send to a space persisted from an earlier inbound message. */
  sendToSpace(spaceId: string, text: string, options?: SendOptions): Promise<void>;
  flushInbound(): Promise<void>;
  stop(): Promise<void>;
}

interface SendableSpace {
  id: string;
  send(text: string): Promise<unknown>;
  startTyping(): Promise<unknown>;
  stopTyping(): Promise<unknown>;
}

interface ReactableMessage {
  react(emoji: string): Promise<unknown>;
  /** Marks the chat read on iMessage; optional so lean test doubles still fit. */
  read?: () => Promise<unknown>;
}

export async function createPhotonTransport(
  config: PhotonTransportConfig,
): Promise<PhotonTransport> {
  // spectrum-ts 12.7's public iMessage definition loses its config type through
  // an Omit intersection. The documented zero-argument call is correct at runtime.
  const provider = (
    imessage.config as unknown as () => ReturnType<typeof imessage.config>
  )();
  const spectrum = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    webhookSecret: config.webhookSecret,
    providers: [provider],
    options: { logLevel: config.logLevel ?? "info" },
  });

  const random = config.random ?? Math.random;
  const typing = new TypingController({
    logger: config.logger,
    ...(config.typingDelayMs !== undefined ? { startDelayMs: config.typingDelayMs } : {}),
    random,
  });

  // Bubbles are paced, not fired back-to-back, so a multi-bubble reply lands
  // like someone texting: each pause grows with the bubble it precedes, and
  // the typing indicator is re-shown through it (delivering a bubble clears
  // the indicator client-side), so the gaps read as typing, not silence.
  const chunkDelayMs = config.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
  const sendAll = async (
    space: SendableSpace,
    text: string,
    options: SendOptions = {},
  ): Promise<void> => {
    const skip = options.skipChunks ?? 0;
    const pending = splitMessage(text).slice(skip);
    let sent = skip;
    let first = true;
    let extraBudget = PACE_TOTAL_EXTRA_CAP_MS;
    let paused = false;
    if (options.preamble && pending.length > 0) {
      await space.send(options.preamble);
      first = false;
    }
    for (const chunk of pending) {
      if (!first && chunkDelayMs > 0) {
        const extra = Math.min(chunk.length * PACE_PER_CHAR_MS, PACE_MAX_EXTRA_MS, extraBudget);
        extraBudget -= extra;
        paused = true;
        typing.assert(space);
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs + extra));
      }
      first = false;
      await space.send(chunk);
      options.onChunkSent?.(++sent);
    }
    // The indicator asserted for a pause must not outlive the last bubble.
    if (paused) {
      typing.stop(space);
    }
  };

  // The single chokepoint every outbound attachment passes through — the
  // MIME gate lives here so no future send path can bypass it.
  const sendAttachmentTo = async (
    space: SendableSpace,
    data: Buffer,
    options: AttachmentSendOptions,
  ): Promise<void> => {
    const mime = options.mimeType.toLowerCase();
    if (mime.startsWith("audio/")) {
      throw new Error("Refusing to send audio: Nudge never sends voice messages");
    }
    if (!OUTBOUND_MIME_ALLOWLIST.some((pattern) => pattern.test(mime))) {
      throw new Error(`Refusing to send unsupported attachment type "${options.mimeType}"`);
    }
    // SendableSpace narrows the real space to text sends; the underlying
    // spectrum space accepts ContentBuilder inputs.
    await (space as { send(content: unknown): Promise<unknown> }).send(
      attachment(data, { mimeType: options.mimeType, name: options.name }),
    );
  };

  // The context tracks the batch's newest message so reactions land on the
  // text the owner sent last, not an id lookup after the fact.
  const processor = new InboundProcessor<{ space: SendableSpace; message: ReactableMessage }>({
    ownerHandle: config.ownerHandle,
    logger: config.logger,
    isDuplicate: config.isDuplicate,
    ...(config.debounceMs !== undefined ? { debounceMs: config.debounceMs } : {}),
    // A buffered text schedules the indicator after the humanizing delay —
    // a beat of "they saw it" before "they're typing". Idempotent, so
    // follow-up texts and steering re-fires never reset the clock.
    onWaiting: ({ space }) => {
      typing.schedule(space);
    },
    // The settle-path stop replaces `spectrum.responding` (which would show
    // the indicator instantly, defeating the delay); like it, the finally
    // guarantees no indicator outlives its batch.
    onBatch: async (batch, context, signal) => {
      try {
        await config.onBatch(
          batch,
          (text, options) => sendAll(context.space, text, options),
          signal,
          {
            stopTyping: () => {
              typing.stop(context.space);
            },
            react: async (emoji) => {
              await context.message.react(emoji);
            },
            sendAttachment: (data, attachmentOptions) =>
              sendAttachmentTo(context.space, data, attachmentOptions),
          },
        );
      } finally {
        typing.stop(context.space);
      }
    },
  });

  return {
    async webhook(request) {
      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
        ),
      );
      return spectrum.webhook({ body: request.body, headers }, async (space, message) => {
        const sender = message.sender?.id;
        const parts = extractParts(message.content);
        if (!parts || !sender) {
          config.logger.warn("Ignoring a Photon message with an unsupported payload", {
            messageId: message.id,
            contentType: message.content.type,
            senderPresent: Boolean(sender),
          });
          return;
        }
        if (message.platform.toLowerCase() === "imessage" && sender === config.ownerHandle) {
          config.rememberSpace(sender, space.id, message.platform);
          // Surface a read receipt a jittered beat after the text arrives —
          // "seen" comes before "typing" in the human rhythm. Best-effort,
          // like every indicator signal.
          if (config.readReceipts !== false && typeof message.read === "function") {
            const readTimer = setTimeout(
              () => {
                void message.read?.().catch((error: unknown) => {
                  config.logger.debug("Failed to send a read receipt", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                });
              },
              READ_RECEIPT_MIN_DELAY_MS + random() * READ_RECEIPT_JITTER_MS,
            );
            readTimer.unref?.();
          }
        }
        processor.process(
          {
            id: message.id,
            handle: sender,
            text: parts.text,
            spaceId: space.id,
            platform: message.platform,
            ...(parts.media.length > 0 ? { media: parts.media } : {}),
          },
          { space, message },
        );
      });
    },

    async sendToSpace(spaceId, text, options) {
      // The platform instance comes from calling the narrower with the
      // spectrum instance — the instance itself exposes no per-platform
      // property (unknown props resolve to custom event streams).
      const space = await imessage(spectrum).space.get(spaceId);
      await sendAll(space, text, options);
    },

    flushInbound: () => processor.flushNow(),

    async stop() {
      await processor.flushNow();
      typing.clear();
      await spectrum.stop();
    },
  };
}

interface ExtractedParts {
  text: string;
  media: InboundMedia[];
}

/**
 * Normalize a provider message content into text plus lazy media handles.
 * A `group` (text sent with attachments) is flattened in item order; sub-items
 * we don't support (contacts, reactions, …) are skipped, and a message whose
 * content is entirely unsupported yields undefined so the caller keeps the
 * existing warn-and-drop.
 */
function extractParts(content: unknown): ExtractedParts | undefined {
  if (content === null || typeof content !== "object") return undefined;
  const item = content as Record<string, unknown>;
  switch (item.type) {
    case "text":
      return typeof item.text === "string" ? { text: item.text, media: [] } : undefined;
    case "attachment":
    case "voice": {
      if (typeof item.mimeType !== "string" || typeof item.read !== "function") {
        return undefined;
      }
      const isVoice = item.type === "voice";
      const name =
        typeof item.name === "string" && item.name.length > 0
          ? item.name
          : isVoice
            ? "voice-memo.caf"
            : "attachment";
      return {
        text: "",
        media: [
          {
            kind: isVoice
              ? "voice"
              : item.mimeType.toLowerCase().startsWith("image/")
                ? "image"
                : "file",
            name,
            mimeType: item.mimeType,
            ...(typeof item.size === "number" ? { sizeBytes: item.size } : {}),
            ...(isVoice && typeof item.duration === "number"
              ? { durationSeconds: item.duration }
              : {}),
            read: item.read as () => Promise<Buffer>,
          },
        ],
      };
    }
    case "group": {
      if (!Array.isArray(item.items)) return undefined;
      const texts: string[] = [];
      const media: InboundMedia[] = [];
      let supported = false;
      for (const sub of item.items) {
        const parts = extractParts((sub as { content?: unknown } | null)?.content);
        if (!parts) continue;
        supported = true;
        if (parts.text.length > 0) texts.push(parts.text);
        media.push(...parts.media);
      }
      return supported ? { text: texts.join("\n"), media } : undefined;
    }
    default:
      return undefined;
  }
}
