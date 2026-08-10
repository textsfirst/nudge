import { describe, expect, it } from "vitest";
import { windDownSteps } from "../src/loop.js";
import { makeAgent, promptMessages, toolCallChunks } from "./helpers.js";

const HANDLE = "+15551234567";

const repeatIdentical = () => toolCallChunks("bash", { command: "echo loop" });

describe("agent loop limits", () => {
  it("injects a wind-down note when the step cap is near, without persisting it", async () => {
    // maxToolSteps 4 → the note lands before the second model call (3 remain).
    const { agent, store, source } = makeAgent(
      [toolCallChunks("bash", { command: "echo one" }), "all done"],
      { maxToolSteps: 4 },
    );

    await expect(agent.reply(HANDLE, "run something")).resolves.toBe("all done");

    const secondCall = promptMessages(source.calls[1]!);
    const note = secondCall.filter((message) => message.role === "user").at(-1);
    expect(note?.text).toContain("tool steps");
    expect(note?.text).toContain("only 3 model calls remain");
    expect(note?.text).toContain("Wrap up");

    // The injected note is loop-internal; thread history stays clean.
    const messages = store.sessionMessages(store.activeSession(HANDLE)!.id);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "run something"],
      ["assistant", "all done"],
    ]);
  });

  it("gives a bigger cap a proportionally longer wind-down runway", () => {
    expect(windDownSteps(4)).toBe(3);
    expect(windDownSteps(64)).toBe(4);
    expect(windDownSteps(256)).toBe(16);
  });

  it("does not inject the note on short runs", async () => {
    const { agent, source } = makeAgent(
      [toolCallChunks("bash", { command: "echo hi" }), "done"],
      { maxToolSteps: 10 },
    );
    await agent.reply(HANDLE, "quick one");
    for (const call of source.calls) {
      for (const message of promptMessages(call)) {
        expect(message.text).not.toContain("Wrap up");
      }
    }
  });

  it("nudges a multi-step turn that has texted the owner nothing", async () => {
    const commands = ["echo a", "echo b", "echo c", "echo d"];
    const { agent, source } = makeAgent([
      ...commands.map((command) => toolCallChunks("bash", { command })),
      "done",
    ]);

    await expect(
      agent.reply(HANDLE, "long job", { onProgress: async () => undefined }),
    ).resolves.toBe("done");

    // The nudge lands before the fifth model call, and only there.
    const note = promptMessages(source.calls[4]!)
      .filter((message) => message.role === "user")
      .at(-1);
    expect(note?.text).toContain("owner has heard nothing");
    expect(note?.text).toContain("send_update");
    for (const call of source.calls.slice(0, 4)) {
      for (const message of promptMessages(call)) {
        expect(message.text).not.toContain("owner has heard nothing");
      }
    }
  });

  it("does not nudge once the model has already texted an update", async () => {
    const { agent, source } = makeAgent([
      toolCallChunks("send_update", { text: "on it" }),
      ...["echo a", "echo b", "echo c", "echo d"].map((command) =>
        toolCallChunks("bash", { command }),
      ),
      "done",
    ]);

    await agent.reply(HANDLE, "long job", { onProgress: async () => undefined });

    for (const call of source.calls) {
      for (const message of promptMessages(call)) {
        expect(message.text).not.toContain("owner has heard nothing");
      }
    }
  });

  it("does not nudge when the send_update tool is absent", async () => {
    const { agent, source } = makeAgent([
      ...["echo a", "echo b", "echo c", "echo d"].map((command) =>
        toolCallChunks("bash", { command }),
      ),
      "done",
    ]);

    await agent.reply(HANDLE, "long job");

    for (const call of source.calls) {
      for (const message of promptMessages(call)) {
        expect(message.text).not.toContain("owner has heard nothing");
      }
    }
  });

  it("never flags repeated calls whose results change (polling with progress)", async () => {
    // The same command seven times, but each run appends a line and prints the
    // new count — identical input, different output every step. That is
    // legitimate repetition and must sail through untouched.
    const poll = () =>
      toolCallChunks("bash", { command: "echo x >> poll.log && wc -l < poll.log" });
    const { agent, source } = makeAgent([
      ...Array.from({ length: 7 }, poll),
      "the job finished",
    ]);

    await expect(agent.reply(HANDLE, "watch the job")).resolves.toBe("the job finished");
    expect(source.calls).toHaveLength(8);
    for (const call of source.calls) {
      for (const message of promptMessages(call)) {
        expect(message.text).not.toContain("identical results");
        expect(message.text).not.toContain("tool loop was stopped");
      }
    }
  });

  it("warns after identical no-progress steps and lets the model recover", async () => {
    // Three identical calls with identical output draw a warning, not a stop —
    // the model course-corrects and replies normally.
    const { agent, store, source } = makeAgent([
      repeatIdentical(),
      repeatIdentical(),
      repeatIdentical(),
      "sorry, I was going in circles — here is the answer",
    ]);

    await expect(agent.reply(HANDLE, "do the thing")).resolves.toBe(
      "sorry, I was going in circles — here is the answer",
    );
    expect(source.calls).toHaveLength(4);

    const warned = promptMessages(source.calls[3]!)
      .filter((message) => message.role === "user")
      .at(-1);
    expect(warned?.text).toContain("identical results");
    expect(warned?.text).toContain("If that is deliberate");

    // The warning is loop-internal; thread history stays clean.
    const messages = store.sessionMessages(store.activeSession(HANDLE)!.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).not.toContain("identical results");
  });

  it("stops a warned no-progress loop and still replies with a status", async () => {
    // Six identical no-progress steps: warned at three, stopped at six, then a
    // final tool-less call asks the model to report instead of erroring out.
    const { agent, store, source } = makeAgent([
      ...Array.from({ length: 6 }, repeatIdentical),
      "I got stuck repeating myself; here is where things stand.",
    ]);

    await expect(agent.reply(HANDLE, "do the thing")).resolves.toBe(
      "I got stuck repeating myself; here is where things stand.",
    );
    expect(source.calls).toHaveLength(7);

    // Warned exactly once despite the streak continuing past the threshold.
    const lastLoopCall = promptMessages(source.calls[5]!);
    expect(
      lastLoopCall.filter((message) => message.text.includes("identical results")),
    ).toHaveLength(1);

    const wrapUpCall = promptMessages(source.calls[6]!);
    const note = wrapUpCall.filter((message) => message.role === "user").at(-1);
    expect(note?.text).toContain("tool loop was stopped");
    expect(note?.text).toContain("echo loop");

    const assistant = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant");
    expect(assistant?.toolPayload).toContain("echo loop");
  });

  it("lets varied tool calls run past the old-style small caps", async () => {
    // Ten distinct calls — no stall, no cap — then a normal reply.
    const script = [
      ...Array.from({ length: 10 }, (_, index) =>
        toolCallChunks("bash", { command: `echo step ${index}` }),
      ),
      "finished the long task",
    ];
    const { agent } = makeAgent(script);
    await expect(agent.reply(HANDLE, "big job")).resolves.toBe("finished the long task");
  });

  it("wraps up gracefully when the hard cap lands mid-task", async () => {
    const { agent, source } = makeAgent(
      [
        toolCallChunks("bash", { command: "echo a" }),
        toolCallChunks("bash", { command: "echo b" }),
        "ran out of steps; progress saved",
      ],
      { maxToolSteps: 2 },
    );

    await expect(agent.reply(HANDLE, "long job")).resolves.toBe(
      "ran out of steps; progress saved",
    );
    // The wrap-up call carries the tool trace and offers no tools.
    const wrapUpCall = source.calls[2]!;
    expect(wrapUpCall.tools ?? []).toHaveLength(0);
    const note = promptMessages(wrapUpCall)
      .filter((message) => message.role === "user")
      .at(-1);
    expect(note?.text).toContain("tool loop was stopped");
  });

  it("falls back to a fixed status message when even the wrap-up returns nothing", async () => {
    const { agent } = makeAgent(
      [
        toolCallChunks("bash", { command: "echo a" }),
        toolCallChunks("bash", { command: "echo b" }),
        "", // the wrap-up call itself comes back empty
      ],
      { maxToolSteps: 2 },
    );

    await expect(agent.reply(HANDLE, "long job")).resolves.toContain(
      "hit my step limit mid-task",
    );
  });
});
