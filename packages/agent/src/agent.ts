import { join } from "node:path";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { MessageRow, NudgeStore, SessionRow } from "@nudge/store";
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import { FileWorkspace } from "./files.js";
import { createLoopGuard } from "./loop.js";
import { MemoryFiles } from "./memory.js";
import { SubscriptionAuthError } from "./providers/errors.js";
import { withStreamRetry, type StreamRetryOptions } from "./providers/retry.js";
import { buildSystemPrompt, type GoogleAccountRef } from "./prompt.js";
import { SkillsLibrary } from "./skills.js";
import { startOfDayInZone } from "./time.js";
import { buildTools } from "./tools.js";
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
  compactAfterMessages?: number;
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

export class NudgeAgent {
  readonly #options: NudgeAgentOptions;
  readonly #memory: MemoryFiles;
  readonly #skills: SkillsLibrary;
  readonly #tools: ToolSet;
  readonly #idleRolloverMs: number;
  readonly #compactAfterMessages: number;
  readonly #maxToolSteps: number;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #systemFileCache = new Map<number, string | undefined>();

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
    this.#compactAfterMessages = options.compactAfterMessages ?? 40;
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
   */
  reply(
    handle: string,
    text: string,
    options: { abortSignal?: AbortSignal } = {},
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

      const history = this.#options.store.sessionMessages(session.id, session.compactedThrough);
      const steps: StepResult<ToolSet>[] = [];
      let raw: string;
      let toolPayload: string | undefined;
      // The console polls this trace to show the turn live; cleared when the
      // turn settles either way (the finished turn's messages replace it).
      this.#options.store.setTurnProgress(session.id, handle, "[]", this.#now());
      try {
        ({ text: raw, toolPayload } = await this.#generate({
          system: this.#systemPromptFor(session, now),
          messages: toModelMessages(history),
          tools: this.#tools,
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
        }));
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
      this.#options.store.appendMessage({
        sessionId: session.id,
        handle,
        role: "assistant",
        content: reply,
        ...(toolPayload ? { toolPayload } : {}),
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
      const { text: raw, toolPayload } = await this.#generate({
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
      this.#options.store.appendMessage({
        sessionId: session.id,
        handle,
        role: "assistant",
        content: reply,
        ...(toolPayload ? { toolPayload } : {}),
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
  }

  #systemPromptFor(session: SessionRow, now: number): string {
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

  async #compactIfNeeded(session: SessionRow): Promise<void> {
    const store = this.#options.store;
    const current = store.activeSession(session.handle);
    if (!current || current.id !== session.id) return;
    const messages = store.sessionMessages(session.id, current.compactedThrough);
    if (messages.length <= this.#compactAfterMessages) return;

    const keep = Math.max(2, Math.ceil(this.#compactAfterMessages / 2));
    const fold = messages.slice(0, messages.length - keep);
    const last = fold.at(-1);
    if (!last) return;
    try {
      const summary = await this.#summarizeText(
        (current.summary ? `Earlier summary:\n${current.summary}\n\n` : "") +
          `Turns to fold in:\n${transcript(fold)}`,
      );
      store.setCompaction(session.id, summary, last.id);
    } catch (error) {
      this.#options.logger.warn("Thread compaction failed; keeping full history for now", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #summarizeSession(session: SessionRow): Promise<string> {
    const messages = this.#options.store.sessionMessages(session.id, session.compactedThrough);
    const base = session.summary ? `Compacted summary so far:\n${session.summary}\n\n` : "";
    return this.#summarizeText(`${base}Transcript:\n${transcript(messages)}`);
  }

  #summarizeText(content: string): Promise<string> {
    return this.#generate({
      system:
        "Condense the conversation faithfully in under 120 words: durable facts, decisions, " +
        "open loops, and commitments. Refer to the human as “the owner”. Output only the summary.",
      messages: [{ role: "user", content }],
    }).then((result) => result.text.trim());
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
  }): Promise<{ text: string; toolPayload?: string }> {
    const sources = this.#options.sources;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      if (params.stepSink) params.stepSink.length = 0;
      try {
        const model = withStreamRetry(await source.languageModel(), {
          ...this.#options.streamRetry,
          logger: this.#options.logger,
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
        const payload = params.tools ? serializeSteps(await result.steps) : undefined;
        // No text after tool calls means a stop condition cut the loop before
        // the model wrote its reply. Give it one tool-less call to report
        // status, so the owner gets a message instead of an error.
        if (!text.trim() && payload) {
          text = await this.#wrapUpCutOffTurn(model, params, payload);
          if (params.abortSignal?.aborted) {
            throw new DOMException("The turn was aborted mid-generation", "AbortError");
          }
        }
        return { text, ...(payload ? { toolPayload: payload } : {}) };
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
    step.toolCalls.map((call, index) => ({
      tool: call.toolName,
      input: call.input,
      output: clip(step.toolResults[index]?.output),
    })),
  );
  return calls.length > 0 ? JSON.stringify(calls) : undefined;
}

function clip(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}
