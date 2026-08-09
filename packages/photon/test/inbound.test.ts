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
  it("returns short messages untouched", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("splits on paragraph boundaries under the limit", () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index} ${"x".repeat(300)}`);
    const chunks = splitMessage(paragraphs.join("\n\n"), 1_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1_000)).toBe(true);
    expect(chunks.join("\n\n")).toContain("Paragraph 5");
  });

  it("splits a single oversized paragraph on word boundaries", () => {
    const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    const chunks = splitMessage(words, 500);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join(" ").split(" ")).toHaveLength(400);
  });
});
