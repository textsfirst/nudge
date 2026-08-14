import { SubscriptionAuthError } from "@nudge/agent";
import { NudgeStore } from "@nudge/store";
import { describe, expect, it, vi } from "vitest";
import { createReplyHandler } from "../src/reply.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const batch = {
  handle: "+100",
  spaceId: "space-1",
  texts: ["hi"],
  messageIds: ["m1", "m2"],
  media: [],
};

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
    expect(store.isMessageProcessed("m1")).toBe(true);
    expect(store.isMessageProcessed("m2")).toBe(true);
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

  it("ingests batch media and hands the agent projections plus refs", async () => {
    const store = new NudgeStore(":memory:");
    const received: unknown[] = [];
    const ingest = vi.fn(async () => ({
      projections: ['[image "dog.jpg"]'],
      refs: [
        {
          attachmentId: 7,
          kind: "image" as const,
          name: "dog.jpg",
          mimeType: "image/jpeg",
          path: "attachments/abc.jpg",
          visionEligible: true,
        },
      ],
    }));
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, input) => {
          received.push(input);
          return "cute dog!";
        },
      },
      store,
      logger: makeLogger(),
      media: { ingest } as unknown as import("@nudge/agent").MediaIngest,
    });

    const mediaItem = {
      kind: "image" as const,
      name: "dog.jpg",
      mimeType: "image/jpeg",
      read: async () => Buffer.from("jpg"),
    };
    await handler(
      { ...batch, texts: ["look", ""], media: [mediaItem] },
      async () => {},
      new AbortController().signal,
    );

    expect(ingest).toHaveBeenCalledWith("+100", [mediaItem], "m2");
    // Blank texts drop; projections append after the owner's words.
    expect(received).toEqual([
      {
        text: 'look\n[image "dog.jpg"]',
        media: [expect.objectContaining({ attachmentId: 7 })],
      },
    ]);
  });

  it("offers onSendFile only when multimodal is on, forwarding to the transport", async () => {
    const store = new NudgeStore(":memory:");
    const sentFiles: Array<{ name: string; mimeType: string }> = [];
    const controls = {
      stopTyping: () => {},
      react: async () => {},
      sendAttachment: async (_data: Buffer, options: { name: string; mimeType: string }) => {
        sentFiles.push(options);
      },
    };
    const media = {
      ingest: async () => ({ projections: [], refs: [] }),
    } as unknown as import("@nudge/agent").MediaIngest;

    let withMedia: unknown;
    await createReplyHandler({
      agent: {
        reply: async (_handle, _input, options) => {
          withMedia = options?.onSendFile;
          await options?.onSendFile?.(Buffer.from("png"), {
            name: "chart.png",
            mimeType: "image/png",
          });
          return "sent you the chart";
        },
      },
      store,
      logger: makeLogger(),
      media,
    })(batch, async () => {}, new AbortController().signal, controls);

    expect(typeof withMedia).toBe("function");
    expect(sentFiles).toEqual([{ name: "chart.png", mimeType: "image/png" }]);

    // Without a media ingest (multimodal off) the tool is never offered.
    let withoutMedia: unknown = "unset";
    await createReplyHandler({
      agent: {
        reply: async (_handle, _input, options) => {
          withoutMedia = options?.onSendFile;
          return "ok";
        },
      },
      store,
      logger: makeLogger(),
    })(batch, async () => {}, new AbortController().signal, controls);
    expect(withoutMedia).toBeUndefined();
  });

  it("ignores media with a warning when no ingest is configured", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
    const received: unknown[] = [];
    const handler = createReplyHandler({
      agent: {
        reply: async (_handle, input) => {
          received.push(input);
          return "ok";
        },
      },
      store,
      logger,
    });

    await handler(
      {
        ...batch,
        media: [
          {
            kind: "image" as const,
            name: "dog.jpg",
            mimeType: "image/jpeg",
            read: async () => Buffer.from("jpg"),
          },
        ],
      },
      async () => {},
      new AbortController().signal,
    );

    expect(received).toEqual(["hi"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Ignoring inbound media because multimodal is disabled",
      { count: 1 },
    );
  });

  it("skips the turn entirely for a bare media message when multimodal is off", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
    const reply = vi.fn(async () => "should never run");
    const stopTyping = vi.fn();
    const handler = createReplyHandler({ agent: { reply }, store, logger });

    await handler(
      {
        ...batch,
        texts: [""],
        media: [
          {
            kind: "voice" as const,
            name: "voice-memo.caf",
            mimeType: "audio/x-caf",
            read: async () => Buffer.from("caf"),
          },
        ],
      },
      async () => {},
      new AbortController().signal,
      { stopTyping, react: async () => {}, sendAttachment: async () => {} },
    );

    // No model turn, no empty user row — but the webhook is still settled.
    expect(reply).not.toHaveBeenCalled();
    expect(stopTyping).toHaveBeenCalled();
    expect(store.isMessageProcessed("m1")).toBe(true);
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
    expect(store.isMessageProcessed("m1")).toBe(true);
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
    expect(store.isMessageProcessed("m1")).toBe(true);
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
    expect(store.isMessageProcessed("m1")).toBe(true);
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
