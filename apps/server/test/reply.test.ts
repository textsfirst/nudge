import { SubscriptionAuthError } from "@nudge/agent";
import { NudgeStore } from "@nudge/store";
import { describe, expect, it, vi } from "vitest";
import { createReplyHandler } from "../src/reply.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const batch = { handle: "+100", spaceId: "space-1", texts: ["hi"], messageIds: ["m1", "m2"] };

describe("createReplyHandler", () => {
  it("sends the reply, journals it, and marks the webhooks processed", async () => {
    const store = new NudgeStore(":memory:");
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: { reply: async () => "hello there" },
      store,
      logger: makeLogger(),
    });

    await handler(batch, async (text) => void sent.push(text), new AbortController().signal);

    expect(sent).toEqual(["hello there"]);
    expect(store.openOutbound()).toEqual([]); // journaled and marked sent
    expect(store.isWebhookProcessed("m1")).toBe(true);
    expect(store.isWebhookProcessed("m2")).toBe(true);
  });

  it("delivers through onReplyReady before the agent finishes post-turn work", async () => {
    const store = new NudgeStore(":memory:");
    const sent: string[] = [];
    let releasePostWork!: () => void;
    const postWork = new Promise<void>((resolve) => {
      releasePostWork = resolve;
    });
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, _text, options) => {
          await options?.onReplyReady?.("hello now");
          await postWork;
          return "hello now";
        },
      },
      store,
      logger: makeLogger(),
    });

    let settled = false;
    const handling = handler(
      batch,
      async (text) => void sent.push(text),
      new AbortController().signal,
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(sent).toEqual(["hello now"]));
    expect(settled).toBe(false);
    releasePostWork();
    await handling;
    expect(sent).toEqual(["hello now"]); // callback + return value never double-send
  });

  it("forwards mid-turn progress updates straight to send, skipping the ledger", async () => {
    const store = new NudgeStore(":memory:");
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, _text, options) => {
          await options?.onProgress?.("checking flights");
          return "booked";
        },
      },
      store,
      logger: makeLogger(),
    });

    await handler(batch, async (text) => void sent.push(text), new AbortController().signal);

    expect(sent).toEqual(["checking flights", "booked"]);
    expect(store.openOutbound()).toEqual([]);
  });

  it("clears the typing indicator when the agent goes silent, and sends nothing", async () => {
    const store = new NudgeStore(":memory:");
    const controls = { stopTyping: vi.fn(), react: vi.fn(async () => {}) };
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, _text, options) => {
          options?.onSilent?.();
          return null;
        },
      },
      store,
      logger: makeLogger(),
    });

    await handler(batch, async (text) => void sent.push(text), new AbortController().signal, controls);

    expect(controls.stopTyping).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(store.isWebhookProcessed("m1")).toBe(true);
  });

  it("sends a reaction through the transport, skipping the ledger", async () => {
    const store = new NudgeStore(":memory:");
    const controls = { stopTyping: vi.fn(), react: vi.fn(async () => {}) };
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, _text, options) => {
          options?.onReaction?.("❤️");
          options?.onSilent?.();
          return null;
        },
      },
      store,
      logger: makeLogger(),
    });

    await handler(batch, async (text) => void sent.push(text), new AbortController().signal, controls);

    expect(controls.react).toHaveBeenCalledExactlyOnceWith("❤️");
    expect(sent).toEqual([]);
    expect(store.openOutbound()).toEqual([]);
  });

  it("logs and survives a reaction the transport fails to deliver", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
    const controls = {
      stopTyping: vi.fn(),
      react: vi.fn(async () => {
        throw new Error("relay down");
      }),
    };
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, _text, options) => {
          options?.onReaction?.("👍");
          return "done";
        },
      },
      store,
      logger,
    });

    const sent: string[] = [];
    await handler(batch, async (text) => void sent.push(text), new AbortController().signal, controls);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toEqual(["done"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to send the reaction",
      expect.objectContaining({ error: "relay down" }),
    );
  });

  it("drops progress updates once the run is aborted", async () => {
    const store = new NudgeStore(":memory:");
    const controller = new AbortController();
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, _text, options) => {
          controller.abort();
          await options?.onProgress?.("too late");
          throw new DOMException("aborted", "AbortError");
        },
      },
      store,
      logger: makeLogger(),
    });

    await handler(batch, async (text) => void sent.push(text), controller.signal);

    expect(sent).toEqual([]);
  });

  it("sends nothing and no apology when the reply was steered", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
    const controller = new AbortController();
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      },
      store,
      logger,
    });

    await handler(batch, async (text) => void sent.push(text), controller.signal);

    expect(sent).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    // The texts are already persisted in history, so the webhooks are done.
    expect(store.isWebhookProcessed("m1")).toBe(true);
  });

  it("drops a returned reply when steering wins just before delivery", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
    const controller = new AbortController();
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async () => {
          controller.abort();
          return "stale reply";
        },
      },
      store,
      logger,
    });

    await handler(batch, async (text) => void sent.push(text), controller.signal);

    expect(sent).toEqual([]);
    expect(store.openOutbound()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("apologizes on real failures and journals the error into the thread", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
    const session = store.startSession(batch.handle);
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async () => {
          throw new Error("model down");
        },
      },
      store,
      logger,
    });

    await handler(batch, async (text) => void sent.push(text), new AbortController().signal);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("hit a snag");
    expect(logger.error).toHaveBeenCalled();
    expect(store.isWebhookProcessed("m1")).toBe(true);
    expect(store.sessionMessages(session.id).at(-1)).toMatchObject({
      role: "error",
      content: "model down",
    });
  });

  it("gives the owner an actionable message for subscription auth failures", async () => {
    const store = new NudgeStore(":memory:");
    const sent: string[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async () => {
          throw new SubscriptionAuthError(
            "Auth expired. Reconnect it in the console (Connections page).",
          );
        },
      },
      store,
      logger: makeLogger(),
    });

    await handler(batch, async (text) => void sent.push(text), new AbortController().signal);

    expect(sent[0]).toContain("ChatGPT sign-in needs attention");
    expect(sent[0]).toContain("Connections page");
  });
});
