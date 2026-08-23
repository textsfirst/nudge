import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Logger, NudgeAgent } from "@nudge/agent";
import { nextRun, parseSchedule, type ScheduleEntry } from "@nudge/schedule";
import type { NudgeStore } from "@nudge/store";
import type { DeliveryService } from "./delivery.js";

/** One watcher-check execution: ok mirrors the command's exit status. */
export interface CheckResult {
  ok: boolean;
  output: string;
}

export type CheckRunner = (command: string) => Promise<CheckResult>;

/** A hung check must not stall the tick loop. */
const CHECK_TIMEOUT_MS = 30_000;
/** Collection cap — a runaway check's output is cut, not buffered. */
const CHECK_OUTPUT_MAX_BYTES = 64 * 1024;
/** Check output embedded into a wake brief is capped head-and-tail. */
const CHECK_BRIEF_MAX_CHARS = 4_000;

/**
 * The default check runner: bash with the agent's own environment (gws and
 * mcp on PATH, secrets from .env), the data directory as cwd. Output is
 * stdout+stderr combined — checks are diffed, not parsed, so interleaving
 * is fine.
 */
export function buildCheckRunner(options: {
  cwd: string;
  env?: Record<string, string> | undefined;
}): CheckRunner {
  return (command) =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let output = "";
      let truncated = false;
      const collect = (chunk: Buffer) => {
        if (output.length >= CHECK_OUTPUT_MAX_BYTES) {
          truncated = true;
          return;
        }
        output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const killCheck = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        killCheck();
        resolve({ ok: false, output: `check timed out after ${CHECK_TIMEOUT_MS / 1000}s` });
      }, CHECK_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, output: error.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const text = truncated ? `${output}\n[output truncated]` : output;
        resolve(
          code === 0
            ? { ok: true, output: text }
            : { ok: false, output: `exit ${code ?? "?"}: ${text}`.trim() },
        );
      });
    });
}

export interface SchedulerOptions {
  schedulePath: string;
  ownerHandle: string;
  timeZone: string;
  store: NudgeStore;
  agent: NudgeAgent;
  delivery: DeliveryService;
  logger: Logger;
  /** Executes check: commands; tests inject a fake. */
  runCheck?: CheckRunner;
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
  readonly #check: CheckRunner;
  #entries: ScheduleEntry[] = [];
  #contentHash = "";
  #notifiedErrorHash = "";
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#tickMs = options.tickMs ?? 20_000;
    this.#check = options.runCheck ?? buildCheckRunner({ cwd: process.cwd() });
  }

  start(): void {
    const run = () => {
      void this.tick().catch((error: unknown) => {
        this.#options.logger.error("Scheduler tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    run();
    this.#timer = setInterval(run, this.#tickMs);
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
    if (!store.spaceFor(ownerHandle)) return;
    if (!store.claimScheduleRun(entry.id, now)) return;

    logger.info("Running scheduled entry", {
      entry: entry.name,
      due: due.toISOString(),
      ...(entry.agent ? { agent: entry.agent } : {}),
      ...(entry.check ? { check: true } : {}),
    });
    try {
      if (entry.agent) {
        // Watcher gate: the check runs first, and an unchanged output means
        // nobody wakes — the firing costs a subprocess, not a model turn.
        let prompt = entry.prompt;
        let pendingHash: string | undefined;
        if (entry.check) {
          const gate = await this.#runCheckGate(entry.id, entry.check, now);
          if (!gate.wake) {
            store.finishScheduleRun(entry.id, now, false);
            return;
          }
          prompt = `${entry.prompt}\n\n${gate.briefSuffix}`;
          pendingHash = gate.pendingHash;
        }
        // Agent-scoped: the named standing agent runs the entry with its
        // accumulated memory, and its report reaches the owner through the
        // interaction loop's curation — no direct delivery from here.
        await agent.runAgentTask(ownerHandle, entry.name, prompt, entry.agent);
        if (pendingHash && entry.check) {
          store.recordScheduleCheck(
            entry.id,
            { hash: pendingHash, changed: true, woke: true, command: entry.check },
            now,
          );
        }
      } else {
        const text = await agent.runTask(ownerHandle, entry.name, entry.prompt);
        if (text) {
          await delivery.deliver(ownerHandle, text, "nudge");
        } else {
          logger.debug("Scheduled entry chose to stay silent", { entry: entry.name });
        }
      }
      store.finishScheduleRun(entry.id, now, entry.when.kind === "once");
    } catch (error) {
      logger.error("Scheduled entry failed; it will be retried at its next occurrence", {
        entry: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
      if (entry.when.kind === "once") {
        // Leave the claim; the 10-minute stale steal is the retry, not every tick.
        return;
      }
      store.finishScheduleRun(entry.id, now, false);
    }
  }

  /**
   * Run an entry's check and decide whether to wake its agent. Wake on a
   * changed output or a failed command (a watcher that breaks must surface,
   * not go dark); stay silent on the first sight (baseline), on an unchanged
   * output, and on the first run of an edited check command — a hash is only
   * comparable to output of the same command, so an edit re-baselines instead
   * of waking the agent on an apples-to-oranges diff. Health counters land in
   * schedule_state either way.
   */
  async #runCheckGate(
    entryId: string,
    command: string,
    now: number,
  ): Promise<{ wake: false } | { wake: true; briefSuffix: string; pendingHash?: string }> {
    const { store, logger } = this.#options;
    const state = store.scheduleState(entryId);
    let result: CheckResult;
    try {
      result = await this.#check(command);
    } catch (error) {
      result = { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) {
      const output = capForBrief(result.output) || "(no output)";
      store.recordScheduleCheck(entryId, { error: output, woke: true, command }, now);
      logger.warn("A watcher check failed; waking its agent with the error", { entryId });
      return {
        wake: true,
        briefSuffix:
          "[This watcher's check command failed instead of producing output. Diagnose it — " +
          "and if you cannot, report it so the owner hears the watcher is broken:]\n" +
          output,
      };
    }
    const normalized = result.output.trim();
    const hash = createHash("sha256").update(normalized).digest("hex");
    if (state.lastCheckHash === null || state.lastCheckCommand !== command) {
      // First sight — of the entry or of an edited check command: baseline
      // silently, mirroring the scheduler's no-back-fill rule.
      store.recordScheduleCheck(entryId, { hash, command }, now);
      logger.info(
        state.lastCheckHash === null
          ? "Watcher baseline recorded"
          : "Watcher check command changed; re-baselined",
        { entryId },
      );
      return { wake: false };
    }
    if (state.lastCheckHash === hash) {
      store.recordScheduleCheck(entryId, { hash, command }, now);
      return { wake: false };
    }
    return {
      wake: true,
      pendingHash: hash,
      briefSuffix:
        "[This watcher's check output changed since the last run. Current output:]\n" +
        (capForBrief(normalized) || "(empty)"),
    };
  }

  async #reload(): Promise<void> {
    const { schedulePath, store, logger } = this.#options;
    let content = "";
    try {
      content = existsSync(schedulePath) ? readFileSync(schedulePath, "utf8") : "";
    } catch (error) {
      logger.error("Could not read SCHEDULE.md", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
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
    // orphaned state only after a completely valid parse that still has entries.
    // An empty file must not wipe completed one-shot identity.
    const prunedState =
      errors.length === 0 && entries.length > 0
        ? store.pruneScheduleState(entries.map((entry) => entry.id))
        : 0;
    logger.info("Loaded schedule", {
      entries: entries.map((entry) => entry.name),
      errors: errors.length,
      prunedState,
    });

    if (errors.length > 0 && hash !== this.#notifiedErrorHash) {
      const sent = await this.#options.delivery.deliver(
        this.#options.ownerHandle,
        `Heads up — I couldn't read part of SCHEDULE.md, so these entries are inactive until fixed:\n${errors
          .map((error) => `• ${error}`)
          .join("\n")}`,
        "nudge",
      );
      if (sent) this.#notifiedErrorHash = hash;
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

/** Head-and-tail cap for check output embedded in a wake brief. */
function capForBrief(text: string): string {
  if (text.length <= CHECK_BRIEF_MAX_CHARS) return text;
  const head = Math.floor(CHECK_BRIEF_MAX_CHARS * 0.7);
  const tail = CHECK_BRIEF_MAX_CHARS - head;
  return `${text.slice(0, head)}\n…[${text.length - CHECK_BRIEF_MAX_CHARS} chars omitted]…\n${text.slice(-tail)}`;
}
