import type { Logger } from "@nudge/agent";
import type { NudgeStore, OutboundKind } from "@nudge/store";

const RECOVERED_PREFIX = "♻️ Recovered reply (may repeat):\n\n";

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
    for (const entry of this.store.openOutbound()) {
      const space = this.store.spaceFor(entry.handle);
      if (!space) continue;
      const body =
        entry.status === "sending" ? `${RECOVERED_PREFIX}${entry.body}` : entry.body;
      await this.#send(entry.id, space.spaceId, body);
    }
  }

  async #send(id: number, spaceId: string, body: string): Promise<boolean> {
    this.store.markOutbound(id, "sending");
    try {
      await this.sender.sendToSpace(spaceId, body);
      this.store.markOutbound(id, "sent");
      return true;
    } catch (error) {
      this.logger.error("Outbound send failed; the ledger will retry", {
        ledgerId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
