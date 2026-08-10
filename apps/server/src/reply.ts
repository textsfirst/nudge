import type { Logger } from "@nudge/agent";
import type { InboundBatch } from "@nudge/photon";
import type { NudgeStore } from "@nudge/store";

const APOLOGY = "Sorry — something went wrong on my end. Mind sending that again?";

export interface ReplyAgent {
  reply(
    handle: string,
    text: string,
    options?: { abortSignal?: AbortSignal },
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
}): (batch: InboundBatch, send: (text: string) => Promise<void>, signal: AbortSignal) => Promise<void> {
  const { agent, store, logger } = deps;
  return async (batch, send, signal) => {
    try {
      const reply = await agent.reply(batch.handle, batch.texts.join("\n"), {
        abortSignal: signal,
      });
      if (reply) {
        const ledgerId = store.enqueueOutbound(batch.handle, reply, "reply");
        store.markOutbound(ledgerId, "sending");
        await send(reply);
        store.markOutbound(ledgerId, "sent");
      }
    } catch (error) {
      if (signal.aborted) {
        logger.info("Reply superseded by a newer message; folding it into the next turn", {
          messageIds: batch.messageIds,
        });
        return;
      }
      logger.error("Reply generation failed", {
        messageIds: batch.messageIds,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await send(APOLOGY);
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
