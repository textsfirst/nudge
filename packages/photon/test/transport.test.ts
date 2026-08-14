import { beforeEach, describe, expect, it, vi } from "vitest";

const spaceGet = vi.fn();
const narrower = vi.fn();

interface FakeSpectrumInstance {
  /**
   * Push one inbound [space, message] pair into the fake `spectrum.messages`
   * stream. Resolves once the transport's consumer loop has fully handled it
   * (the ack fires when the loop asks for the next tuple), so tests can
   * assert right after awaiting — no sleeps or tick-counting.
   */
  emit: (space: unknown, message: unknown) => Promise<void>;
  /** End the stream, letting the transport's consumer loop finish. */
  end: () => void;
  stop: ReturnType<typeof vi.fn>;
}

// Each created fake instance, so tests can feed its message stream.
const spectrumInstances: FakeSpectrumInstance[] = [];

function fakeMessageStream() {
  interface Entry {
    tuple: [unknown, unknown];
    ack: () => void;
  }
  const queue: Entry[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  const iterable = (async function* () {
    for (;;) {
      while (queue.length === 0) {
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const entry = queue.shift();
      if (!entry) continue;
      yield entry.tuple;
      // The generator resumes here only when the consumer pulls the next
      // tuple, i.e. after its loop body finished handling this one.
      entry.ack();
    }
  })();
  return {
    iterable,
    emit(space: unknown, message: unknown) {
      return new Promise<void>((ack) => {
        queue.push({ tuple: [space, message], ack });
        notify?.();
        notify = undefined;
      });
    },
    end() {
      ended = true;
      notify?.();
      notify = undefined;
    },
  };
}

// Mirror the real SpectrumInstance: a Proxy whose get-trap resolves unknown
// string properties to custom event streams, never to platform instances.
// Reading `spectrum.imessage` must NOT yield anything with `.space`.
function fakeSpectrumInstance() {
  const stream = fakeMessageStream();
  const base = {
    __providers: [],
    __internal: { platforms: new Map() },
    messages: stream.iterable,
    // The real stop() closes platform clients, which ends the message stream.
    stop: vi.fn(async () => {
      stream.end();
    }),
    responding: vi.fn(async (_space: unknown, fn: () => unknown) => fn()),
    emit: stream.emit,
    end: stream.end,
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
  attachment: vi.fn((input: unknown, options: unknown) => ({
    __builder: "attachment",
    input,
    options,
  })),
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
  sendAttachment: (data: Buffer, options: { name: string; mimeType: string }) => Promise<void>;
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
    await instance.emit(space, {
      id: "msg-1",
      platform: "imessage",
      sender: { id: "+100" },
      content: { type: "text", text: "thanks" },
      react: vi.fn(async () => {}),
    });
    await transport.flushInbound();

    expect(onBatch).toHaveBeenCalledTimes(1);
    // Shown while the text buffered, cleared the moment the handler said so.
    expect(space.startTyping).toHaveBeenCalled();
    expect(space.stopTyping).toHaveBeenCalledTimes(1);
  });

  it("sends allowed attachments through the spectrum builder on the batch's space", async () => {
    const space = fakeSpace();
    const onBatch = vi.fn(
      async (_batch: unknown, _send: unknown, _signal: unknown, controls: TestControls) => {
        await controls.sendAttachment(Buffer.from("png-bytes"), {
          name: "chart.png",
          mimeType: "image/png",
        });
      },
    );
    const transport = await createPhotonTransport({
      ...transportConfig(),
      debounceMs: 0,
      onBatch,
    });
    const instance = spectrumInstances.at(-1)!;
    await instance.emit(space, {
      id: "msg-a1",
      platform: "imessage",
      sender: { id: "+100" },
      content: { type: "text", text: "chart?" },
      react: vi.fn(async () => {}),
    });
    await transport.flushInbound();

    expect(space.send).toHaveBeenCalledWith(
      expect.objectContaining({
        __builder: "attachment",
        options: { mimeType: "image/png", name: "chart.png" },
      }),
    );
  });

  it("refuses to send audio — the voice-message ban — and off-allowlist types", async () => {
    const space = fakeSpace();
    const outcomes: string[] = [];
    const onBatch = vi.fn(
      async (_batch: unknown, _send: unknown, _signal: unknown, controls: TestControls) => {
        for (const [name, mimeType] of [
          ["memo.m4a", "audio/mp4"],
          ["memo.caf", "AUDIO/x-caf"],
          ["clip.mov", "video/quicktime"],
          ["app.zip", "application/zip"],
        ] as const) {
          await controls
            .sendAttachment(Buffer.from("bytes"), { name, mimeType })
            .then(() => outcomes.push(`sent ${name}`))
            .catch((error: Error) => outcomes.push(error.message));
        }
      },
    );
    const transport = await createPhotonTransport({
      ...transportConfig(),
      debounceMs: 0,
      onBatch,
    });
    const instance = spectrumInstances.at(-1)!;
    await instance.emit(space, {
      id: "msg-a2",
      platform: "imessage",
      sender: { id: "+100" },
      content: { type: "text", text: "try" },
      react: vi.fn(async () => {}),
    });
    await transport.flushInbound();

    expect(outcomes).toEqual([
      "Refusing to send audio: Nudge never sends voice messages",
      "Refusing to send audio: Nudge never sends voice messages",
      'Refusing to send unsupported attachment type "video/quicktime"',
      'Refusing to send unsupported attachment type "application/zip"',
    ]);
    // Nothing reached the wire.
    expect(space.send).not.toHaveBeenCalled();
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
    // Two texts buffer into one batch; the tapback must land on the second.
    for (const [id, react] of [
      ["msg-1", firstReact],
      ["msg-2", secondReact],
    ] as const) {
      await instance.emit(space, {
        id,
        platform: "imessage",
        sender: { id: "+100" },
        content: { type: "text", text: `text ${id}` },
        react,
      });
    }
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

describe("inbound media", () => {
  interface TestBatch {
    texts: string[];
    media: Array<{
      kind: string;
      name: string;
      mimeType: string;
      sizeBytes?: number;
      durationSeconds?: number;
      read: () => Promise<Buffer>;
    }>;
  }

  async function deliverContents(contents: unknown[]): Promise<{
    batches: TestBatch[];
    warnings: number;
  }> {
    logger.warn.mockClear();
    const space = fakeSpace();
    const batches: TestBatch[] = [];
    const transport = await createPhotonTransport({
      ...transportConfig(),
      debounceMs: 0,
      onBatch: vi.fn(async (batch: TestBatch) => {
        batches.push(batch);
      }),
    });
    const instance = spectrumInstances.at(-1)!;
    for (const [index, content] of contents.entries()) {
      await instance.emit(space, ownerMessage(`msg-m${index + 1}`, { content }));
    }
    await transport.flushInbound();
    return { batches, warnings: logger.warn.mock.calls.length };
  }

  it("passes a bare image through as lazy media without fetching bytes", async () => {
    const read = vi.fn(async () => Buffer.from("jpeg-bytes"));
    const { batches } = await deliverContents([
      { type: "attachment", id: "att-1", name: "photo.jpg", mimeType: "image/jpeg", size: 1234, read },
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.texts).toEqual([""]);
    expect(batches[0]?.media).toEqual([
      expect.objectContaining({
        kind: "image",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
      }),
    ]);
    // Bytes are fetched by the ingest layer, never by the transport.
    expect(read).not.toHaveBeenCalled();
  });

  it("classifies voice memos, defaulting a name and carrying duration", async () => {
    const { batches } = await deliverContents([
      {
        type: "voice",
        mimeType: "audio/x-caf",
        duration: 12.4,
        size: 999,
        read: async () => Buffer.from("caf"),
      },
    ]);

    expect(batches[0]?.media).toEqual([
      expect.objectContaining({
        kind: "voice",
        name: "voice-memo.caf",
        mimeType: "audio/x-caf",
        durationSeconds: 12.4,
      }),
    ]);
  });

  it("classifies a non-voice audio file as a plain file, not a voice memo", async () => {
    const { batches } = await deliverContents([
      { type: "attachment", name: "song.mp3", mimeType: "audio/mpeg", read: async () => Buffer.from("mp3") },
    ]);

    expect(batches[0]?.media[0]?.kind).toBe("file");
  });

  it("flattens a text-plus-attachment group in item order", async () => {
    const { batches } = await deliverContents([
      {
        type: "group",
        items: [
          { content: { type: "text", text: "look at this" } },
          {
            content: {
              type: "attachment",
              name: "receipt.png",
              mimeType: "image/png",
              read: async () => Buffer.from("png"),
            },
          },
          // Unsupported sub-items are skipped without sinking the message.
          { content: { type: "contact", name: "Someone" } },
          { content: { type: "text", text: "worth it?" } },
        ],
      },
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.texts).toEqual(["look at this\nworth it?"]);
    expect(batches[0]?.media).toEqual([
      expect.objectContaining({ kind: "image", name: "receipt.png" }),
    ]);
  });

  it("batches a text and a follow-up photo into one delivery with both", async () => {
    const { batches } = await deliverContents([
      { type: "text", text: "incoming" },
      { type: "attachment", name: "dog.webp", mimeType: "image/webp", read: async () => Buffer.from("webp") },
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.texts).toEqual(["incoming", ""]);
    expect(batches[0]?.media).toHaveLength(1);
  });

  it("still drops unsupported content with a warning", async () => {
    const { batches, warnings } = await deliverContents([
      { type: "reaction", reaction: "love" },
    ]);

    expect(batches).toHaveLength(0);
    expect(warnings).toBe(1);
  });
});

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
      await instance.emit(space, ownerMessage("msg-t1"));
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
      await instance.emit(space, ownerMessage("msg-t2"));
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
      await instance.emit(space, ownerMessage("msg-r1", { read }));
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
      await instance.emit(space, ownerMessage("msg-r2", { read }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
