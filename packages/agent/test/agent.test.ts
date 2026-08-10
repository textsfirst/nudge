import { describe, expect, it } from "vitest";
import { NudgeAgent, SubscriptionAuthError } from "../src/index.js";
import type { ModelSource } from "../src/index.js";
import {
  errorChunks,
  makeAgent,
  promptMessages,
  quietLogger,
  ScriptedSource,
  textChunks,
  toolCallChunks,
} from "./helpers.js";

const HANDLE = "+15551234567";
const T0 = Date.UTC(2026, 7, 10, 15, 0, 0); // 2026-08-10 15:00 UTC

describe("NudgeAgent.reply", () => {
  it("persists turns and keeps the active thread's history in the prompt", async () => {
    const { agent, store, source } = makeAgent(["reply one", "reply two"]);

    await expect(agent.reply(HANDLE, "hello")).resolves.toBe("reply one");
    await expect(agent.reply(HANDLE, "again")).resolves.toBe("reply two");

    const session = store.activeSession(HANDLE);
    expect(session).toBeDefined();
    const messages = store.sessionMessages(session!.id);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["assistant", "reply one"],
      ["user", "again"],
      ["assistant", "reply two"],
    ]);

    const secondCall = promptMessages(source.calls[1]!);
    expect(secondCall.filter((message) => message.role !== "system")).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "reply one" },
      { role: "user", text: "again" },
    ]);
  });

  it("keeps journaled error rows out of the model's context", async () => {
    const { agent, store, source } = makeAgent(["reply one", "reply two"]);
    await agent.reply(HANDLE, "hello");
    const session = store.activeSession(HANDLE);
    store.appendMessage({
      sessionId: session!.id,
      handle: HANDLE,
      role: "error",
      content: "model down",
    });

    await expect(agent.reply(HANDLE, "again")).resolves.toBe("reply two");

    const secondCall = promptMessages(source.calls[1]!);
    expect(secondCall.filter((message) => message.role !== "system")).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "reply one" },
      { role: "user", text: "again" },
    ]);
  });

  it("serializes concurrent replies for the same handle", async () => {
    const { agent } = makeAgent(["reply one", "reply two"]);
    const [first, second] = await Promise.all([
      agent.reply(HANDLE, "one"),
      agent.reply(HANDLE, "two"),
    ]);
    expect([first, second]).toEqual(["reply one", "reply two"]);
  });

  it("returns null for [SILENT] but persists the turn", async () => {
    const { agent, store } = makeAgent(["[SILENT]"]);
    await expect(agent.reply(HANDLE, "ok")).resolves.toBeNull();
    const session = store.activeSession(HANDLE);
    const messages = store.sessionMessages(session!.id);
    expect(messages.at(-1)?.content).toBe("[SILENT]");
  });

  it("fires onSilent as soon as silence is known, before the turn is persisted", async () => {
    const { agent, store } = makeAgent(["[SILENT]"]);
    let rowsWhenFired = -1;
    await expect(
      agent.reply(HANDLE, "thanks", {
        onSilent: () => {
          rowsWhenFired = store.sessionMessages(store.activeSession(HANDLE)!.id).length;
        },
      }),
    ).resolves.toBeNull();
    // Only the owner's message was in the store — the assistant row lands after.
    expect(rowsWhenFired).toBe(1);
  });

  it("does not fire onSilent when the model actually replies", async () => {
    const { agent } = makeAgent(["sure thing"]);
    let fired = false;
    await expect(
      agent.reply(HANDLE, "hi", { onSilent: () => (fired = true) }),
    ).resolves.toBe("sure thing");
    expect(fired).toBe(false);
  });

  it("fires onReaction for a lone [REACT] token and treats the turn as silent", async () => {
    const { agent, store } = makeAgent(["[REACT:❤️]"]);
    const reactions: string[] = [];
    let silent = false;
    await expect(
      agent.reply(HANDLE, "thanks!", {
        onReaction: (emoji) => reactions.push(emoji),
        onSilent: () => (silent = true),
      }),
    ).resolves.toBeNull();
    expect(reactions).toEqual(["❤️"]);
    expect(silent).toBe(true);
    // The raw token is persisted so the thread remembers the reaction.
    const session = store.activeSession(HANDLE);
    expect(store.sessionMessages(session!.id).at(-1)?.content).toBe("[REACT:❤️]");
  });

  it("reacts and replies when text follows the [REACT] token", async () => {
    const { agent } = makeAgent(["[REACT:👍] on it"]);
    const reactions: string[] = [];
    let silent = false;
    await expect(
      agent.reply(HANDLE, "can you book it?", {
        onReaction: (emoji) => reactions.push(emoji),
        onSilent: () => (silent = true),
      }),
    ).resolves.toBe("on it");
    expect(reactions).toEqual(["👍"]);
    expect(silent).toBe(false);
  });

  it("drops a reaction outside the tapback set without leaking the token", async () => {
    const { agent } = makeAgent(["[REACT:🙏] anytime"]);
    const reactions: string[] = [];
    await expect(
      agent.reply(HANDLE, "ty", { onReaction: (emoji) => reactions.push(emoji) }),
    ).resolves.toBe("anytime");
    expect(reactions).toEqual([]);
  });

  it("rolls the thread after the idle gap, with a carryover summary", async () => {
    // Script: first reply, then the carryover summary, then the new-thread reply.
    const { agent, store, source, setNow } = makeAgent([
      "first reply",
      "the owner planned a trip",
      "fresh reply",
    ]);

    await agent.reply(HANDLE, "let's plan a trip");
    const firstSession = store.activeSession(HANDLE)!;

    setNow(T0 + 7 * 60 * 60 * 1000); // beyond the 6h idle default
    await agent.reply(HANDLE, "morning");

    const secondSession = store.activeSession(HANDLE)!;
    expect(secondSession.id).not.toBe(firstSession.id);
    expect(secondSession.carryover).toBe("the owner planned a trip");

    const finalCall = promptMessages(source.calls[2]!);
    expect(finalCall[0]?.role).toBe("system");
    expect(finalCall[0]?.text).toContain("Where the previous thread left off");
    expect(finalCall[0]?.text).toContain("the owner planned a trip");
    expect(finalCall.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("rolls the thread at local midnight even within the idle window", async () => {
    const { agent, store, setNow } = makeAgent(
      ["night reply", "summary", "morning reply"],
      { idleRolloverMs: 24 * 60 * 60 * 1000 },
    );
    setNow(Date.UTC(2026, 7, 10, 23, 0, 0));
    await agent.reply(HANDLE, "late night");
    const nightSession = store.activeSession(HANDLE)!;

    setNow(Date.UTC(2026, 7, 11, 1, 0, 0)); // 2h later, but past midnight UTC
    await agent.reply(HANDLE, "still up");
    const morningSession = store.activeSession(HANDLE)!;
    expect(morningSession.id).not.toBe(nightSession.id);
    expect(nightSession.id).toBeLessThan(morningSession.id);
  });

  // Compaction test geometry: a 24k window has a usable budget of 12k tokens
  // (floored at half the window) and folds at 80% of that — 9,600 tokens. The
  // long messages below estimate at ~5k tokens each, so two of them in history
  // trip the threshold while one plus the ~1.7k-token system stack does not.
  const long = (label: string) => `${label} ${"x".repeat(20_000)}`;
  const tightBudget = { contextWindowTokens: 24_000, keepRecentTokens: 6_000 };

  it("fires onReplyReady before post-turn compaction", async () => {
    const longReply = long("answer");
    const { agent, store } = makeAgent(["seed reply", longReply, "fold summary"], {
      compaction: tightBudget,
    });
    let summaryAtDelivery: string | null | undefined;

    // Leave one old turn available to fold. The next user message still fits
    // pre-flight; its large answer is what crosses the threshold post-turn.
    await agent.reply(HANDLE, "seed question");
    await expect(
      agent.reply(HANDLE, long("question"), {
        onReplyReady: async (reply) => {
          expect(reply).toBe(longReply);
          const session = store.activeSession(HANDLE)!;
          summaryAtDelivery = session.summary;
          expect(store.sessionMessages(session.id).at(-1)?.content).toBe(longReply);
        },
      }),
    ).resolves.toBe(longReply);

    expect(summaryAtDelivery).toBeNull();
    expect(store.activeSession(HANDLE)!.summary).toBe("fold summary");
  });

  it("compacts when the estimated context outgrows the window, keeping recent turns verbatim", async () => {
    const script = [
      "r1",
      "first summary", // second turn's pre-flight folds m1
      "r2",
      "updated summary", // third turn's pre-flight folds r1 + m2
      "r3",
    ];
    const { agent, store, source } = makeAgent(script, { compaction: tightBudget });

    await agent.reply(HANDLE, long("m1"));
    expect(store.activeSession(HANDLE)!.summary).toBeNull();

    await agent.reply(HANDLE, long("m2"));
    const afterFirst = store.activeSession(HANDLE)!;
    expect(afterFirst.summary).toBe("first summary");
    expect(afterFirst.compactedThrough).toBeGreaterThan(0);
    // The first fold starts a fresh summary...
    const firstSummarize = promptMessages(source.calls[1]!);
    expect(firstSummarize[0]?.text).toContain("compacting the history");
    expect(firstSummarize[0]?.text).not.toContain("preserve every item");
    // ...and the reply that follows sees the summary in place of the folded turn.
    const secondReply = promptMessages(source.calls[2]!);
    expect(secondReply[0]?.text).toContain("Earlier in this thread");
    expect(secondReply[0]?.text).toContain("first summary");
    expect(secondReply.filter((message) => message.role !== "system")).toHaveLength(2);

    await agent.reply(HANDLE, long("m3"));
    const afterSecond = store.activeSession(HANDLE)!;
    expect(afterSecond.summary).toBe("updated summary");
    expect(afterSecond.compactedThrough).toBeGreaterThan(afterFirst.compactedThrough);
    // Later folds merge into the previous summary instead of re-summarizing it.
    const secondSummarize = promptMessages(source.calls[3]!);
    expect(secondSummarize[0]?.text).toContain("preserve every item");
    expect(secondSummarize.at(-1)?.text).toContain("Existing summary:\nfirst summary");
  });

  it("leaves short threads un-compacted", async () => {
    const { agent, store } = makeAgent(["r1", "r2"], { compaction: tightBudget });
    await agent.reply(HANDLE, "m1");
    await agent.reply(HANDLE, "m2");
    const session = store.activeSession(HANDLE)!;
    expect(session.summary).toBeNull();
    expect(session.compactedThrough).toBe(0);
  });

  it("runs summaries on the dedicated compaction model with its own options", async () => {
    const script = ["r1", "fold summary", "r2"];
    const { agent, store, source } = makeAgent(script, {
      compaction: tightBudget,
      summarizer: {
        model: "gpt-5.6-luna",
        modelOptions: { reasoningEffort: "high", serviceTier: "priority" },
      },
    });

    await agent.reply(HANDLE, long("m1"));
    await agent.reply(HANDLE, long("m2"));
    expect(store.activeSession(HANDLE)!.summary).toBe("fold summary");

    // Reply calls run the source's own model; only the fold asks for the override.
    expect(source.modelRequests).toEqual([undefined, "gpt-5.6-luna", undefined]);
    const summarize = source.calls[1]!;
    expect(summarize.providerOptions?.openai).toMatchObject({
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    const reply = source.calls[0]!;
    expect(reply.providerOptions?.openai).not.toMatchObject({ serviceTier: "priority" });
  });

  it("recovers from a provider context overflow by folding hard and retrying once", async () => {
    const overflow = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model.",
      },
    };
    const { agent, store, source } = makeAgent([
      "r1",
      // Early stream errors are retried per model call (attempts: 3) before
      // the failure surfaces to the overflow-recovery path.
      ...Array.from({ length: 3 }, () => errorChunks(overflow)),
      "rescue summary",
      "recovered reply",
    ]);

    await agent.reply(HANDLE, "m1");
    await expect(agent.reply(HANDLE, "m2")).resolves.toBe("recovered reply");

    const session = store.activeSession(HANDLE)!;
    expect(session.summary).toBe("rescue summary");
    expect(session.compactedThrough).toBeGreaterThan(0);
    const retry = promptMessages(source.calls.at(-1)!);
    expect(retry[0]?.text).toContain("rescue summary");
    expect(retry.filter((message) => message.role !== "system")).toHaveLength(2);
  });

  it("drops folded turns with a note when the summarizer fails and the prompt cannot fit", async () => {
    const boom = () => {
      throw new Error("summarizer down");
    };
    // An 8k window floors the usable budget at 4k tokens; two ~5k-token
    // messages exceed it outright, so a failed summary cannot leave the
    // prompt oversized — the fold happens anyway, without a summary.
    const { agent, store } = makeAgent(["r1", boom, "r2"], {
      compaction: { contextWindowTokens: 8_000, keepRecentTokens: 6_000 },
    });

    await agent.reply(HANDLE, long("m1"));
    await expect(agent.reply(HANDLE, long("m2"))).resolves.toBe("r2");

    const session = store.activeSession(HANDLE)!;
    expect(session.summary).toContain("dropped before they could be summarized");
    expect(session.compactedThrough).toBeGreaterThan(0);
  });

  it("records model-reported token usage and turn metrics on assistant rows", async () => {
    const { agent, store } = makeAgent([
      textChunks("counted reply", {
        inputTokens: 1_234,
        outputTokens: 56,
        cacheReadTokens: 1_000,
        reasoningTokens: 8,
      }),
    ]);
    await agent.reply(HANDLE, "hi");
    const assistant = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ inputTokens: 1_234, outputTokens: 56 });

    const metrics = JSON.parse(assistant!.metrics!) as Record<string, unknown>;
    expect(metrics).toMatchObject({
      provider: "scripted",
      modelId: "mock-model-id",
      finishReason: "stop",
      steps: 1,
      inputTokensTotal: 1_234,
      cacheReadTokens: 1_000,
      reasoningTokens: 8,
    });
    // Timing comes from the SDK's real clock, so assert shape only.
    expect(metrics.durationMs).toBeTypeOf("number");
    expect(metrics.modelMs).toBeTypeOf("number");
    expect(metrics.stepTimings).toEqual([
      expect.objectContaining({
        step: 1,
        modelId: "mock-model-id",
        finishReason: "stop",
        durationMs: expect.any(Number),
        modelMs: expect.any(Number),
        ttftMs: expect.any(Number),
        inputTokens: 1_234,
        outputTokens: 56,
        reasoningTokens: 8,
      }),
    ]);
    expect(metrics.retries).toBeUndefined();
  });

  it("records timing for every model step in a tool loop", async () => {
    const { agent, store } = makeAgent([
      toolCallChunks("list_files", {}),
      textChunks("done", { inputTokens: 20, outputTokens: 4 }),
    ]);

    await agent.reply(HANDLE, "what files are there?");
    const assistant = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant");
    const metrics = JSON.parse(assistant!.metrics!) as {
      steps: number;
      stepTimings: Array<Record<string, unknown>>;
    };

    expect(metrics.steps).toBe(2);
    expect(metrics.stepTimings).toHaveLength(2);
    expect(metrics.stepTimings[0]).toMatchObject({
      step: 1,
      finishReason: "tool-calls",
      toolCalls: ["list_files"],
      durationMs: expect.any(Number),
      modelMs: expect.any(Number),
      ttftMs: expect.any(Number),
    });
    expect(metrics.stepTimings[1]).toMatchObject({
      step: 2,
      finishReason: "stop",
      inputTokens: 20,
      outputTokens: 4,
      durationMs: expect.any(Number),
      modelMs: expect.any(Number),
      ttftMs: expect.any(Number),
    });
  });

  it("executes file tools and records the tool payload", async () => {
    const { agent, store, dataDir } = makeAgent([
      toolCallChunks("write_file", {
        path: "USER.md",
        content: "- Likes espresso",
      }),
      "noted!",
    ]);

    await expect(agent.reply(HANDLE, "remember I like espresso")).resolves.toBe("noted!");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(`${dataDir}/USER.md`, "utf8")).toBe("- Likes espresso");

    const assistant = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant");
    expect(assistant?.toolPayload).toContain("write_file");
  });

  it("journals live tool-step progress during the turn and clears it after", async () => {
    // The thunk for the second model call runs after the tool step landed, so
    // it observes the progress trace exactly as a console poll would mid-turn.
    let midTurn: string | undefined;
    const harness = makeAgent([
      toolCallChunks("bash", { command: "echo live progress" }),
      () => {
        const session = harness.store.activeSession(HANDLE);
        midTurn = session ? harness.store.turnProgress(session.id)?.steps : undefined;
        return "done";
      },
    ]);

    await expect(harness.agent.reply(HANDLE, "run it")).resolves.toBe("done");
    expect(midTurn).toContain('"bash"');
    expect(midTurn).toContain("live progress");
    const session = harness.store.activeSession(HANDLE);
    expect(harness.store.turnProgress(session!.id)).toBeUndefined();
  });

  it("texts mid-turn progress through onProgress and keeps it out of history rows", async () => {
    const { agent, store, source } = makeAgent([
      toolCallChunks("send_update", { text: "checking your calendar" }),
      "flight's on the calendar",
    ]);
    const updates: string[] = [];

    await expect(
      agent.reply(HANDLE, "add my flight", {
        onProgress: async (text) => void updates.push(text),
      }),
    ).resolves.toBe("flight's on the calendar");

    expect(updates).toEqual(["checking your calendar"]);
    expect(source.calls[0]!.tools?.map((tool) => tool.name)).toContain("send_update");
    expect(promptMessages(source.calls[0]!)[0]?.text).toContain("send_update");
    // The update lives in the tool trace, not as a message row.
    const messages = store.sessionMessages(store.activeSession(HANDLE)!.id);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "add my flight"],
      ["assistant", "flight's on the calendar"],
    ]);
    expect(messages.at(-1)?.toolPayload).toContain("send_update");
  });

  it("omits the send_update tool and its guidance without onProgress", async () => {
    const { agent, source } = makeAgent(["ok"]);
    await agent.reply(HANDLE, "hi");
    expect(source.calls[0]!.tools?.map((tool) => tool.name)).not.toContain("send_update");
    expect(promptMessages(source.calls[0]!)[0]?.text).not.toContain("send_update");
  });

  it("executes bash and records the tool payload", async () => {
    const { agent, store } = makeAgent([
      toolCallChunks("bash", { command: "echo hi from bash" }),
      "ran it",
    ]);

    await expect(agent.reply(HANDLE, "run echo for me")).resolves.toBe("ran it");
    const assistant = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant");
    expect(assistant?.toolPayload).toContain('"bash"');
    expect(assistant?.toolPayload).toContain("hi from bash");
    // Each recorded call carries its wall-clock time, so a hung command is
    // visible in the console as "bash · 120s" instead of a mystery gap.
    const calls = JSON.parse(assistant!.toolPayload!) as { durationMs?: number }[];
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("clips long tool output around the middle so the status tail survives", async () => {
    const { agent, store } = makeAgent([
      toolCallChunks("bash", { command: "seq 1 300; exit 3" }),
      "done",
    ]);

    await expect(agent.reply(HANDLE, "count")).resolves.toBe("done");
    const assistant = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant");
    expect(assistant?.toolPayload).toContain("chars omitted");
    expect(assistant?.toolPayload).toContain("Command exited with code 3");
  });

  it("injects memory files into the next turn's prompt", async () => {
    const { agent, source, dataDir } = makeAgent(["ok", "ok again"]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dataDir}/USER.md`, "- Allergic to shellfish");

    await agent.reply(HANDLE, "hi");
    const system = promptMessages(source.calls[0]!)[0];
    expect(system?.text).toContain("Allergic to shellfish");
  });

  it("closes the thread and strips the token on [NEW_THREAD]", async () => {
    const { agent, store } = makeAgent(["Fresh start it is. [NEW_THREAD]"]);
    await expect(agent.reply(HANDLE, "please start over")).resolves.toBe("Fresh start it is.");
    expect(store.activeSession(HANDLE)).toBeUndefined();
  });
});

describe("NudgeAgent.reply steering", () => {
  it("keeps the owner's message when the reply is aborted, and folds it into the next turn", async () => {
    const { agent, store, source } = makeAgent(["combined answer"]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      agent.reply(HANDLE, "book friday", { abortSignal: controller.signal }),
    ).rejects.toThrow();

    const session = store.activeSession(HANDLE)!;
    expect(
      store.sessionMessages(session.id).map((message) => [message.role, message.content]),
    ).toEqual([["user", "book friday"]]);

    await expect(agent.reply(HANDLE, "actually saturday")).resolves.toBe("combined answer");
    // The last model call is the successful one; the aborted attempt precedes it.
    const call = promptMessages(source.calls.at(-1)!);
    expect(call.filter((message) => message.role === "user").map((message) => message.text)).toEqual(
      ["book friday", "actually saturday"],
    );
  });

  it("records completed tool calls in history when steered mid-run", async () => {
    const controller = new AbortController();
    const { agent, store, dataDir } = makeAgent([
      toolCallChunks("write_file", { path: "USER.md", content: "- Likes espresso" }),
      () => {
        // The owner's next text lands between tool steps: abort like a real fetch would.
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
      "decaf it is",
    ]);

    await expect(
      agent.reply(HANDLE, "remember I like espresso", { abortSignal: controller.signal }),
    ).rejects.toThrow();

    // The tool's side effect happened and the note tells the next turn about it.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(`${dataDir}/USER.md`, "utf8")).toBe("- Likes espresso");
    const session = store.activeSession(HANDLE)!;
    const messages = store.sessionMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("interrupted this turn");
    expect(messages[1]?.content).toContain("write_file");
    expect(messages[1]?.toolPayload).toContain("write_file");

    await expect(agent.reply(HANDLE, "make it decaf")).resolves.toBe("decaf it is");
  });

  it("does not send an aborted turn's partial text on the next turn", async () => {
    const { agent, store } = makeAgent(["fresh reply"]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      agent.reply(HANDLE, "hello?", { abortSignal: controller.signal }),
    ).rejects.toThrow();

    // No assistant message was persisted for the aborted pure-text turn.
    const session = store.activeSession(HANDLE)!;
    expect(store.sessionMessages(session.id).map((message) => message.role)).toEqual(["user"]);
    await expect(agent.reply(HANDLE, "you there?")).resolves.toBe("fresh reply");
  });
});

describe("NudgeAgent.runTask", () => {
  it("runs without thread history and appends the result to the thread", async () => {
    const { agent, store, source } = makeAgent(["morning briefing text"]);
    await expect(agent.runTask(HANDLE, "Morning briefing", "Summarize the day.")).resolves.toBe(
      "morning briefing text",
    );

    const call = promptMessages(source.calls[0]!);
    expect(call.filter((message) => message.role === "user")[0]?.text).toContain(
      'Scheduled task "Morning briefing"',
    );

    const session = store.activeSession(HANDLE)!;
    expect(store.sessionMessages(session.id).map((message) => message.role)).toEqual(["assistant"]);
  });

  it("delivers nothing when the task decides to stay silent", async () => {
    const { agent, store } = makeAgent(["[SILENT]"]);
    await expect(agent.runTask(HANDLE, "Check-in", "Anything to say?")).resolves.toBeNull();
    expect(store.activeSession(HANDLE)).toBeUndefined();
  });

  it("strips reaction tokens — a scheduled turn has nothing to react to", async () => {
    const { agent } = makeAgent(["[REACT:👍] reminder: gym at 6"]);
    await expect(agent.runTask(HANDLE, "Reminder", "Nudge the gym.")).resolves.toBe(
      "reminder: gym at 6",
    );
  });
});

describe("model source fallback", () => {
  const failing: ModelSource = {
    id: "subscription",
    modelId: "scripted-test-model",
    languageModel: () => Promise.reject(new SubscriptionAuthError("expired")),
    isAuthError: (error) => error instanceof SubscriptionAuthError,
  };

  it("falls back to the next source on auth errors only", async () => {
    const { source, store, dataDir } = makeAgent(["fallback reply"]);
    const agent = new NudgeAgent({
      sources: [failing, source],
      store,
      logger: quietLogger,
      timeZone: "UTC",
      dataDir,
      systemFile: () => undefined,
    });
    await expect(agent.reply(HANDLE, "hi")).resolves.toBe("fallback reply");
  });

  it("does not mask non-auth failures", async () => {
    const broken: ModelSource = {
      id: "subscription",
      modelId: "scripted-test-model",
      languageModel: () => Promise.reject(new Error("rate limited")),
      isAuthError: (error) => error instanceof SubscriptionAuthError,
    };
    const { source, store, dataDir } = makeAgent(["unused"]);
    const agent = new NudgeAgent({
      sources: [broken, source],
      store,
      logger: quietLogger,
      timeZone: "UTC",
      dataDir,
      systemFile: () => undefined,
    });
    await expect(agent.reply(HANDLE, "hi")).rejects.toThrow("rate limited");
  });
});

describe("stream errors", () => {
  // The real shape of a provider outage: the API keeps the SSE stream open and
  // sends an error event, which streamText reports via onError instead of
  // rejecting. Before the fix this read as an empty reply and shipped the
  // "I hit my step limit" message after only a couple of tool steps.
  const overloaded = {
    type: "error",
    sequence_number: 2,
    error: {
      type: "service_unavailable_error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
    },
  };

  // Transient early errors are retried per model call (see providers/retry.ts),
  // so persistent-failure tests script the error once per attempt (3 by default).
  const persistentError = () => Array.from({ length: 3 }, () => errorChunks(overloaded));

  it("retries an early stream failure and recovers without losing the turn", async () => {
    const { agent, source } = makeAgent([errorChunks(overloaded), "recovered reply"]);
    await expect(agent.reply(HANDLE, "hi")).resolves.toBe("recovered reply");
    expect(source.calls).toHaveLength(2);
  });

  it("surfaces persistent mid-loop stream failures instead of misreading them as a step-limit cut", async () => {
    const { agent, store } = makeAgent([
      toolCallChunks("bash", { command: "echo probe" }),
      ...persistentError(),
    ]);

    await expect(agent.reply(HANDLE, "look something up")).rejects.toThrow(
      "Our servers are currently overloaded. Please try again later. (server_is_overloaded)",
    );

    // The completed tool step is preserved for the next turn's context.
    const messages = store.sessionMessages(store.activeSession(HANDLE)!.id);
    const note = messages.find((message) => message.content.includes("failed with an error"));
    expect(note?.role).toBe("assistant");
    expect(note?.content).toContain("echo probe");
  });

  it("rejects a tool-less turn whose stream errors persist through all retries", async () => {
    const { agent, source } = makeAgent(persistentError());
    await expect(agent.reply(HANDLE, "hi")).rejects.toThrow("server_is_overloaded");
    expect(source.calls).toHaveLength(3);
  });

  it("falls back to the next source when the stream fails with an auth error", async () => {
    const failing = new ScriptedSource(
      "subscription",
      Array.from({ length: 3 }, () => errorChunks(new SubscriptionAuthError("expired mid-stream"))),
    );
    const { source, store, dataDir } = makeAgent(["fallback reply"]);
    const agent = new NudgeAgent({
      sources: [failing, source],
      store,
      logger: quietLogger,
      timeZone: "UTC",
      dataDir,
      systemFile: () => undefined,
      streamRetry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(agent.reply(HANDLE, "hi")).resolves.toBe("fallback reply");
  });
});
