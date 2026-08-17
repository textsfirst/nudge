import type { Logger } from "@nudge/agent";
import type { SendOptions } from "@nudge/photon";
import type { NudgeStore, OutboundKind } from "@nudge/store";

// Recovery notices read like a person whose text may not have gone through,
// not a system banner — the voice is the product, even on the failure path.
// Bubble-level ledger progress keeps them rare: only the one bubble that was
// mid-flight when the process died is ever ambiguous.
const RESEND_NOTICE = "not sure that went through, so again:";
const RESUME_NOTICE = "got cut off mid-text - here's the rest:";
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Ledger ids whose send is in flight in this process — recover() must not steal them. */
const liveSends = new Set<number>();

export function trackOutbound(id: number): () => void {
  liveSends.add(id);
  return () => {
    liveSends.delete(id);
  };
}

export interface OutboundSender {
  sendToSpace(spaceId: string, text: string, options?: SendOptions): Promise<void>;
}

/**
 * Ledger-backed at-least-once outbound delivery. Every proactive send is
 * journaled before it goes out and its progress recorded per bubble; open
 * entries are retried by recover() from the first unconfirmed bubble —
 * interrupted ones behind an honest, conversational notice — bounded by the
 * ledger's attempt and age limits.
 */
export class DeliveryService {
  #lastMaintenanceAt = 0;
  readonly #inflight = new Set<number>();

  constructor(
    private readonly store: NudgeStore,
    private readonly sender: OutboundSender,
    private readonly logger: Logger,
  ) {}

  /** Journal and send. Returns false when no space is known yet or the send failed. */
  async deliver(handle: string, body: string, kind: OutboundKind): Promise<boolean> {
    const space = this.store.spaceFor(handle);
    if (!space) {
      this.logger.warn("Cannot deliver yet: no space recorded for the handle", {
        handle,
        kind,
      });
      return false;
    }
    const id = this.store.enqueueOutbound(handle, body, kind);
    return this.#send(id, space.spaceId, body);
  }

  /** Retry open ledger entries. Called at boot and periodically. */
  async recover(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
      this.#lastMaintenanceAt = now;
      const result = this.store.maintain({ now });
      if (result.expiredOutbound > 0) {
        this.logger.error("Outbound messages exhausted the retry window", {
          count: result.expiredOutbound,
        });
      }
      if (result.prunedOutbound > 0 || result.prunedMessages > 0) {
        this.logger.info("Pruned expired delivery bookkeeping", { ...result });
      }
    }
    for (const entry of this.store.openOutbound()) {
      if (this.#inflight.has(entry.id) || liveSends.has(entry.id)) continue;
      const space = this.store.spaceFor(entry.handle);
      if (!space) continue;
      // A "sending" entry died mid-send: resume after the confirmed bubbles,
      // behind a notice, since the next bubble may already have arrived. A
      // "pending" entry never started — send it as-is, no notice.
      const options: SendOptions =
        entry.status === "sending"
          ? {
              skipChunks: entry.sentChunks,
              preamble: entry.sentChunks > 0 ? RESUME_NOTICE : RESEND_NOTICE,
            }
          : {};
      await this.#send(entry.id, space.spaceId, entry.body, options);
    }
  }

  async #send(
    id: number,
    spaceId: string,
    body: string,
    options: SendOptions = {},
  ): Promise<boolean> {
    if (this.#inflight.has(id)) return false;
    this.#inflight.add(id);
    const attempt = this.store.markOutbound(id, "sending");
    try {
      await this.sender.sendToSpace(spaceId, body, {
        ...options,
        onChunkSent: (sent) => this.store.markOutboundProgress(id, sent),
      });
      this.store.markOutbound(id, "sent");
      return true;
    } catch (error) {
      const exhausted = attempt >= 3;
      if (exhausted) this.store.markOutbound(id, "failed");
      this.logger.error(
        exhausted
          ? "Outbound send failed and exhausted its retry limit"
          : "Outbound send failed; the ledger will retry",
        {
          ledgerId: id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return false;
    } finally {
      this.#inflight.delete(id);
    }
  }
}
