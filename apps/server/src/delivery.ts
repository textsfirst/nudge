import type { Logger } from "@nudge/agent";
import type { NudgeStore, OutboundKind } from "@nudge/store";

const RECOVERED_PREFIX = "♻️ Recovered reply (may repeat):\n\n";
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface OutboundSender {
  sendToSpace(spaceId: string, text: string): Promise<void>;
}

/**
 * Ledger-backed at-least-once outbound delivery. Every proactive send is
 * journaled before it goes out; open entries (never started, or interrupted
 * mid-send) are retried by recover() — interrupted ones with an honest
 * "recovered" marker — bounded by the ledger's attempt and age limits.
 */
export class DeliveryService {
  #lastMaintenanceAt = 0;

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
      if (result.prunedOutbound > 0 || result.prunedWebhooks > 0) {
        this.logger.info("Pruned expired delivery bookkeeping", { ...result });
      }
    }
    for (const entry of this.store.openOutbound()) {
      const space = this.store.spaceFor(entry.handle);
      if (!space) continue;
      const body =
        entry.status === "sending" ? `${RECOVERED_PREFIX}${entry.body}` : entry.body;
      await this.#send(entry.id, space.spaceId, body);
    }
  }

  async #send(id: number, spaceId: string, body: string): Promise<boolean> {
    const attempt = this.store.markOutbound(id, "sending");
    try {
      await this.sender.sendToSpace(spaceId, body);
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
    }
  }
}
