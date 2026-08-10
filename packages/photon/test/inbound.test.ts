import { describe, expect, it, vi } from "vitest";
import { InboundProcessor, splitMessage, type InboundBatch } from "../src/index.js";

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function message(id: string, text: string, handle = "+100") {
  return { id, handle, text, spaceId: "space-1", platform: "imessage" };
}

function collector() {
  const batches: { batch: InboundBatch; context: unknown }[] = [];
  const onBatch = vi.fn(async (batch: InboundBatch, context: unknown) => {
    batches.push({ batch, context });
  });
  return { batches, onBatch };
}

describe("InboundProcessor", () => {
  it("processes only the configured owner over iMessage", async () => {
    const { batches, onBatch } = collector();
    const processor = new InboundProcessor({
      ownerHandle: "+100",
      logger,
      isDuplicate: () => false,
      onBatch,
      debounceMs: 5,
    });

    processor.process(message("1", "no", "+999"), null);
    processor.process({ ...message("2", "nope"), platform: "telegram" }, null);
    processor.process(message("3", "yes"), null);
    await processor.flushNow();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.batch.texts).toEqual(["yes"]);
  });

  it("debounces bursts into one batch with the latest context", async () => {
    const { batches, onBatch } = collector();
    const processor = new InboundProcessor<{ space: string }>({
      ownerHandle: "+100",
      logger,
      isDuplicate: () => false,
      onBatch,
      debounceMs: 30,
    });

    processor.process(message("1", "are you"), { space: "old" });
    processor.process(message("2", "there?"), { space: "new" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.batch.texts).toEqual(["are you", "there?"]);
    expect(batches[0]?.batch.messageIds).toEqual(["1", "2"]);
    expect(batches[0]?.context).toEqual({ space: "new" });
  });

  it("drops duplicates via the durable check and the in-flight buffer", async () => {
    const processed = new Set(["already-done"]);
    const { batches, onBatch } = collector();
    const processor = new InboundProcessor({
      ownerHandle: "+100",
      logger,
      isDuplicate: (id) => processed.has(id),
      onBatch,
      debounceMs: 5,
    });

    processor.process(message("already-done", "old"), null);
    processor.process(message("fresh", "hi"), null);
    processor.process(message("fresh", "hi"), null);
    await processor.flushNow();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.batch.messageIds).toEqual(["fresh"]);
  });

  it("starts immediately at zero debounce and steers when a newer message arrives", async () => {
    const steerLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const seen: { texts: string[]; signal: AbortSignal }[] = [];
    const onBatch = vi.fn(async (batch: InboundBatch, _context: unknown, signal: AbortSignal) => {
      seen.push({ texts: batch.texts, signal });
      if (seen.length === 1) {
        // A slow model call that honors the abort, like streamText does.
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort, { once: true });
        });
      }
    });
    const processor = new InboundProcessor({
      ownerHandle: "+100",
      logger: steerLogger,
      isDuplicate: () => false,
      onBatch,
      debounceMs: 0,
    });

    processor.process(message("1", "book friday"), null);
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(1));
    processor.process(message("2", "actually saturday"), null);
    expect(seen[0]?.signal.aborted).toBe(true);
    await processor.flushNow();

    expect(seen).toHaveLength(2);
    expect(seen[1]?.texts).toEqual(["actually saturday"]);
    expect(seen[1]?.signal.aborted).toBe(false);
    // A steered run is expected, not an error.
    expect(steerLogger.error).not.toHaveBeenCalled();
    expect(steerLogger.debug).toHaveBeenCalledWith("A reply was steered by a newer message", {
      messageIds: ["1"],
    });
  });

  it("holds follow-up texts together when the steered run ignores cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const onBatch = vi.fn(async (batch: InboundBatch) => {
      calls.push(batch.texts);
      // The first run ignores its abort signal and finishes on its own time.
      if (calls.length === 1) await gate;
    });
    const processor = new InboundProcessor({
      ownerHandle: "+100",
      logger,
      isDuplicate: () => false,
      onBatch,
      debounceMs: 0,
    });

    processor.process(message("1", "first"), null);
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(1));
    processor.process(message("2", "second"), null);
    await new Promise((resolve) => setTimeout(resolve, 20)); // debounce expires while busy
    processor.process(message("3", "third"), null);
    release();
    await processor.flushNow();

    expect(calls).toEqual([["first"], ["second", "third"]]);
  });

  it("signals waiting from the first buffered text and again after a steered settle", async () => {
    const waits: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onBatch = vi.fn(async (batch: InboundBatch) => {
      // The first batch ignores its abort signal and finishes on release.
      if (batch.texts.includes("first")) await gate;
    });
    const processor = new InboundProcessor<string>({
      ownerHandle: "+100",
      logger,
      isDuplicate: () => false,
      onBatch,
      onWaiting: (context) => {
        waits.push(context);
      },
      debounceMs: 30,
    });

    processor.process(message("0", "ignored", "+999"), "ctx-0");
    expect(waits).toEqual([]); // filtered messages never show typing

    processor.process(message("1", "first"), "ctx-1");
    expect(waits).toEqual(["ctx-1"]); // typing starts before the debounce elapses
    processor.process(message("2", "second"), "ctx-2");
    expect(waits).toEqual(["ctx-1", "ctx-2"]);

    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(1));
    processor.process(message("3", "third"), "ctx-3"); // steers the running reply
    release();
    // The settling run re-asserts typing for the still-buffered batch.
    await vi.waitFor(() => expect(waits).toEqual(["ctx-1", "ctx-2", "ctx-3", "ctx-3"]));
    await processor.flushNow();
    expect(onBatch).toHaveBeenCalledTimes(2);
  });

  it("keeps serving after a batch handler throws", async () => {
    const onBatch = vi
      .fn<(batch: InboundBatch, context: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("model down"))
      .mockResolvedValue(undefined);
    const processor = new InboundProcessor({
      ownerHandle: "+100",
      logger,
      isDuplicate: () => false,
      onBatch,
      debounceMs: 5,
    });

    processor.process(message("1", "first"), null);
    await processor.flushNow();
    processor.process(message("2", "second"), null);
    await processor.flushNow();

    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("splitMessage", () => {
  it("returns a short single paragraph untouched", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("sends every paragraph as its own message, even short ones", () => {
    expect(splitMessage("on it\n\nMU771 lands 6:30pm\n\nno rain gear needed")).toEqual([
      "on it",
      "MU771 lands 6:30pm",
      "no rain gear needed",
    ]);
  });

  it("keeps single line breaks inside one message", () => {
    expect(splitMessage("AMS: 24C, clear\nDelft: 21C, clear")).toEqual([
      "AMS: 24C, clear\nDelft: 21C, clear",
    ]);
  });

  it("drops blank paragraphs from stray whitespace", () => {
    expect(splitMessage("first\n\n   \n\nsecond")).toEqual(["first", "second"]);
  });

  it("splits a single oversized paragraph on word boundaries", () => {
    const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    const chunks = splitMessage(words, 500);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join(" ").split(" ")).toHaveLength(400);
  });
});
