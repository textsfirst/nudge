import { join } from "node:path";
import type { MessageRow, NudgeStore, SessionRow } from "@nudge/store";
import { stepCountIs, streamText, type ModelMessage, type StepResult, type ToolSet } from "ai";
import { FileWorkspace } from "./files.js";
import { MemoryFiles } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
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
  maxToolSteps?: number;
  /** Firecrawl credentials; when absent the web tools are omitted entirely. */
  web?: FirecrawlOptions;
  /** Defaults to true; false removes the bash tool from the set. */
  bashEnabled?: boolean;
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
      ...(options.bashEnabled !== false ? { bash: { cwd: options.dataDir } } : {}),
    });
    this.#idleRolloverMs = options.idleRolloverMs ?? 6 * 60 * 60 * 1000;
    this.#compactAfterMessages = options.compactAfterMessages ?? 40;
    this.#maxToolSteps = options.maxToolSteps ?? 8;
  }

  /**
   * Handle an inbound message. Returns the reply text, or null when the model
   * chose [SILENT] — the turn is persisted either way. A [NEW_THREAD] token is
   * stripped from the reply and closes the thread after this turn.
   */
  reply(handle: string, text: string): Promise<string | null> {
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
      const { text: raw, toolPayload } = await this.#generate({
        system: this.#systemPromptFor(session, now),
        messages: history.map(toModelMessage),
        tools: this.#tools,
      });

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
    });
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
  }): Promise<{ text: string; toolPayload?: string }> {
    const sources = this.#options.sources;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      try {
        const model = await source.languageModel();
        const result = streamText({
          model,
          system: params.system,
          messages: params.messages,
          ...(params.tools
            ? { tools: params.tools, stopWhen: stepCountIs(this.#maxToolSteps) }
            : {}),
          providerOptions: { openai: { store: false } },
        });
        // Resolving .text consumes the complete SSE response (all tool steps included).
        const text = await result.text;
        const payload = params.tools ? serializeSteps(await result.steps) : undefined;
        return { text, ...(payload ? { toolPayload: payload } : {}) };
      } catch (error) {
        const next = sources[index + 1];
        if (next && source.isAuthError(error)) {
          this.#options.logger.error(error instanceof Error ? error.message : String(error), {
            provider: source.id,
            fallback: next.id,
          });
          this.#options.logger.warn("Falling back to the next model source for this turn");
          continue;
        }
        throw error;
      }
    }
    throw new Error("No model source produced a response");
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

function toModelMessage(row: MessageRow): ModelMessage {
  return { role: row.role, content: row.content };
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
