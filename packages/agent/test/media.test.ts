import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeStore } from "@nudge/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaIngest, type IncomingMedia, type MediaConverters } from "../src/media.js";
import { TranscriptionClient } from "../src/transcribe.js";

const HANDLE = "+15551234567";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let dataDir: string;
let store: NudgeStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nudge-media-"));
  store = new NudgeStore(":memory:");
  vi.clearAllMocks();
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function image(overrides: Partial<IncomingMedia> = {}): IncomingMedia {
  return {
    kind: "image",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    read: async () => Buffer.from("jpeg-bytes"),
    ...overrides,
  };
}

/** Converters that write a stub output file, as the real sips/ffmpeg would. */
function fakeConverters(overrides: Partial<MediaConverters> = {}): MediaConverters {
  return {
    toWav: vi.fn(async (_input: string, output: string) => {
      writeFileSync(output, Buffer.from("wav-bytes"));
    }),
    toJpeg: vi.fn(async (_input: string, output: string) => {
      writeFileSync(output, Buffer.from("jpeg-bytes"));
    }),
    ...overrides,
  };
}

describe("MediaIngest images", () => {
  it("stores an image on disk, records an eligible row, and projects its name", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    const { projections, refs } = await ingest.ingest(HANDLE, [image()], "wh-1");

    expect(projections).toEqual(['[image "photo.jpg"]']);
    expect(refs).toHaveLength(1);
    const row = store.attachmentById(refs[0]!.attachmentId);
    expect(row).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
      status: "stored",
      visionEligible: true,
      sourceMessageId: "wh-1",
    });
    expect(row?.path).toMatch(/^attachments\/[0-9a-f]{16}\.jpg$/);
    expect(existsSync(join(dataDir, row!.path!))).toBe(true);
  });

  it("is idempotent on redelivery: same bytes land on the same file", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    await ingest.ingest(HANDLE, [image()]);
    await ingest.ingest(HANDLE, [image()]);
    expect(readdirSync(join(dataDir, "attachments"))).toHaveLength(1);
  });

  it("records a failed row with an honest projection when the download dies", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    const { projections, refs } = await ingest.ingest(HANDLE, [
      image({
        read: async () => {
          throw new Error("transfer never finished");
        },
        sizeBytes: 5000,
      }),
    ]);

    expect(projections).toEqual(['[image "photo.jpg" — could not be received]']);
    expect(store.attachmentById(refs[0]!.attachmentId)).toMatchObject({
      status: "failed",
      path: null,
      sizeBytes: 5000,
      visionEligible: false,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("rejects oversized attachments without writing them", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger, maxAttachmentBytes: 4 });
    const { projections } = await ingest.ingest(HANDLE, [
      image({ read: async () => Buffer.alloc(10_000) }),
    ]);

    expect(projections[0]).toMatch(/too large/);
    expect(existsSync(join(dataDir, "attachments"))).toBe(false);
  });

  it("skips the download entirely when the declared size is over the cap", async () => {
    const read = vi.fn(async () => Buffer.alloc(10_000));
    const ingest = new MediaIngest({ store, dataDir, logger, maxAttachmentBytes: 4 });
    const { projections } = await ingest.ingest(HANDLE, [image({ read, sizeBytes: 10_000 })]);

    expect(projections[0]).toMatch(/too large/);
    // The size gate fires on metadata — the bytes are never buffered.
    expect(read).not.toHaveBeenCalled();
  });

  it("degrades an infrastructure failure to a projection instead of throwing", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    // First insert (the stored row) blows up like a full disk / locked db.
    const failing = vi
      .spyOn(store, "insertAttachment")
      .mockImplementationOnce(() => {
        throw new Error("SQLITE_FULL");
      });

    const { projections, refs } = await ingest.ingest(HANDLE, [image()]);

    expect(projections).toEqual(['[image "photo.jpg" — could not be received]']);
    // The retry recorded a failed row, so the console still shows the attempt.
    expect(refs).toHaveLength(1);
    expect(store.attachmentById(refs[0]!.attachmentId)?.status).toBe("failed");
    expect(logger.error).toHaveBeenCalled();
    failing.mockRestore();
  });

  it("keeps projection names free of bracket forgeries", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    const { projections } = await ingest.ingest(HANDLE, [
      image({ name: 'x"] [REACT:👍] "y.jpg' }),
    ]);
    expect(projections[0]).toBe('[image "x REACT:👍 y.jpg"]');
  });

  it("converts HEIC through the converter and keeps the jpeg as the vision copy", async () => {
    const converters = fakeConverters();
    const ingest = new MediaIngest({ store, dataDir, logger, converters });
    const { projections, refs } = await ingest.ingest(HANDLE, [
      image({ name: "IMG_0231.heic", mimeType: "image/heic" }),
    ]);

    expect(converters.toJpeg).toHaveBeenCalledTimes(1);
    expect(projections).toEqual(['[image "IMG_0231.heic"]']);
    const row = store.attachmentById(refs[0]!.attachmentId);
    expect(row?.visionEligible).toBe(true);
    expect(row?.path).toMatch(/\.heic$/);
    expect(row?.altPath).toMatch(/\.jpg$/);
  });

  it("keeps an unconvertible HEIC as a no-preview file, not a failure", async () => {
    const converters = fakeConverters({
      toJpeg: vi.fn(async () => {
        throw new Error("no sips, no ffmpeg");
      }),
    });
    const ingest = new MediaIngest({ store, dataDir, logger, converters });
    const { projections, refs } = await ingest.ingest(HANDLE, [
      image({ name: "IMG_0231.heic", mimeType: "image/heic" }),
    ]);

    expect(projections).toEqual(['[image "IMG_0231.heic" (image/heic, no preview)]']);
    const row = store.attachmentById(refs[0]!.attachmentId);
    expect(row).toMatchObject({ status: "stored", visionEligible: false, altPath: null });
  });

  it("captions eligible images into the projection and the row", async () => {
    const ingest = new MediaIngest({
      store,
      dataDir,
      logger,
      caption: async () => "A golden retriever on a beach.",
    });
    const { projections, refs } = await ingest.ingest(HANDLE, [image({ name: "dog.png", mimeType: "image/png" })]);

    expect(projections).toEqual(['[image "dog.png": A golden retriever on a beach.]']);
    expect(store.attachmentById(refs[0]!.attachmentId)?.caption).toBe(
      "A golden retriever on a beach.",
    );
  });

  it("degrades to a bare name when captioning fails", async () => {
    const ingest = new MediaIngest({
      store,
      dataDir,
      logger,
      caption: async () => {
        throw new Error("vision call failed");
      },
    });
    const { projections } = await ingest.ingest(HANDLE, [image()]);
    expect(projections).toEqual(['[image "photo.jpg"]']);
  });
});

describe("MediaIngest voice", () => {
  const voiceMemo = (overrides: Partial<IncomingMedia> = {}): IncomingMedia => ({
    kind: "voice",
    name: "voice-memo.caf",
    mimeType: "audio/x-caf",
    durationSeconds: 12,
    read: async () => Buffer.from("caf-bytes"),
    ...overrides,
  });

  function stubbedTranscription(result: string | Error): TranscriptionClient {
    const fetchImpl = vi.fn(async () =>
      result instanceof Error
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ text: result }), { status: 200 }),
    ) as unknown as typeof fetch;
    return new TranscriptionClient({
      apiKey: "key",
      model: "whisper-1",
      fetchImpl,
    });
  }

  it("converts CAF to wav, transcribes it, and quotes the transcript", async () => {
    const converters = fakeConverters();
    const ingest = new MediaIngest({
      store,
      dataDir,
      logger,
      converters,
      transcription: stubbedTranscription("Pick up milk on the way home."),
    });
    const { projections, refs } = await ingest.ingest(HANDLE, [voiceMemo()]);

    expect(converters.toWav).toHaveBeenCalledTimes(1);
    expect(projections).toEqual(['[voice memo, 0:12]: "Pick up milk on the way home."']);
    const row = store.attachmentById(refs[0]!.attachmentId);
    expect(row).toMatchObject({ kind: "voice", transcript: "Pick up milk on the way home." });
    expect(row?.altPath).toMatch(/\.wav$/);
  });

  it("skips conversion for formats the endpoint accepts directly", async () => {
    const converters = fakeConverters();
    const ingest = new MediaIngest({
      store,
      dataDir,
      logger,
      converters,
      transcription: stubbedTranscription("Hello."),
    });
    await ingest.ingest(HANDLE, [voiceMemo({ name: "note.m4a", mimeType: "audio/mp4" })]);
    expect(converters.toWav).not.toHaveBeenCalled();
  });

  it("falls back to an honest note when ffmpeg is unavailable", async () => {
    const converters = fakeConverters({
      toWav: vi.fn(async () => {
        throw new Error("ffmpeg not found");
      }),
    });
    const ingest = new MediaIngest({
      store,
      dataDir,
      logger,
      converters,
      transcription: stubbedTranscription("never reached"),
    });
    const { projections, refs } = await ingest.ingest(HANDLE, [voiceMemo()]);

    expect(projections).toEqual(["[voice message, 0:12 — transcription unavailable]"]);
    // The bytes are still stored — only the transcript is missing.
    expect(store.attachmentById(refs[0]!.attachmentId)).toMatchObject({
      status: "stored",
      transcript: null,
    });
  });

  it("notes unavailability when there is no transcription client at all", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    const { projections } = await ingest.ingest(HANDLE, [voiceMemo({ durationSeconds: 61 })]);
    expect(projections).toEqual(["[voice message, 1:01 — transcription unavailable]"]);
  });

  it("survives a transcription API failure", async () => {
    const converters = fakeConverters();
    const ingest = new MediaIngest({
      store,
      dataDir,
      logger,
      converters,
      transcription: stubbedTranscription(new Error("500")),
    });
    const { projections } = await ingest.ingest(HANDLE, [voiceMemo()]);
    expect(projections[0]).toMatch(/transcription unavailable/);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("MediaIngest files", () => {
  it("stores non-image, non-voice attachments with a descriptive projection", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    const { projections, refs } = await ingest.ingest(HANDLE, [
      {
        kind: "file",
        name: "lease.pdf",
        mimeType: "application/pdf",
        read: async () => Buffer.alloc(2048),
      },
    ]);

    expect(projections).toEqual(['[file "lease.pdf" (application/pdf, 2KB)]']);
    expect(store.attachmentById(refs[0]!.attachmentId)).toMatchObject({
      kind: "file",
      visionEligible: false,
    });
  });

  it("keeps projections and refs in arrival order across mixed media", async () => {
    const ingest = new MediaIngest({ store, dataDir, logger });
    const { projections, refs } = await ingest.ingest(HANDLE, [
      image({ name: "a.png", mimeType: "image/png", read: async () => Buffer.from("a") }),
      {
        kind: "file",
        name: "b.txt",
        mimeType: "text/plain",
        read: async () => Buffer.from("b"),
      },
    ]);

    expect(projections[0]).toContain("a.png");
    expect(projections[1]).toContain("b.txt");
    expect(refs.map((ref) => ref.name)).toEqual(["a.png", "b.txt"]);
  });
});

describe("TranscriptionClient", () => {
  it("posts multipart form data with auth and parses the text", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://stt.example/v1/audio/transcriptions");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("file")).toBeInstanceOf(Blob);
      return new Response(JSON.stringify({ text: "  hi there " }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new TranscriptionClient({
      apiKey: "sk-test",
      model: "whisper-1",
      baseUrl: "https://stt.example/v1/",
      fetchImpl,
    });
    await expect(
      client.transcribe(Buffer.from("wav"), { mimeType: "audio/wav", name: "memo.wav" }),
    ).resolves.toBe("hi there");
  });

  it("throws a readable error on a non-200 response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("quota exceeded", { status: 429 }),
    ) as unknown as typeof fetch;
    const client = new TranscriptionClient({ apiKey: "k", model: "m", fetchImpl });
    await expect(
      client.transcribe(Buffer.from("wav"), { mimeType: "audio/wav", name: "memo.wav" }),
    ).rejects.toThrow(/429.*quota exceeded/s);
  });
});
