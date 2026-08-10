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
    // Bubble pacing off by default; the pacing test opts back in.
    chunkDelayMs: 0,
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

  it("paces multi-bubble sends with the configured delay", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      spaceGet.mockImplementation(async (id: string) => ({
        id,
        send: vi.fn(async (text: string) => {
          sent.push(text);
        }),
        startTyping: vi.fn(async () => {}),
      }));
      narrower.mockImplementation(() => ({ space: { get: spaceGet } }));

      const transport = await createPhotonTransport({
        ...transportConfig(),
        chunkDelayMs: 400,
      });
      const delivery = transport.sendToSpace("chat-guid-5", "first\n\nsecond");

      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(399);
      expect(sent).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(1);
      await delivery;
      expect(sent).toEqual(["first", "second"]);
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
