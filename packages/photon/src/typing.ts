import type { InboundLogger } from "./inbound.js";

/** The slice of a Space the typing choreography needs. */
export interface TypingSpace {
  id: string;
  startTyping(): Promise<unknown>;
  stopTyping(): Promise<unknown>;
}

export interface TypingControllerOptions {
  logger: InboundLogger;
  /**
   * Pause between a text arriving and the indicator appearing (default
   * 1100ms, jittered ±20% per showing). 0 shows it immediately. A human takes
   * a beat to see a message before they start typing; an indicator that
   * appears in the same instant the text lands reads as a machine.
   */
  startDelayMs?: number;
  /** Randomness for the jitter; tests inject a fixed source. */
  random?: () => number;
}

export const DEFAULT_TYPING_DELAY_MS = 1100;

/** The scheduled delay lands in [1 − JITTER, 1 + JITTER] × startDelayMs. */
const JITTER = 0.2;

interface SpaceState {
  space: TypingSpace;
  timer: NodeJS.Timeout | undefined;
  /** Best-effort belief that the indicator is showing (delivering a message clears it client-side). */
  active: boolean;
}

/**
 * Owns the typing indicator for every space the transport touches, so there
 * is exactly one authority over when it shows: a jittered delayed start on
 * inbound texts (schedule), an immediate re-show for keepalive and
 * between-bubble pauses (assert), and a cancel-everything clear (stop).
 *
 * All indicator traffic is fire-and-forget — typing is best-effort on every
 * platform, so failures are logged at debug and never surface.
 */
export class TypingController {
  readonly #logger: InboundLogger;
  readonly #startDelayMs: number;
  readonly #random: () => number;
  readonly #spaces = new Map<string, SpaceState>();

  constructor(options: TypingControllerOptions) {
    this.#logger = options.logger;
    this.#startDelayMs = options.startDelayMs ?? DEFAULT_TYPING_DELAY_MS;
    this.#random = options.random ?? Math.random;
  }

  /**
   * Show the indicator after the humanizing delay. Idempotent: a pending
   * schedule or an already-showing indicator is left alone, so repeated
   * buffered texts and steering re-fires never reset the clock.
   */
  schedule(space: TypingSpace): void {
    const state = this.#state(space);
    if (state.timer || state.active) return;
    if (this.#startDelayMs <= 0) {
      this.assert(space);
      return;
    }
    const jittered = this.#startDelayMs * (1 - JITTER + 2 * JITTER * this.#random());
    const timer = setTimeout(() => {
      state.timer = undefined;
      this.assert(state.space);
    }, jittered);
    timer.unref?.();
    state.timer = timer;
  }

  /** Show the indicator now — the keepalive/between-bubbles path. Always resends. */
  assert(space: TypingSpace): void {
    const state = this.#state(space);
    this.#clearTimer(state);
    state.active = true;
    this.#fire("start", () => state.space.startTyping());
  }

  /** Cancel any pending showing and clear the indicator if it ever showed. */
  stop(space: TypingSpace): void {
    const state = this.#state(space);
    this.#clearTimer(state);
    if (!state.active) return;
    state.active = false;
    this.#fire("stop", () => state.space.stopTyping());
  }

  /** Drop every pending timer (shutdown); sends nothing. */
  clear(): void {
    for (const state of this.#spaces.values()) {
      this.#clearTimer(state);
    }
  }

  /** Track the freshest space object — webhooks rehydrate a new one per delivery. */
  #state(space: TypingSpace): SpaceState {
    const existing = this.#spaces.get(space.id);
    if (existing) {
      existing.space = space;
      return existing;
    }
    const created: SpaceState = { space, timer: undefined, active: false };
    this.#spaces.set(space.id, created);
    return created;
  }

  #clearTimer(state: SpaceState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  #fire(kind: "start" | "stop", send: () => Promise<unknown>): void {
    void Promise.resolve()
      .then(send)
      .catch((error: unknown) => {
        this.#logger.debug(`Failed to ${kind} the typing indicator`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
