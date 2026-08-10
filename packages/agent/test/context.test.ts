import { describe, expect, it } from "vitest";
import type { MessageRow } from "@nudge/store";
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  estimateTokens,
  planCompaction,
  RESERVE_TOKENS,
  usableWindow,
} from "../src/context.js";

function row(id: number, role: "user" | "assistant" | "error", content: string): MessageRow {
  return {
    id,
    sessionId: 1,
    handle: "+15551234567",
    role,
    content,
    toolPayload: null,
    inputTokens: null,
    outputTokens: null,
    createdAt: id,
  };
}

const budget = { contextWindow: 100_000, compactAtFraction: 0.8, keepRecentTokens: 1_000 };

describe("estimateTokens", () => {
  it("counts ~4 ASCII characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);
  });

  it("counts non-ASCII characters as a full token each", () => {
    // CJK really is ~1 token per character; chars/4 would undercount 4x.
    expect(estimateTokens("好".repeat(100))).toBe(100);
    expect(estimateTokens("ab好好")).toBe(3);
  });
});

describe("contextWindowFor", () => {
  it("resolves known model families to their input caps", () => {
    expect(contextWindowFor("gpt-5.4-mini")).toBe(272_000);
    expect(contextWindowFor("gpt-5-mini")).toBe(272_000);
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("o3-mini")).toBe(200_000);
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
  });

  it("falls back to a conservative default for unknown models", () => {
    expect(contextWindowFor("some-local-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("usableWindow", () => {
  it("subtracts the reserve, floored at half the window", () => {
    expect(usableWindow(200_000)).toBe(200_000 - RESERVE_TOKENS);
    expect(usableWindow(10_000)).toBe(5_000); // reserve would leave nothing
  });
});

describe("planCompaction", () => {
  it("returns null while the estimated prompt fits", () => {
    const messages = [row(1, "user", "hi"), row(2, "assistant", "hello")];
    expect(planCompaction({ messages, systemTokens: 500, budget })).toBeNull();
  });

  it("folds older rows and opens the kept window on a user row", () => {
    // Each big row is ~30k tokens; the threshold is 80% of the 68k usable.
    const big = "x".repeat(120_000);
    const messages = [
      row(1, "user", big),
      row(2, "assistant", "ack one"),
      row(3, "user", big),
      row(4, "assistant", "ack two"),
      row(5, "user", "small question"),
      row(6, "assistant", "small answer"),
    ];
    const plan = planCompaction({ messages, systemTokens: 1_000, budget });
    expect(plan).not.toBeNull();
    // The token walk stops at row 4, then advances to the user row 5.
    expect(plan!.keep[0]!.role).toBe("user");
    expect(plan!.keep.map((m) => m.id)).toEqual([5, 6]);
    expect(plan!.fold.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it("always keeps the final two rows even when they blow the keep budget", () => {
    const big = "x".repeat(100_000);
    const messages = [row(1, "user", big), row(2, "user", big), row(3, "assistant", big)];
    const plan = planCompaction({ messages, systemTokens: 0, budget });
    expect(plan!.keep.map((m) => m.id)).toEqual([2, 3]);
    expect(plan!.fold.map((m) => m.id)).toEqual([1]);
  });

  it("returns null when nothing would fold", () => {
    // Over threshold, but the whole history is inside the min-keep tail.
    const messages = [row(1, "user", "x".repeat(400_000))];
    expect(planCompaction({ messages, systemTokens: 0, budget })).toBeNull();
  });

  it("aggressive mode folds even under the threshold and keeps only a sliver", () => {
    const messages = [
      row(1, "user", "one"),
      row(2, "assistant", "two"),
      row(3, "user", "three"),
      row(4, "assistant", "four"),
    ];
    expect(planCompaction({ messages, systemTokens: 0, budget })).toBeNull();
    const plan = planCompaction({ messages, systemTokens: 0, budget, aggressive: true });
    // Everything fits the aggressive keep budget, so it falls back to the
    // minimum tail — overflow recovery must always make progress.
    expect(plan!.fold.map((m) => m.id)).toEqual([1, 2]);
    expect(plan!.keep.map((m) => m.id)).toEqual([3, 4]);
  });

  it("compacts to a floor far below the trigger so folds cannot cascade", () => {
    const filler = "x".repeat(4_000); // ~1k tokens per row
    const messages = Array.from({ length: 80 }, (_, i) =>
      row(i + 1, i % 2 === 0 ? "user" : "assistant", filler),
    );
    const plan = planCompaction({ messages, systemTokens: 1_000, budget });
    expect(plan).not.toBeNull();
    const keptTokens = plan!.keep.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const threshold = usableWindow(budget.contextWindow) * budget.compactAtFraction;
    expect(keptTokens).toBeLessThan(threshold / 2);
  });
});
