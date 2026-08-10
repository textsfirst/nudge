import { beforeEach, describe, expect, it, vi } from "vitest";

const spaceGet = vi.fn();
const narrower = vi.fn();
// Each created fake instance, so tests can drive its webhook callback.
const spectrumInstances: Array<{ webhook: ReturnType<typeof vi.fn> }> = [];

// Mirror the real SpectrumInstance: a Proxy whose get-trap resolves unknown
// string properties to custom event streams, never to platform instances.
// Reading `spectrum.imessage` must NOT yield anything with `.space`.
function fakeSpectrumInstance() {
  const base = {
    __providers: [],
    __internal: { platforms: new Map() },
    messages: (async function* () {})(),
    stop: vi.fn(async () => {}),
    webhook: vi.fn(),
    responding: vi.fn(async (_space: unknown, fn: () => unknown) => fn()),
  };
  spectrumInstances.push(base);
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string") return (async function* () {})();
      return undefined;
    },
  });
}

vi.mock("@spectrum-ts/core", () => ({
  Spectrum: vi.fn(async () => fakeSpectrumInstance()),
}));

vi.mock("@spectrum-ts/imessage", () => {
  const imessage = Object.assign(
    (input: unknown) => narrower(input),
    { config: vi.fn(() => ({ __tag: "PlatformProviderConfig" })) },
  );
  return { imessage };
});

import { createPhotonTransport } from "../src/transport.js";

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function transportConfig() {
  return {
    projectId: "proj",
    projectSecret: "secret",
    webhookSecret: "hook",
    ownerHandle: "+100",
    isDuplicate: () => false,
    rememberSpace: vi.fn(),
    onBatch: vi.fn(async () => {}),
    // Choreography off by default; dedicated tests opt back in.
    chunkDelayMs: 0,
    typingDelayMs: 0,
    readReceipts: false,
    // Fixed randomness pins every jitter to its midpoint.
    random: () => 0.5,
    logger,
  };
}

describe("sendToSpace", () => {
  beforeEach(() => {
    spaceGet.mockReset();
    narrower.mockReset();
  });

  it("resolves the space through the platform narrower, not a spectrum property", async () => {
    const sent: string[] = [];
    spaceGet.mockImplementation(async (id: string) => ({
      id,
      send: vi.fn(async (text: string) => {
        sent.push(text);
      }),
      startTyping: vi.fn(async () => {}),
    }));
    narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

    const transport = await createPhotonTransport(transportConfig());
    await transport.sendToSpace("chat-guid-1", "hello there");

    expect(narrower).toHaveBeenCalledTimes(1);
    // The narrower must receive the spectrum instance itself.
    const input = narrower.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.__internal).toBeDefined();
    expect(spaceGet).toHaveBeenCalledWith("chat-guid-1");
    expect(sent).toEqual(["hello there"]);
  });

  it("chunks long text into sequential sends on the resolved space", async () => {
    const sent: string[] = [];
    spaceGet.mockImplementation(async (id: string) => ({
      id,
      send: vi.fn(async (text: string) => {
        sent.push(text);
      }),
      startTyping: vi.fn(async () => {}),
    }));
    narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

    const transport = await createPhotonTransport(transportConfig());
    await transport.sendToSpace("chat-guid-2", "a".repeat(1500));

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join("")).toBe("a".repeat(1500));
  });

  it("sends one message per paragraph", async () => {
    const sent: string[] = [];
    spaceGet.mockImplementation(async (id: string) => ({
      id,
      send: vi.fn(async (text: string) => {
        sent.push(text);
      }),
      startTyping: vi.fn(async () => {}),
    }));
    narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

    const transport = await createPhotonTransport(transportConfig());
    await transport.sendToSpace("chat-guid-4", "on it\n\nlands 6:30pm\nno rain expected");

    expect(sent).toEqual(["on it", "lands 6:30pm\nno rain expected"]);
  });

  it("resumes after skipped bubbles, preamble first, reporting progress", async () => {
    const sent: string[] = [];
    spaceGet.mockImplementation(async (id: string) => ({
      id,
      send: vi.fn(async (text: string) => {
        sent.push(text);
      }),
      startTyping: vi.fn(async () => {}),
    }));
    narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

    const progress: number[] = [];
    const transport = await createPhotonTransport(transportConfig());
    await transport.sendToSpace("chat-guid-6", "one\n\ntwo\n\nthree", {
      skipChunks: 1,
      preamble: "got cut off - the rest:",
      onChunkSent: (count) => progress.push(count),
    });

    expect(sent).toEqual(["got cut off - the rest:", "two", "three"]);
    // Progress counts are absolute, including the skipped bubble.
    expect(progress).toEqual([2, 3]);
  });

  it("sends nothing, not even the preamble, when every bubble already landed", async () => {
    const sent: string[] = [];
    spaceGet.mockImplementation(async (id: string) => ({
      id,
      send: vi.fn(async (text: string) => {
        sent.push(text);
      }),
      startTyping: vi.fn(async () => {}),
    }));
    narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

    const transport = await createPhotonTransport(transportConfig());
    await transport.sendToSpace("chat-guid-7", "one\n\ntwo", {
      skipChunks: 2,
      preamble: "not sure that went through, so again:",
    });

    expect(sent).toEqual([]);
  });

  it("paces multi-bubble sends by the next bubble's length, typing through the gap", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const startTyping = vi.fn(async () => {});
      const stopTyping = vi.fn(async () => {});
      spaceGet.mockImplementation(async (id: string) => ({
        id,
        send: vi.fn(async (text: string) => {
          sent.push(text);
        }),
        startTyping,
        stopTyping,
      }));
      narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

      const transport = await createPhotonTransport({
        ...transportConfig(),
        chunkDelayMs: 400,
      });
      const delivery = transport.sendToSpace("chat-guid-5", "first\n\nsecond");

      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual(["first"]);
      // The indicator re-shows through the pause so the gap reads as typing.
      expect(startTyping).toHaveBeenCalledTimes(1);
      // Gap = 400ms base + 25ms/char × "second" (6 chars) = 550ms.
      await vi.advanceTimersByTimeAsync(549);
      expect(sent).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(1);
      await delivery;
      expect(sent).toEqual(["first", "second"]);
      // The asserted indicator must not outlive the last bubble.
      expect(stopTyping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a narrower failure instead of masking it", async () => {
    narrower.mockImplementation(() => {
      throw new Error('Platform "imessage" is not registered');
    });

    const transport = await createPhotonTransport(transportConfig());
    await expect(transport.sendToSpace("chat-guid-3", "hi")).rejects.toThrow(
      /not registered/,
    );
  });
});

interface TestControls {
  stopTyping: () => void;
  react: (emoji: string) => Promise<void>;
}

function fakeSpace() {
  return {
    id: "space-1",
    send: vi.fn(async () => {}),
    startTyping: vi.fn(async () => {}),
    stopTyping: vi.fn(async () => {}),
  };
}

describe("batch controls", () => {
  it("gives onBatch a stopTyping that clears the indicator on the batch's space", async () => {
    const space = fakeSpace();
    const onBatch = vi.fn(
      async (_batch: unknown, _send: unknown, _signal: unknown, controls: TestControls) => {
        controls.stopTyping();
      },
    );
    const transport = await createPhotonTransport({
      ...transportConfig(),
      debounceMs: 0,
      onBatch,
    });
    const instance = spectrumInstances.at(-1)!;
    instance.webhook.mockImplementation(
      async (_request: unknown, handle: (space: unknown, message: unknown) => Promise<void>) => {
        await handle(space, {
          id: "msg-1",
          platform: "imessage",
          sender: { id: "+100" },
          content: { type: "text", text: "thanks" },
          react: vi.fn(async () => {}),
        });
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    );

    await transport.webhook({ body: Buffer.from("{}"), headers: {} });
    await transport.flushInbound();

    expect(onBatch).toHaveBeenCalledTimes(1);
    // Shown while the text buffered, cleared the moment the handler said so.
    expect(space.startTyping).toHaveBeenCalled();
    expect(space.stopTyping).toHaveBeenCalledTimes(1);
  });

  it("routes controls.react to the newest message of the batch", async () => {
    const space = fakeSpace();
    const firstReact = vi.fn(async () => {});
    const secondReact = vi.fn(async () => {});
    const onBatch = vi.fn(
      async (_batch: unknown, _send: unknown, _signal: unknown, controls: TestControls) => {
        await controls.react("❤️");
      },
    );
    const transport = await createPhotonTransport({
      ...transportConfig(),
      debounceMs: 5,
      onBatch,
    });
    const instance = spectrumInstances.at(-1)!;
    let deliveries = 0;
    instance.webhook.mockImplementation(
      async (_request: unknown, handle: (space: unknown, message: unknown) => Promise<void>) => {
        deliveries += 1;
        await handle(space, {
          id: `msg-${deliveries}`,
          platform: "imessage",
          sender: { id: "+100" },
          content: { type: "text", text: `text ${deliveries}` },
          react: deliveries === 1 ? firstReact : secondReact,
        });
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    );

    // Two texts buffer into one batch; the tapback must land on the second.
    await transport.webhook({ body: Buffer.from("{}"), headers: {} });
    await transport.webhook({ body: Buffer.from("{}"), headers: {} });
    await transport.flushInbound();

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(firstReact).not.toHaveBeenCalled();
    expect(secondReact).toHaveBeenCalledExactlyOnceWith("❤️");
  });
});

function ownerMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    platform: "imessage",
    sender: { id: "+100" },
    content: { type: "text", text: "hey" },
    react: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("typing choreography", () => {
  it("shows the indicator only after the humanizing delay, then clears on settle", async () => {
    vi.useFakeTimers();
    try {
      const space = fakeSpace();
      let release!: () => void;
      const onBatch = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const transport = await createPhotonTransport({
        ...transportConfig(),
        debounceMs: 0,
        typingDelayMs: 800,
        onBatch,
      });
      const instance = spectrumInstances.at(-1)!;
      instance.webhook.mockImplementation(
        async (_request: unknown, handle: (space: unknown, message: unknown) => Promise<void>) => {
          await handle(space, ownerMessage("msg-t1"));
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      );

      await transport.webhook({ body: Buffer.from("{}"), headers: {} });
      await vi.advanceTimersByTimeAsync(0);
      // Generation is already running, but the indicator waits out its delay.
      expect(onBatch).toHaveBeenCalledTimes(1);
      expect(space.startTyping).not.toHaveBeenCalled();
      // random 0.5 pins the jitter to its midpoint: exactly 800ms.
      await vi.advanceTimersByTimeAsync(799);
      expect(space.startTyping).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(space.startTyping).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(space.stopTyping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a turn that goes silent before the delay never shows an indicator", async () => {
    vi.useFakeTimers();
    try {
      const space = fakeSpace();
      const onBatch = vi.fn(
        async (_batch: unknown, _send: unknown, _signal: unknown, controls: TestControls) => {
          controls.stopTyping();
        },
      );
      const transport = await createPhotonTransport({
        ...transportConfig(),
        debounceMs: 0,
        typingDelayMs: 800,
        onBatch,
      });
      const instance = spectrumInstances.at(-1)!;
      instance.webhook.mockImplementation(
        async (_request: unknown, handle: (space: unknown, message: unknown) => Promise<void>) => {
          await handle(space, ownerMessage("msg-t2"));
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      );

      await transport.webhook({ body: Buffer.from("{}"), headers: {} });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onBatch).toHaveBeenCalledTimes(1);
      // The pending showing was cancelled; nothing ever hit the wire.
      expect(space.startTyping).not.toHaveBeenCalled();
      expect(space.stopTyping).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("read receipts", () => {
  it("marks the owner's text read a jittered beat after it arrives", async () => {
    vi.useFakeTimers();
    try {
      const space = fakeSpace();
      const read = vi.fn(async () => {});
      const transport = await createPhotonTransport({
        ...transportConfig(),
        readReceipts: true,
      });
      const instance = spectrumInstances.at(-1)!;
      instance.webhook.mockImplementation(
        async (_request: unknown, handle: (space: unknown, message: unknown) => Promise<void>) => {
          await handle(space, ownerMessage("msg-r1", { read }));
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      );

      await transport.webhook({ body: Buffer.from("{}"), headers: {} });
      // random 0.5 pins the jitter: 300ms floor + half the 500ms span = 550ms.
      await vi.advanceTimersByTimeAsync(549);
      expect(read).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when read receipts are disabled", async () => {
    vi.useFakeTimers();
    try {
      const space = fakeSpace();
      const read = vi.fn(async () => {});
      const transport = await createPhotonTransport({
        ...transportConfig(),
        readReceipts: false,
      });
      const instance = spectrumInstances.at(-1)!;
      instance.webhook.mockImplementation(
        async (_request: unknown, handle: (space: unknown, message: unknown) => Promise<void>) => {
          await handle(space, ownerMessage("msg-r2", { read }));
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      );

      await transport.webhook({ body: Buffer.from("{}"), headers: {} });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
