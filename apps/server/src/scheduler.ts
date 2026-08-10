import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Logger, NudgeAgent } from "@nudge/agent";
import { nextRun, parseSchedule, type ScheduleEntry } from "@nudge/schedule";
import type { NudgeStore } from "@nudge/store";
import type { DeliveryService } from "./delivery.js";

export interface SchedulerOptions {
  schedulePath: string;
  ownerHandle: string;
  timeZone: string;
  store: NudgeStore;
  agent: NudgeAgent;
  delivery: DeliveryService;
  logger: Logger;
  tickMs?: number;
  now?: () => number;
}

/**
 * Executes SCHEDULE.md. Each tick re-reads the file when it changed (agent
 * tool writes and hand edits alike), then fires due entries as fresh one-shot
 * agent runs delivered through the ledger. Timing is computed deterministically
 * from the parsed grammar — the model is never consulted about "when".
 */
export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #tickMs: number;
  #entries: ScheduleEntry[] = [];
  #contentHash = "";
  #notifiedErrorHash = "";
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#tickMs = options.tickMs ?? 20_000;
  }

  start(): void {
    void this.tick();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#tickMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One scheduler pass. Public for tests; start() calls it on an interval. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#reload();
      const now = this.#now();
      for (const entry of this.#entries) {
        await this.#fireIfDue(entry, now);
      }
      await this.#options.delivery.recover();
    } finally {
      this.#ticking = false;
    }
  }

  async #fireIfDue(entry: ScheduleEntry, now: number): Promise<void> {
    const { store, agent, delivery, ownerHandle, timeZone, logger } = this.#options;
    const state = store.scheduleState(entry.id);
    if (state.completed) return;
    const after = new Date(state.lastRunAt ?? now);
    const due = nextRun(entry, after, timeZone);
    if (!due || due.getTime() > now) return;
    if (!store.claimScheduleRun(entry.id, now)) return;

    logger.info("Running scheduled entry", { entry: entry.name, due: due.toISOString() });
    try {
      const text = await agent.runTask(ownerHandle, entry.name, entry.prompt);
      if (text) {
        await delivery.deliver(ownerHandle, text, "nudge");
      } else {
        logger.debug("Scheduled entry chose to stay silent", { entry: entry.name });
      }
      store.finishScheduleRun(entry.id, now, entry.when.kind === "once");
    } catch (error) {
      logger.error("Scheduled entry failed; it will be retried at its next occurrence", {
        entry: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
      store.finishScheduleRun(entry.id, now, false);
    }
  }

  async #reload(): Promise<void> {
    const { schedulePath, store, logger } = this.#options;
    const content = existsSync(schedulePath) ? readFileSync(schedulePath, "utf8") : "";
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash === this.#contentHash) return;
    this.#contentHash = hash;

    const { entries, errors } = parseSchedule(content);
    this.#entries = entries;
    const now = this.#now();
    for (const entry of entries) {
      store.migrateScheduleState(entry.legacyId, entry.id);
      store.ensureScheduleBaseline(entry.id, now);
    }
    // A partially malformed file may omit entries only temporarily, so prune
    // orphaned state only after a completely valid parse.
    const prunedState = errors.length === 0
      ? store.pruneScheduleState(entries.map((entry) => entry.id))
      : 0;
    logger.info("Loaded schedule", {
      entries: entries.map((entry) => entry.name),
      errors: errors.length,
      prunedState,
    });

    if (errors.length > 0 && hash !== this.#notifiedErrorHash) {
      this.#notifiedErrorHash = hash;
      await this.#options.delivery.deliver(
        this.#options.ownerHandle,
        `Heads up — I couldn't read part of SCHEDULE.md, so these entries are inactive until fixed:\n${errors
          .map((error) => `• ${error}`)
          .join("\n")}`,
        "nudge",
      );
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
