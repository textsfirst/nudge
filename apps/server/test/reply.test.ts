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

  it("apologizes on real failures", async () => {
    const store = new NudgeStore(":memory:");
    const logger = makeLogger();
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
    expect(sent[0]).toContain("something went wrong");
    expect(logger.error).toHaveBeenCalled();
    expect(store.isWebhookProcessed("m1")).toBe(true);
  });
});
