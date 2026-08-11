import { SubscriptionAuthError, type Logger, type MediaIngest, type ReplyInput } from "@nudge/agent";
import type { BatchControls, InboundBatch, SendOptions } from "@nudge/photon";
import type { NudgeStore } from "@nudge/store";

const APOLOGY = "Sorry, I hit a snag on my end. Mind sending that again?";

export interface ReplyAgent {
  reply(
    handle: string,
    input: string | ReplyInput,
    options?: {
      abortSignal?: AbortSignal;
      onProgress?: (text: string) => Promise<void>;
      onReaction?: (emoji: string) => void;
      onSilent?: () => void;
      onReplyReady?: (text: string) => Promise<void>;
    },
  ): Promise<string | null>;
}

/**
 * The inbound-batch handler: generate a reply, journal it, send it. A steering
 * abort (a newer text superseded this run) is not a failure — the owner's
 * message is already in history and the next batch answers it, so send
 * nothing. Real failures get the apology. Either way the webhook ids are
 * marked processed: the texts themselves are persisted before generation.
 */
export function createReplyHandler(deps: {
  agent: ReplyAgent;
  store: NudgeStore;
  logger: Logger;
  /** Absent (multimodal off) → inbound media is ignored, as before. */
  media?: MediaIngest;
}): (
  batch: InboundBatch,
  send: (text: string, options?: SendOptions) => Promise<void>,
  signal: AbortSignal,
  controls?: BatchControls,
) => Promise<void> {
  const { agent, store, logger, media } = deps;
  return async (batch, send, signal, controls) => {
    let delivered = false;
    const deliver = async (reply: string): Promise<void> => {
      signal.throwIfAborted();
      const ledgerId = store.enqueueOutbound(batch.handle, reply, "reply");
      store.markOutbound(ledgerId, "sending");
      // Per-bubble progress keeps a crash mid-reply from replaying bubbles
      // that already landed: recovery resumes at the first unconfirmed one.
      await send(reply, {
        onChunkSent: (sent) => store.markOutboundProgress(ledgerId, sent),
      });
      store.markOutbound(ledgerId, "sent");
      delivered = true;
      controls?.stopTyping();
    };
    try {
      const input = await composeInput(batch, media, logger);
      // A bare media message with multimodal disabled composes to nothing —
      // restore the old drop behavior instead of running a turn on emptiness.
      if (typeof input === "string" && input.length === 0) {
        logger.info("Skipping a batch with no usable content", {
          messageIds: batch.messageIds,
        });
        controls?.stopTyping();
        return;
      }
      const reply = await agent.reply(batch.handle, input, {
        abortSignal: signal,
        // Progress texts are best-effort and skip the outbound ledger:
        // recovery re-sending a stale "checking…" line later would be wrong.
        // The audit trail is the turn's tool payload.
        onProgress: async (update) => {
          if (signal.aborted) return;
          logger.info("Sending a mid-turn progress update", { handle: batch.handle });
          await send(update);
        },
        // Reactions are best-effort like progress texts and skip the ledger:
        // recovery replaying a stale tapback later would be wrong. The thread
        // remembers it through the persisted [REACT] token.
        onReaction: (emoji) => {
          if (signal.aborted) return;
          logger.info("Reacting to the owner's message", { handle: batch.handle, emoji });
          void controls?.react(emoji).catch((error: unknown) => {
            logger.warn("Failed to send the reaction", {
              handle: batch.handle,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        // File sends ride the same best-effort contract as progress texts:
        // no ledger (recovery re-sending a stale image later would be wrong),
        // and a steered turn stops sending. Only offered when multimodal is
        // on — the tool's absence is what keeps text-only setups unchanged.
        ...(media && controls?.sendAttachment
          ? {
              onSendFile: async (data: Buffer, options: { name: string; mimeType: string }) => {
                signal.throwIfAborted();
                logger.info("Sending the owner a file", {
                  handle: batch.handle,
                  name: options.name,
                  mimeType: options.mimeType,
                });
                await controls.sendAttachment(data, options);
              },
            }
          : {}),
        // A silent turn sends nothing: clear the typing indicator the moment
        // that's known instead of letting it linger through the turn's tail.
        onSilent: () => controls?.stopTyping(),
        // Delivery belongs on the critical path; compaction does not. The
        // concrete agent fires this after persistence and before housekeeping.
        onReplyReady: deliver,
      });
      // Keep compatibility with alternate/test agents that return a reply but
      // do not implement the readiness callback.
      if (reply && !delivered) {
        await deliver(reply);
      }
    } catch (error) {
      if (signal.aborted) {
        logger.info("Reply superseded by a newer message; folding it into the next turn", {
          messageIds: batch.messageIds,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Reply generation failed", { messageIds: batch.messageIds, error: message });
      // Journal the failure into the thread so the console shows what went
      // wrong. The agent keeps error rows out of the model's context.
      const session = store.activeSession(batch.handle);
      if (session) {
        store.appendMessage({
          sessionId: session.id,
          handle: batch.handle,
          role: "error",
          content: message,
        });
      }
      try {
        await send(
          error instanceof SubscriptionAuthError
            ? `My ChatGPT sign-in needs attention. ${error.message}`
            : APOLOGY,
        );
      } catch {
        logger.error("Even the apology failed to send", { messageIds: batch.messageIds });
      }
    } finally {
      for (const messageId of batch.messageIds) {
        store.markWebhookProcessed(messageId);
      }
    }
  };
}

/**
 * Fold the batch's media into the turn: bytes are persisted and transcribed
 * (deliberately not steerable — a newer text must not drop the owner's photo),
 * and the projections join the text so the thread records what arrived.
 */
async function composeInput(
  batch: InboundBatch,
  media: MediaIngest | undefined,
  logger: Logger,
): Promise<string | ReplyInput> {
  const text = batch.texts.filter((part) => part.trim().length > 0).join("\n");
  if (batch.media.length === 0 || !media) {
    if (batch.media.length > 0) {
      logger.warn("Ignoring inbound media because multimodal is disabled", {
        count: batch.media.length,
      });
    }
    return text;
  }
  const ingested = await media.ingest(batch.handle, batch.media, batch.messageIds.at(-1));
  const combined = [text, ...ingested.projections].filter((part) => part.length > 0).join("\n");
  return { text: combined, media: ingested.refs };
}
