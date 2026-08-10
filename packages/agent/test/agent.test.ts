import { describe, expect, it } from "vitest";
import { NudgeAgent, SubscriptionAuthError } from "../src/index.js";
import type { ModelSource } from "../src/index.js";
import { makeAgent, promptMessages, quietLogger, toolCallChunks } from "./helpers.js";

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

  it("compacts long threads into a rolling summary", async () => {
    const script = [
      "r1",
      "r2",
      "r3", // third exchange pushes past the cap...
      "compacted summary", // ...so a summarize call follows
      "r4",
    ];
    const { agent, store, source } = makeAgent(script, { compactAfterMessages: 4 });

    await agent.reply(HANDLE, "m1");
    await agent.reply(HANDLE, "m2");
    await agent.reply(HANDLE, "m3");

    const session = store.activeSession(HANDLE)!;
    expect(session.summary).toBe("compacted summary");
    expect(session.compactedThrough).toBeGreaterThan(0);

    await agent.reply(HANDLE, "m4");
    const lastCall = promptMessages(source.calls[4]!);
    expect(lastCall[0]?.text).toContain("Earlier in this thread");
    // Folded turns are no longer replayed verbatim.
    expect(lastCall.filter((message) => message.role !== "system").length).toBeLessThan(7);
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
});

describe("model source fallback", () => {
  const failing: ModelSource = {
    id: "subscription",
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
