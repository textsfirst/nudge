import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { splitMessage } from "./chunk.js";
import {
  InboundProcessor,
  type InboundBatch,
  type InboundLogger,
} from "./inbound.js";

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
   * indicator shows from the first buffered text
   * until the reply lands, so the debounce never reads as silence. The
   * signal aborts when a newer text arrives mid-run (steering) — abandon the
   * reply instead of sending it.
   */
  onBatch: (
    batch: InboundBatch,
    send: (text: string) => Promise<void>,
    signal: AbortSignal,
    controls: BatchControls,
  ) => Promise<void>;
  debounceMs?: number;
  /** Pause between the bubbles of a multi-bubble send (default 500ms; 0 disables). */
  chunkDelayMs?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  logger: InboundLogger;
}

const DEFAULT_CHUNK_DELAY_MS = 500;

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
}

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
  sendToSpace(spaceId: string, text: string): Promise<void>;
  flushInbound(): Promise<void>;
  stop(): Promise<void>;
}

interface SendableSpace {
  send(text: string): Promise<unknown>;
  startTyping(): Promise<unknown>;
  stopTyping(): Promise<unknown>;
}

interface ReactableMessage {
  react(emoji: string): Promise<unknown>;
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

  // Bubbles are paced, not fired back-to-back, so a multi-bubble reply lands
  // like someone texting. The reply path holds its typing indicator through
  // the pauses, so the gaps read as typing, not silence.
  const chunkDelayMs = config.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
  const sendAll = async (space: SendableSpace, text: string): Promise<void> => {
    let first = true;
    for (const chunk of splitMessage(text)) {
      if (!first && chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
      }
      first = false;
      await space.send(chunk);
    }
  };

  // The context tracks the batch's newest message so reactions land on the
  // text the owner sent last, not an id lookup after the fact.
  const processor = new InboundProcessor<{ space: SendableSpace; message: ReactableMessage }>({
    ownerHandle: config.ownerHandle,
    logger: config.logger,
    isDuplicate: config.isDuplicate,
    ...(config.debounceMs !== undefined ? { debounceMs: config.debounceMs } : {}),
    // Typing shows as soon as a text starts buffering; `responding` below
    // keeps it on through generation, so the indicator never gaps.
    onWaiting: ({ space }) => {
      void space.startTyping().catch((error: unknown) => {
        config.logger.debug("Failed to show a typing indicator", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // `responding` re-sends its own typing("stop") when the handler settles;
    // an early stop inside it just clears the indicator sooner.
    onBatch: (batch, context, signal) =>
      spectrum.responding(context.space as never, () =>
        config.onBatch(batch, (text) => sendAll(context.space, text), signal, {
          stopTyping: () => {
            void context.space.stopTyping().catch((error: unknown) => {
              config.logger.debug("Failed to clear the typing indicator", {
                error: error instanceof Error ? error.message : String(error),
              });
            });
          },
          react: async (emoji) => {
            await context.message.react(emoji);
          },
        }),
      ),
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
        if (message.content.type !== "text" || !sender) {
          config.logger.warn("Ignoring a Photon message with an unsupported payload", {
            messageId: message.id,
            contentType: message.content.type,
            senderPresent: Boolean(sender),
          });
          return;
        }
        if (message.platform.toLowerCase() === "imessage" && sender === config.ownerHandle) {
          config.rememberSpace(sender, space.id, message.platform);
        }
        processor.process(
          {
            id: message.id,
            handle: sender,
            text: message.content.text,
            spaceId: space.id,
            platform: message.platform,
          },
          { space, message },
        );
      });
    },

    async sendToSpace(spaceId, text) {
      // The platform instance comes from calling the narrower with the
      // spectrum instance — the instance itself exposes no per-platform
      // property (unknown props resolve to custom event streams).
      const space = await imessage(spectrum).space.get(spaceId);
      await sendAll(space, text);
    },

    flushInbound: () => processor.flushNow(),

    async stop() {
      await processor.flushNow();
      await spectrum.stop();
    },
  };
}
