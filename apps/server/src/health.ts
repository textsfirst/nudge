import {
  ChatGptAuthManager,
  GrokAuthManager,
  SubscriptionAuthError,
  type Logger,
} from "@nudge/agent";
import type { NudgeStore } from "@nudge/store";
import { probeGoogleAccount, readGoogleAccounts } from "./google.js";
import type { DeliveryService } from "./delivery.js";

/**
 * One probed connection. `healthy: null` means "could not tell" (network
 * trouble, transient errors) — state is left untouched so nobody gets texted
 * over a flaky link.
 */
export interface ProbeResult {
  id: string;
  healthy: boolean | null;
  /** Texted to the owner when this connection goes healthy → broken. */
  brokenMessage: string;
}

export interface HealthMonitorOptions {
  store: NudgeStore;
  delivery: DeliveryService;
  ownerHandle: string;
  logger: Logger;
  probes: () => Promise<ProbeResult[]>;
  /** Default: daily. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * Google refresh tokens and ChatGPT auth die asynchronously — consent-screen
 * expiry, password changes, revocation. Without a push notice the failure
 * surfaces at the worst moment: a scheduled briefing that needed Calendar just
 * errors. So: probe daily, and text the owner exactly once per healthy→broken
 * transition. Recovery (a reconnect) is recorded silently.
 */
export class ConnectionHealthMonitor {
  readonly #options: HealthMonitorOptions;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: HealthMonitorOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  }

  start(): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One probe pass. Public for tests; start() runs it on the interval. */
  async check(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const { store, delivery, ownerHandle, logger } = this.#options;
    try {
      const results = await this.#options.probes();
      for (const result of results) {
        if (result.healthy === null) continue;
        const previous = store.connectionHealthy(result.id);
        if (result.healthy) {
          store.setConnectionHealthy(result.id, true, this.#now());
          continue;
        }
        if (previous === false) continue; // already known-broken; never nag
        logger.warn("Connection is broken; notifying the owner", { connection: result.id });
        const sent = await delivery.deliver(ownerHandle, result.brokenMessage, "nudge");
        // Not marking broken on a failed send keeps the next pass retrying.
        if (sent) store.setConnectionHealthy(result.id, false, this.#now());
      }
    } catch (error) {
      logger.warn("Connection health check failed; will retry next pass", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running = false;
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

/**
 * The standard probe set: every connected Google account, plus the selected
 * subscription provider's auth (ChatGPT or Grok).
 */
export function buildConnectionProbes(input: {
  dataDir: string;
  chatGptAuthFile?: string;
  grokAuthFile?: string;
  fetch?: typeof globalThis.fetch;
}): () => Promise<ProbeResult[]> {
  return async () => {
    const results: ProbeResult[] = [];

    for (const account of readGoogleAccounts(input.dataDir)) {
      const status = await probeGoogleAccount(input.dataDir, account.label, input.fetch);
      results.push({
        id: `google:${account.label}`,
        healthy: status === "ok" ? true : status === "unreachable" ? null : false,
        brokenMessage:
          `Heads up — my access to your Google account “${account.label}” (${account.email}) ` +
          "has expired. Reconnect it in the console (Connections page) and I'll pick things back up.",
      });
    }

    if (input.chatGptAuthFile) {
      const authFile = input.chatGptAuthFile;
      results.push({
        id: "chatgpt",
        healthy: await probeSubscription(() =>
          new ChatGptAuthManager({
            authFile,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          }).credentials(),
        ),
        brokenMessage:
          "Heads up — my ChatGPT sign-in has stopped working, so I may not be able to reply " +
          "soon. Reconnect it in the console (Connections page).",
      });
    }

    if (input.grokAuthFile) {
      const authFile = input.grokAuthFile;
      results.push({
        id: "grok",
        healthy: await probeSubscription(() =>
          new GrokAuthManager({
            authFile,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          }).credentials(),
        ),
        brokenMessage:
          "Heads up — my Grok sign-in has stopped working, so I may not be able to reply " +
          "soon. Reconnect it in the console (Connections page).",
      });
    }
    return results;
  };
}

async function probeSubscription(
  credentials: () => Promise<unknown>,
): Promise<boolean | null> {
  try {
    // credentials() refreshes when close to expiry — a real end-to-end check.
    await credentials();
    return true;
  } catch (error) {
    if (!(error instanceof SubscriptionAuthError)) return null;
    // A refresh rejected with a 5xx is the provider having a bad day, not dead auth.
    const status = /\((\d{3})\)/.exec(error.message)?.[1];
    return status !== undefined && Number(status) >= 500 ? null : false;
  }
}
