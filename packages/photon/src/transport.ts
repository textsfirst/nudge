import {
  Spectrum,
  type AnyPlatformDef,
  type PlatformProviderConfig,
} from "@spectrum-ts/core";
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
   * Handle one debounced inbound batch. `send` chunks and delivers text to
   * the batch's space; a typing indicator shows while the handler runs. The
   * signal aborts when a newer text arrives mid-run (steering) — abandon the
   * reply instead of sending it.
   */
  onBatch: (
    batch: InboundBatch,
    send: (text: string) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>;
  debounceMs?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  logger: InboundLogger;
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
}

export async function createPhotonTransport(
  config: PhotonTransportConfig,
): Promise<PhotonTransport> {
  // spectrum-ts 12.7's public iMessage definition loses its config type through
  // an Omit intersection. The documented zero-argument call is correct at runtime.
  const provider = (
    imessage.config as unknown as () => PlatformProviderConfig<AnyPlatformDef>
  )();
  const spectrum = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    webhookSecret: config.webhookSecret,
    providers: [provider],
    options: { logLevel: config.logLevel ?? "info" },
  });

  const sendAll = async (space: SendableSpace, text: string): Promise<void> => {
    for (const chunk of splitMessage(text)) {
      await space.send(chunk);
    }
  };

  const processor = new InboundProcessor<{ space: SendableSpace }>({
    ownerHandle: config.ownerHandle,
    logger: config.logger,
    isDuplicate: config.isDuplicate,
    ...(config.debounceMs !== undefined ? { debounceMs: config.debounceMs } : {}),
    onBatch: (batch, context, signal) =>
      spectrum.responding(context.space as never, () =>
        config.onBatch(batch, (text) => sendAll(context.space, text), signal),
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
          config.logger.debug("Ignoring a non-text Photon message", {
            messageId: message.id,
            contentType: message.content.type,
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
          { space },
        );
      });
    },

    async sendToSpace(spaceId, text) {
      const instance = (spectrum as unknown as Record<string, unknown>).imessage as
        | { space: { get(id: string): Promise<SendableSpace> } }
        | undefined;
      if (!instance?.space?.get) {
        throw new Error("The spectrum iMessage instance does not expose space.get");
      }
      const space = await instance.space.get(spaceId);
      await sendAll(space, text);
    },

    flushInbound: () => processor.flushNow(),

    async stop() {
      await processor.flushNow();
      await spectrum.stop();
    },
  };
}
