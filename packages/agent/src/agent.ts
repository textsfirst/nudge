import { join } from "node:path";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { MessageRow, NudgeStore, SessionRow } from "@nudge/store";
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import {
  DEFAULT_COMPACT_AT_FRACTION,
  DEFAULT_KEEP_RECENT_TOKENS,
  contextWindowFor,
  estimateTokens,
  planCompaction,
  usableWindow,
  type CompactionBudget,
} from "./context.js";
import { FileWorkspace } from "./files.js";
import { createLoopGuard } from "./loop.js";
import { MemoryFiles } from "./memory.js";
import { isContextOverflowError, SubscriptionAuthError } from "./providers/errors.js";
import { truncateTail } from "./truncate.js";
import { withStreamRetry, type StreamRetryOptions } from "./providers/retry.js";
import { buildSystemPrompt, type GoogleAccountRef } from "./prompt.js";
import { SkillsLibrary } from "./skills.js";
import { startOfDayInZone } from "./time.js";
import { buildSendUpdateTool, buildTools } from "./tools.js";
import type { Logger, ModelSource } from "./types.js";
import { FirecrawlClient, type FirecrawlOptions } from "./web.js";

export interface NudgeAgentOptions {
  sources: ModelSource[];
  store: NudgeStore;
  logger: Logger;
  timeZone: string;
  /** The data directory: SYSTEM.md, SCHEDULE.md, memory files, skills/. */
  dataDir: string;
  /** Reads SYSTEM.md; undefined when the file is absent. Called at thread start. */
  systemFile: () => string | undefined;
  idleRolloverMs?: number;
  /** Context-window budgeting for compaction — see context.ts for the defaults. */
  compaction?: {
    /** Override the model's context window (tokens); 0 or absent auto-detects from the model id. */
    contextWindowTokens?: number;
    /** Share of the usable window that triggers a fold (default 0.8). */
    compactAtFraction?: number;
    /** Recent-conversation tokens kept verbatim after a fold (default 20k). */
    keepRecentTokens?: number;
  };
  /** Backstop against runaway tool loops (default 256), not a per-task budget — see loop.ts. */
  maxToolSteps?: number;
  /** Firecrawl credentials; when absent the web tools are omitted entirely. */
  web?: FirecrawlOptions;
  /** Defaults to true; false removes the bash tool from the set. */
  bashEnabled?: boolean;
  /** Extra environment for bash commands (PATH prepends, gws shim pointers). */
  bashEnv?: Record<string, string>;
  /**
   * Live reader for connected Google accounts (label + email). Read at every
   * prompt build so accounts connected mid-thread appear without a restart.
   */
  googleAccounts?: () => GoogleAccountRef[];
  /** OpenAI provider options applied to every model call (reasoningEffort, serviceTier, …). */
  modelOptions?: OpenAIResponsesProviderOptions;
  /** Tuning for the early-stream-error retry (mainly for tests) — see providers/retry.ts. */
  streamRetry?: Pick<StreamRetryOptions, "attempts" | "baseDelayMs">;
  now?: () => number;
}

const SILENT_PATTERN = /^\s*(\[SILENT\]|NO_REPLY)\s*$/;
const NEW_THREAD_TOKEN = "[NEW_THREAD]";

/** Consecutive summarizer failures before a session's compaction attempts pause. */
const MAX_COMPACTION_FAILURES = 3;
/** Cap on the transcript fed to the summarizer, so that call can never overflow itself. */
const SUMMARIZER_INPUT_MAX_BYTES = 100 * 1024;

const SUMMARY_PROMPT_BASE =
  "You are compacting the history of an ongoing conversation between a personal assistant " +
  "and its owner. Older turns are being replaced by your summary — it becomes the only " +
  "record the assistant keeps of them. Do NOT continue the conversation or respond to " +
  "anything in it; output only the summary.\n" +
  "Cover, as compact markdown sections, omitting empty ones: Ongoing matters; Durable facts; " +
  "Preferences; Decisions; Open loops & commitments (include dates); Critical context. " +
  'Refer to the human as "the owner". Keep it under 300 words.';

const FRESH_SUMMARY_PROMPT = SUMMARY_PROMPT_BASE;

// Merging into the previous summary (rather than re-summarizing it) keeps
// early facts from eroding a little more on every fold.
const UPDATE_SUMMARY_PROMPT =
  SUMMARY_PROMPT_BASE +
  "\nAn existing summary of even earlier turns is provided: preserve every item from it that " +
  "the new turns do not resolve or supersede, fold the new turns in, and update items the " +
  "new turns settle. Never drop a commitment or fact merely because it is old.";

/**
 * Everything worth recording about a finished model turn. `inputTokens` and
 * `outputTokens` land in their own store columns; the rest is serialized into
 * the message's `metrics` JSON for the console.
 */
interface TurnMetrics {
  inputTokens?: number;
  outputTokens?: number;
  /** The source that actually answered — reveals a mid-turn fallback. */
  provider?: string;
  /** The last step's model id — the model that wrote the reply, post-fallback. */
  modelId?: string;
  finishReason?: string;
  steps?: number;
  durationMs?: number;
  /** First step's time to first output — the user-perceived latency start. */
  ttftMs?: number;
  /** Output-token-weighted tokens/sec across steps. */
  outputTps?: number;
  /** Total client-side tool execution time across steps. */
  toolMs?: number;
  /** Per-step input tokens summed — the billing basis, unlike the watermark. */
  inputTokensTotal?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** In-stream retries that preceded the reply; absent when none. */
  retries?: number;
}

export class NudgeAgent {
  readonly #options: NudgeAgentOptions;
  readonly #memory: MemoryFiles;
  readonly #skills: SkillsLibrary;
  readonly #tools: ToolSet;
  readonly #idleRolloverMs: number;
  readonly #budget: CompactionBudget;
  readonly #maxToolSteps: number;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #systemFileCache = new Map<number, string | undefined>();
  readonly #compactionFailures = new Map<number, number>();

  constructor(options: NudgeAgentOptions) {
    if (options.sources.length === 0) {
      throw new Error("NudgeAgent needs at least one model source");
    }
    this.#options = options;
    this.#memory = new MemoryFiles(options.dataDir);
    this.#skills = new SkillsLibrary(join(options.dataDir, "skills"));
    this.#tools = buildTools({
      workspace: new FileWorkspace(options.dataDir),
      store: options.store,
      ...(options.web ? { web: new FirecrawlClient(options.web) } : {}),
      ...(options.bashEnabled !== false
        ? { bash: { cwd: options.dataDir, env: options.bashEnv } }
        : {}),
    });
    this.#idleRolloverMs = options.idleRolloverMs ?? 6 * 60 * 60 * 1000;
    // Sources fall back mid-turn on auth failures, so budget for the smallest window among them.
    this.#budget = {
      contextWindow:
        options.compaction?.contextWindowTokens ||
        Math.min(...options.sources.map((source) => contextWindowFor(source.modelId))),
      compactAtFraction: options.compaction?.compactAtFraction ?? DEFAULT_COMPACT_AT_FRACTION,
      keepRecentTokens: options.compaction?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    };
    this.#maxToolSteps = options.maxToolSteps ?? 256;
  }

  /**
   * Handle an inbound message. Returns the reply text, or null when the model
   * chose [SILENT] — the turn is persisted either way. A [NEW_THREAD] token is
   * stripped from the reply and closes the thread after this turn.
   *
   * `abortSignal` steers: when it aborts mid-generation the turn is abandoned
   * and this rejects — the owner's message is already in history, so the next
   * turn folds it in. Tool calls the abandoned run completed are recorded as
   * an in-history interruption note so the model knows what already happened.
   *
   * `onProgress` enables the send_update tool for this turn: the model can
   * text the owner short progress lines mid-turn while it keeps working.
   * Updates live only in the tool trace, never as history rows.
   */
  reply(
    handle: string,
    text: string,
    options: {
      abortSignal?: AbortSignal;
      onProgress?: (text: string) => Promise<void>;
    } = {},
  ): Promise<string | null> {
    return this.#serialized(handle, async () => {
      const now = this.#now();
      const session = await this.#resolveSession(handle, now);
      this.#options.store.appendMessage({
        sessionId: session.id,
        handle,
        role: "user",
        content: text,
        at: now,
      });

      // Pre-flight safety net: history grows without a compaction check via
      // runTask appends and interruption notes, and thresholds can change
      // between runs — fold now rather than send an oversized prompt.
      await this.#compactIfNeeded(session);

      const steps: StepResult<ToolSet>[] = [];
      let raw: string;
      let toolPayload: string | undefined;
      let usage: TurnMetrics | undefined;
      // The console polls this trace to show the turn live; cleared when the
      // turn settles either way (the finished turn's messages replace it).
      this.#options.store.setTurnProgress(session.id, handle, "[]", this.#now());
      // Built once per turn, not per attempt: the tool's dedupe/cap state must
      // survive the overflow retry so a resend doesn't repeat sent updates.
      const tools = options.onProgress
        ? { ...this.#tools, ...buildSendUpdateTool(options.onProgress) }
        : this.#tools;
      // History is re-read per attempt so a fold in between is picked up.
      const attempt = () =>
        this.#generate({
          system: this.#systemPromptFor(session, now, {
            progress: options.onProgress !== undefined,
          }),
          messages: toModelMessages(this.#history(session)),
          tools,
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
          stepSink: steps,
          onStep: () => {
            this.#options.store.setTurnProgress(
              session.id,
              handle,
              serializeSteps(steps) ?? "[]",
              this.#now(),
            );
          },
        });
      try {
        try {
          ({ text: raw, toolPayload, usage } = await attempt());
        } catch (error) {
          // A real overflow despite the estimates (unusual content, an
          // off-registry window): fold hard and give the turn one more try.
          const recoverable = isContextOverflowError(error) && options.abortSignal?.aborted !== true;
          if (!recoverable || !(await this.#compactIfNeeded(session, { aggressive: true }))) {
            throw error;
          }
          this.#options.logger.warn(
            "The model reported a context overflow; compacted the thread and retrying",
          );
          ({ text: raw, toolPayload, usage } = await attempt());
        }
      } catch (error) {
        this.#recordInterruption(session, handle, steps, {
          aborted: options.abortSignal?.aborted === true,
        });
        throw error;
      } finally {
        this.#options.store.clearTurnProgress(session.id);
      }

      const reply = raw.trim();
      if (!reply) {
        throw new Error("The model returned an empty response");
      }
      const metrics = serializeMetrics(usage);
      this.#options.store.appendMessage({
        sessionId: session.id,
        handle,
        role: "assistant",
        content: reply,
        ...(toolPayload ? { toolPayload } : {}),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(metrics ? { metrics } : {}),
        at: this.#now(),
      });
      this.#options.store.touchSession(session.id, this.#now());

      const wantsReset = reply.includes(NEW_THREAD_TOKEN);
      if (wantsReset) {
        this.#endSession(session, "requested");
      } else {
        await this.#compactIfNeeded(session);
      }

      const cleaned = reply.replaceAll(NEW_THREAD_TOKEN, "").trim();
      return !cleaned || SILENT_PATTERN.test(cleaned) ? null : cleaned;
    });
  }

  /**
   * Run a scheduled prompt as a fresh one-shot turn: memory and skills are in
   * the prompt stack, thread history is not. A non-silent result is appended
   * to the active thread (creating one if needed) so the conversation
   * remembers what it sent. Returns null when the model chose [SILENT].
   */
  runTask(handle: string, name: string, prompt: string): Promise<string | null> {
    return this.#serialized(handle, async () => {
      const now = this.#now();
      const systemPrompt = buildSystemPrompt({
        systemFile: this.#options.systemFile(),
        memory: this.#memory.render(),
        skills: this.#skills.list(),
        carryover: null,
        compactionSummary: null,
        now: new Date(now),
        timeZone: this.#options.timeZone,
        webEnabled: Boolean(this.#options.web),
        bashEnabled: this.#options.bashEnabled !== false,
        googleAccounts: this.#googleAccounts(),
      });
      const { text: raw, toolPayload, usage } = await this.#generate({
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content:
              `[Scheduled task "${name}" is firing now. This is not a message from the owner — ` +
              `whatever you write next is texted to them unprompted.]\n${prompt}`,
          },
        ],
        tools: this.#tools,
      });

      const reply = raw.trim().replaceAll(NEW_THREAD_TOKEN, "").trim();
      if (!reply || SILENT_PATTERN.test(reply)) {
        return null;
      }
      const session =
        this.#options.store.activeSession(handle) ?? this.#options.store.startSession(handle, now);
      const metrics = serializeMetrics(usage);
      this.#options.store.appendMessage({
        sessionId: session.id,
        handle,
        role: "assistant",
        content: reply,
        ...(toolPayload ? { toolPayload } : {}),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(metrics ? { metrics } : {}),
        at: this.#now(),
      });
      return reply;
    });
  }

  // -- internals -----------------------------------------------------------

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async #resolveSession(handle: string, now: number): Promise<SessionRow> {
    const active = this.#options.store.activeSession(handle);
    if (active) {
      const reason = this.#rolloverReason(active, now);
      if (!reason) {
        return active;
      }
      let carryover: string | undefined;
      try {
        carryover = await this.#summarizeSession(active);
      } catch (error) {
        this.#options.logger.warn("Carryover summary failed; starting the thread without one", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.#endSession(active, reason);
      const session = this.#options.store.startSession(handle, now, carryover);
      this.#systemFileCache.set(session.id, this.#options.systemFile());
      return session;
    }
    const session = this.#options.store.startSession(handle, now);
    this.#systemFileCache.set(session.id, this.#options.systemFile());
    return session;
  }

  #rolloverReason(session: SessionRow, now: number): "idle" | "midnight" | null {
    if (now - session.lastActivityAt > this.#idleRolloverMs) return "idle";
    if (session.lastActivityAt < startOfDayInZone(new Date(now), this.#options.timeZone)) {
      return "midnight";
    }
    return null;
  }

  #endSession(session: SessionRow, reason: string): void {
    this.#options.store.endSession(session.id, reason, this.#now());
    this.#systemFileCache.delete(session.id);
    this.#compactionFailures.delete(session.id);
  }

  /** The un-compacted history, re-reading the fold cursor so it reflects any fold since session load. */
  #history(session: SessionRow): MessageRow[] {
    const store = this.#options.store;
    const current = store.activeSession(session.handle);
    const compactedThrough =
      current && current.id === session.id ? current.compactedThrough : session.compactedThrough;
    return store.sessionMessages(session.id, compactedThrough);
  }

  #systemPromptFor(
    session: SessionRow,
    now: number,
    opts: { progress?: boolean } = {},
  ): string {
    if (!this.#systemFileCache.has(session.id)) {
      this.#systemFileCache.set(session.id, this.#options.systemFile());
    }
    // Re-read the compaction summary so it reflects any fold since session load.
    const current = this.#options.store.activeSession(session.handle);
    const summary = current && current.id === session.id ? current.summary : session.summary;
    return buildSystemPrompt({
      systemFile: this.#systemFileCache.get(session.id),
      memory: this.#memory.render(),
      skills: this.#skills.list(),
      carryover: session.carryover,
      compactionSummary: summary,
      now: new Date(now),
      timeZone: this.#options.timeZone,
      webEnabled: Boolean(this.#options.web),
      bashEnabled: this.#options.bashEnabled !== false,
      ...(opts.progress ? { progressEnabled: true } : {}),
      googleAccounts: this.#googleAccounts(),
    });
  }

  /** Accounts appear/disappear as the owner connects them — never let a bad registry read break a turn. */
  #googleAccounts(): GoogleAccountRef[] {
    try {
      return this.#options.googleAccounts?.() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * A turn that already ran tools before being cut short — steered by the
   * owner or killed by an error — leaves side effects (files written, commands
   * run) the next turn cannot see otherwise: history replays only message
   * text. Record them as an assistant-turn note; pure-text turns leave
   * nothing behind.
   */
  #recordInterruption(
    session: SessionRow,
    handle: string,
    steps: StepResult<ToolSet>[],
    cause: { aborted: boolean },
  ): void {
    const toolPayload = serializeSteps(steps);
    if (!toolPayload) return;
    const summary =
      toolPayload.length > 1_500 ? `${toolPayload.slice(0, 1_500)}…` : toolPayload;
    const lead = cause.aborted
      ? "The owner's next message interrupted this turn before any reply was sent."
      : "This turn failed with an error before any reply was sent.";
    this.#options.store.appendMessage({
      sessionId: session.id,
      handle,
      role: "assistant",
      content: `[${lead} Tool calls that already ran: ${summary}]`,
      toolPayload,
      at: this.#now(),
    });
    this.#options.store.touchSession(session.id, this.#now());
  }

  /**
   * Fold older history into the rolling summary when the estimated prompt
   * (system stack + un-compacted rows) presses on the context window. Runs
   * post-turn — the common path, latency the owner never feels — and
   * pre-flight as a safety net. `aggressive` is overflow recovery: fold
   * regardless of the estimate and keep only a sliver. Returns whether the
   * fold cursor advanced.
   */
  async #compactIfNeeded(
    session: SessionRow,
    opts: { aggressive?: boolean } = {},
  ): Promise<boolean> {
    const store = this.#options.store;
    const current = store.activeSession(session.handle);
    if (!current || current.id !== session.id) return false;
    const failures = this.#compactionFailures.get(session.id) ?? 0;
    if (!opts.aggressive && failures >= MAX_COMPACTION_FAILURES) return false;

    const messages = store.sessionMessages(session.id, current.compactedThrough);
    const plan = planCompaction({
      messages,
      systemTokens: estimateTokens(this.#systemPromptFor(session, this.#now())),
      budget: this.#budget,
      ...(opts.aggressive ? { aggressive: true } : {}),
    });
    if (!plan) return false;
    const last = plan.fold.at(-1);
    if (!last) return false;

    try {
      const summary = await this.#summarizeText({
        previousSummary: current.summary,
        transcript: transcript(plan.fold),
      });
      store.setCompaction(session.id, summary, last.id);
      this.#compactionFailures.delete(session.id);
      this.#options.logger.info("Compacted the thread", {
        foldedMessages: plan.fold.length,
        keptMessages: plan.keep.length,
        estimatedTokens: plan.totalTokens,
      });
      return true;
    } catch (error) {
      this.#compactionFailures.set(session.id, failures + 1);
      const message = error instanceof Error ? error.message : String(error);
      // When the prompt would genuinely overflow, an unsummarized fold beats a
      // guaranteed failure: the cursor advances with a note, and the folded
      // rows stay in the store for search_history and the console.
      if (opts.aggressive || plan.totalTokens > usableWindow(this.#budget.contextWindow)) {
        const note = "[Some earlier turns were dropped before they could be summarized.]";
        store.setCompaction(
          session.id,
          current.summary ? `${current.summary}\n\n${note}` : note,
          last.id,
        );
        this.#options.logger.warn(
          "Thread compaction failed; dropping earlier turns without a summary",
          { error: message },
        );
        return true;
      }
      this.#options.logger.warn("Thread compaction failed; keeping full history for now", {
        error: message,
      });
      return false;
    }
  }

  async #summarizeSession(session: SessionRow): Promise<string> {
    const messages = this.#options.store.sessionMessages(session.id, session.compactedThrough);
    return this.#summarizeText({
      previousSummary: session.summary,
      transcript: transcript(messages),
    });
  }

  /**
   * One summarizer for folds and thread carryover. With a previous summary the
   * update prompt merges into it rather than re-summarizing it, so repeated
   * folds don't erode early facts. Input is capped keeping the newest turns —
   * the oldest are the ones already covered by the previous summary — so the
   * summarization call itself can never overflow.
   */
  #summarizeText(input: { previousSummary: string | null; transcript: string }): Promise<string> {
    const capped = truncateTail(input.transcript, {
      maxBytes: SUMMARIZER_INPUT_MAX_BYTES,
      maxLines: Number.MAX_SAFE_INTEGER,
    });
    return this.#generate({
      system: input.previousSummary ? UPDATE_SUMMARY_PROMPT : FRESH_SUMMARY_PROMPT,
      messages: [
        {
          role: "user",
          content:
            (input.previousSummary ? `Existing summary:\n${input.previousSummary}\n\n` : "") +
            `New turns to fold in:\n${capped.truncated ? "[Oldest turns omitted to fit.]\n" : ""}` +
            capped.text,
        },
      ],
    }).then((result) => {
      const text = result.text.trim();
      if (!text) throw new Error("The summarizer returned an empty summary");
      return text;
    });
  }

  async #generate(params: {
    system: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    abortSignal?: AbortSignal;
    /** Collects finished steps as they land, so an aborted run can report the tool calls it already made. */
    stepSink?: StepResult<ToolSet>[];
    /** Fires after each step lands in stepSink — the live-progress hook. */
    onStep?: () => void;
  }): Promise<{ text: string; toolPayload?: string; usage?: TurnMetrics }> {
    const sources = this.#options.sources;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      if (params.stepSink) params.stepSink.length = 0;
      try {
        let retries = 0;
        const model = withStreamRetry(await source.languageModel(), {
          ...this.#options.streamRetry,
          logger: this.#options.logger,
          onRetry: () => {
            retries += 1;
          },
        });
        // Stateful (once-per-streak warning), so one guard per attempt.
        const guard = params.tools
          ? createLoopGuard({ maxToolSteps: this.#maxToolSteps, logger: this.#options.logger })
          : undefined;
        // streamText never rejects: API and mid-stream failures surface only
        // through onError, and the result reads as an empty (or truncated)
        // reply. Collect them so they can be rethrown below — otherwise a
        // provider outage looks identical to a step-limit cut and never
        // reaches the source-fallback loop or the caller's error path.
        const streamErrors: unknown[] = [];
        const result = streamText({
          model,
          system: params.system,
          messages: params.messages,
          ...(params.tools && guard
            ? {
                tools: params.tools,
                stopWhen: [stepCountIs(this.#maxToolSteps), guard.stopCondition],
                prepareStep: guard.prepareStep,
              }
            : {}),
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(params.stepSink
            ? {
                onStepFinish: (step: StepResult<ToolSet>) => {
                  params.stepSink!.push(step);
                  params.onStep?.();
                },
              }
            : {}),
          onError: ({ error }) => {
            streamErrors.push(error);
          },
          providerOptions: { openai: { ...this.#options.modelOptions, store: false } },
        });
        // Resolving .text consumes the complete SSE response (all tool steps included).
        let text = await result.text;
        // Surface an abort explicitly so callers can tell a steered turn from
        // a model failure (an abort also lands in streamErrors — check it first).
        if (params.abortSignal?.aborted) {
          throw new DOMException("The turn was aborted mid-generation", "AbortError");
        }
        if (streamErrors.length > 0) {
          throw toStreamError(streamErrors[0]);
        }
        const allSteps = await result.steps;
        const usage = turnMetrics(allSteps, await result.usage, {
          provider: source.id,
          retries,
        });
        if (usage) {
          this.#options.logger.debug("Model turn finished", { ...usage });
        }
        const payload = params.tools ? serializeSteps(allSteps) : undefined;
        // No text after tool calls means a stop condition cut the loop before
        // the model wrote its reply. Give it one tool-less call to report
        // status, so the owner gets a message instead of an error.
        if (!text.trim() && payload) {
          text = await this.#wrapUpCutOffTurn(model, params, payload);
          if (params.abortSignal?.aborted) {
            throw new DOMException("The turn was aborted mid-generation", "AbortError");
          }
        }
        return {
          text,
          ...(payload ? { toolPayload: payload } : {}),
          ...(usage ? { usage } : {}),
        };
      } catch (error) {
        const next = sources[index + 1];
        const authFailure = source.isAuthError(error);
        if (next && authFailure) {
          this.#options.logger.error(error instanceof Error ? error.message : String(error), {
            provider: source.id,
            fallback: next.id,
          });
          this.#options.logger.warn("Falling back to the next model source for this turn");
          continue;
        }
        if (authFailure && !(error instanceof SubscriptionAuthError)) {
          throw new SubscriptionAuthError(
            `Authentication failed for ${source.id}. Reconnect it in the console ` +
              `(Connections page) and try again.`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    throw new Error("No model source produced a response");
  }

  async #wrapUpCutOffTurn(
    model: LanguageModel,
    params: { system: string; messages: ModelMessage[]; abortSignal?: AbortSignal },
    toolPayload: string,
  ): Promise<string> {
    this.#options.logger.warn("The tool loop was cut off before a reply; asking for a wrap-up");
    const trace =
      toolPayload.length > 4_000 ? `${toolPayload.slice(0, 4_000)}…` : toolPayload;
    const result = streamText({
      model,
      system: params.system,
      messages: [
        ...params.messages,
        {
          role: "user",
          content:
            "[System note: your tool loop was stopped before you wrote a reply. Tool calls " +
            `already made this turn: ${trace}. No tools are available now — reply to the ` +
            "owner with what you accomplished and what remains.]",
        },
      ],
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      providerOptions: { openai: { ...this.#options.modelOptions, store: false } },
    });
    const text = (await result.text).trim();
    // The wrap-up must never leave the owner with nothing: a cut-off turn that
    // also fails to summarize itself falls back to a fixed status message.
    return (
      text ||
      "I hit my step limit mid-task and had to stop before finishing. " +
        "Ask me to continue and I'll pick up where I left off."
    );
  }

  #serialized<T>(handle: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(handle) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const settled = run.catch(() => undefined);
    this.#queues.set(handle, settled);
    void settled.finally(() => {
      if (this.#queues.get(handle) === settled) {
        this.#queues.delete(handle);
      }
    });
    return run;
  }
}

/**
 * Stream failures arrive as Error instances or as raw provider wire events
 * like {"type":"error","error":{"code":"server_is_overloaded","message":"…"}}.
 * Normalize to an Error whose message is fit for logs and the console thread.
 */
function toStreamError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null) {
    const nested = (value as { error?: unknown }).error;
    if (typeof nested === "object" && nested !== null) {
      const { code, message } = nested as { code?: unknown; message?: unknown };
      if (typeof message === "string" && message) {
        return new Error(typeof code === "string" ? `${message} (${code})` : message);
      }
    }
  }
  return new Error(
    `The model stream failed: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/**
 * The last step's input count is the turn's context watermark — each step
 * resends the whole conversation — while outputs meaningfully sum across
 * steps. Timing and cache fields aggregate what the SDK measured per step;
 * a field is absent only when every step lacked it, so providers that omit
 * some detail degrade gracefully. Undefined when there were no steps at all.
 */
function turnMetrics(
  steps: ReadonlyArray<StepResult<ToolSet>>,
  totals: LanguageModelUsage,
  meta: { provider: string; retries: number },
): TurnMetrics | undefined {
  const last = steps.at(-1);
  const inputTokens = last?.usage.inputTokens ?? totals.inputTokens;
  const outputTokens = totals.outputTokens;
  if (!last) {
    if (inputTokens === undefined && outputTokens === undefined) return undefined;
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }

  const durationMs = sumDefined(steps.map((step) => step.performance.stepTimeMs));
  const ttftMs = steps[0]?.performance.timeToFirstOutputMs;
  const toolMs = sumDefined(
    steps.map((step) => sumDefined(Object.values(step.performance.toolExecutionMs))),
  );
  // Weight each step's rate by its output so a long step counts for its share,
  // instead of averaging fast and slow rates as equals.
  let weightedOut = 0;
  let weightedSeconds = 0;
  for (const step of steps) {
    const out = step.usage.outputTokens;
    const tps = step.performance.outputTokensPerSecond;
    if (out !== undefined && out > 0 && tps !== undefined && tps > 0) {
      weightedOut += out;
      weightedSeconds += out / tps;
    }
  }
  const outputTps = weightedSeconds > 0 ? weightedOut / weightedSeconds : undefined;
  const inputTokensTotal = sumDefined(steps.map((step) => step.usage.inputTokens));
  const cacheReadTokens = sumDefined(
    steps.map((step) => step.usage.inputTokenDetails.cacheReadTokens),
  );
  const cacheWriteTokens = sumDefined(
    steps.map((step) => step.usage.inputTokenDetails.cacheWriteTokens),
  );
  const reasoningTokens = sumDefined(
    steps.map((step) => step.usage.outputTokenDetails.reasoningTokens),
  );

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    provider: meta.provider,
    modelId: last.model.modelId,
    finishReason: last.finishReason,
    steps: steps.length,
    ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
    ...(ttftMs !== undefined ? { ttftMs: Math.round(ttftMs) } : {}),
    ...(outputTps !== undefined ? { outputTps: Math.round(outputTps * 10) / 10 } : {}),
    ...(toolMs !== undefined && toolMs > 0 ? { toolMs: Math.round(toolMs) } : {}),
    ...(inputTokensTotal !== undefined ? { inputTokensTotal } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(meta.retries > 0 ? { retries: meta.retries } : {}),
  };
}

/** Sum, skipping undefined; undefined only when every value was. */
function sumDefined(values: ReadonlyArray<number | undefined>): number | undefined {
  return values.reduce<number | undefined>(
    (total, value) => (value === undefined ? total : (total ?? 0) + value),
    undefined,
  );
}

/** The JSON for the store's metrics column: everything but the token columns. */
function serializeMetrics(metrics: TurnMetrics | undefined): string | undefined {
  if (!metrics) return undefined;
  const { inputTokens: _in, outputTokens: _out, ...rest } = metrics;
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined;
}

/** Error rows are console-facing diagnostics — the model never sees them. */
function toModelMessages(rows: MessageRow[]): ModelMessage[] {
  return rows
    .filter((row): row is MessageRow & { role: "user" | "assistant" } => row.role !== "error")
    .map((row) => ({ role: row.role, content: row.content }));
}

function transcript(messages: MessageRow[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function serializeSteps(steps: ReadonlyArray<StepResult<ToolSet>>): string | undefined {
  const calls = steps.flatMap((step) =>
    step.toolCalls.map((call, index) => {
      const durationMs = step.performance.toolExecutionMs[call.toolCallId];
      return {
        tool: call.toolName,
        input: call.input,
        output: clip(step.toolResults[index]?.output),
        ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
      };
    }),
  );
  return calls.length > 0 ? JSON.stringify(calls) : undefined;
}

/**
 * Head-and-tail, not head-only: tool results put their status where humans
 * put conclusions — at the end ("Command timed out after 120 seconds", exit
 * codes, truncation footers) — and that line is the one worth keeping.
 */
function clip(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= 500) return value;
  return `${value.slice(0, 300)} …[${value.length - 500} chars omitted]… ${value.slice(-200)}`;
}
