import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypingController } from "../src/typing.js";

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function fakeSpace(id = "space-1") {
  return {
    id,
    startTyping: vi.fn(async () => {}),
    stopTyping: vi.fn(async () => {}),
  };
}

describe("TypingController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logger.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the indicator only after the delay", async () => {
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0.5 });
    const space = fakeSpace();

    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(999);
    expect(space.startTyping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(space.startTyping).toHaveBeenCalledTimes(1);
  });

  it("jitters the delay from the injected randomness", async () => {
    // random() = 0 lands at the low end of the ±20% band: 800ms of 1000ms.
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0 });
    const space = fakeSpace();

    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(799);
    expect(space.startTyping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(space.startTyping).toHaveBeenCalledTimes(1);
  });

  it("keeps one clock across repeated schedules", async () => {
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0.5 });
    const space = fakeSpace();

    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(600);
    // A follow-up text must not reset the pending delay.
    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(400);
    expect(space.startTyping).toHaveBeenCalledTimes(1);
  });

  it("shows immediately when the delay is zero", async () => {
    const controller = new TypingController({ logger, startDelayMs: 0 });
    const space = fakeSpace();

    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(0);
    expect(space.startTyping).toHaveBeenCalledTimes(1);
  });

  it("stop before the delay cancels the showing without a wire stop", async () => {
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0.5 });
    const space = fakeSpace();

    controller.schedule(space);
    controller.stop(space);
    await vi.advanceTimersByTimeAsync(2000);
    expect(space.startTyping).not.toHaveBeenCalled();
    expect(space.stopTyping).not.toHaveBeenCalled();
  });

  it("stop after a showing clears the indicator exactly once", async () => {
    const controller = new TypingController({ logger, startDelayMs: 0 });
    const space = fakeSpace();

    controller.schedule(space);
    controller.stop(space);
    controller.stop(space);
    await vi.advanceTimersByTimeAsync(0);
    expect(space.stopTyping).toHaveBeenCalledTimes(1);
  });

  it("assert resends even while showing — the keepalive path", async () => {
    const controller = new TypingController({ logger, startDelayMs: 0 });
    const space = fakeSpace();

    controller.assert(space);
    controller.assert(space);
    await vi.advanceTimersByTimeAsync(0);
    expect(space.startTyping).toHaveBeenCalledTimes(2);
  });

  it("schedule is a no-op while the indicator is showing", async () => {
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0.5 });
    const space = fakeSpace();

    controller.assert(space);
    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(5000);
    expect(space.startTyping).toHaveBeenCalledTimes(1);
  });

  it("fires on the freshest space object for the id", async () => {
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0.5 });
    const stale = fakeSpace();
    const fresh = fakeSpace();

    controller.schedule(stale);
    controller.schedule(fresh);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stale.startTyping).not.toHaveBeenCalled();
    expect(fresh.startTyping).toHaveBeenCalledTimes(1);
  });

  it("clear drops pending showings without sending anything", async () => {
    const controller = new TypingController({ logger, startDelayMs: 1000, random: () => 0.5 });
    const space = fakeSpace();

    controller.schedule(space);
    controller.clear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(space.startTyping).not.toHaveBeenCalled();
  });

  it("logs indicator failures at debug instead of surfacing them", async () => {
    const controller = new TypingController({ logger, startDelayMs: 0 });
    const space = {
      id: "space-1",
      startTyping: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      stopTyping: vi.fn(async () => {}),
    };

    controller.schedule(space);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.debug).toHaveBeenCalledWith(
      "Failed to start the typing indicator",
      expect.objectContaining({ error: "socket closed" }),
    );
  });
});
