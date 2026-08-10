import { SubscriptionAuthError, type Logger } from "@nudge/agent";
import type { BatchControls, InboundBatch } from "@nudge/photon";
import type { NudgeStore } from "@nudge/store";

const APOLOGY = "Sorry, I hit a snag on my end. Mind sending that again?";

export interface ReplyAgent {
  reply(
    handle: string,
    text: string,
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
}): (
  batch: InboundBatch,
  send: (text: string) => Promise<void>,
  signal: AbortSignal,
  controls?: BatchControls,
) => Promise<void> {
  const { agent, store, logger } = deps;
  return async (batch, send, signal, controls) => {
    let delivered = false;
    const deliver = async (reply: string): Promise<void> => {
      signal.throwIfAborted();
      const ledgerId = store.enqueueOutbound(batch.handle, reply, "reply");
      store.markOutbound(ledgerId, "sending");
      await send(reply);
      store.markOutbound(ledgerId, "sent");
      delivered = true;
      controls?.stopTyping();
    };
    try {
      const reply = await agent.reply(batch.handle, batch.texts.join("\n"), {
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
