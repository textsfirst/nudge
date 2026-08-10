import { beforeEach, describe, expect, it, vi } from "vitest";

const spaceGet = vi.fn();
const narrower = vi.fn();

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
