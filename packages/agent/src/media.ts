import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { NudgeStore } from "@nudge/store";
import type { TranscriptionClient } from "./transcribe.js";
import type { Logger } from "./types.js";

/**
 * Media arriving with an inbound message. Structurally identical to the photon
 * package's InboundMedia — declared here so the agent package stays free of a
 * transport dependency.
 */
export interface IncomingMedia {
  kind: "image" | "voice" | "file";
  name: string;
  mimeType: string;
  sizeBytes?: number;
  durationSeconds?: number;
  read: () => Promise<Buffer>;
}

/** What the agent needs to link a persisted attachment to its user row. */
export interface MediaRef {
  attachmentId: number;
  kind: "image" | "voice" | "file";
  name: string;
  mimeType: string;
  /** Relative to the data directory; null when the bytes never arrived. */
  path: string | null;
  visionEligible: boolean;
}

export interface IngestResult {
  /**
   * One text stand-in per media item, in arrival order — `[image "x.jpg"]`,
   * `[voice memo, 0:12]: "…"`. These become part of the user row's content, so
   * search, compaction summaries, and vision-less models all see the media.
   */
  projections: string[];
  refs: MediaRef[];
}

/** File-format converters; the default shells out to sips/ffmpeg. Test seam. */
export interface MediaConverters {
  /** Any audio container → 16kHz mono wav (what transcription endpoints accept). */
  toWav(inputPath: string, outputPath: string): Promise<void>;
  /** HEIC/HEIF → JPEG (what vision endpoints accept). */
  toJpeg(inputPath: string, outputPath: string): Promise<void>;
}

export interface MediaIngestOptions {
  store: NudgeStore;
  dataDir: string;
  logger: Logger;
  maxAttachmentBytes?: number;
  /** Cap on one attachment download; a pending/failed transfer hangs, not errors. */
  readTimeoutMs?: number;
  transcription?: TranscriptionClient;
  /** Describes an image for the thread record; absent → bare name projections. */
  caption?: (image: Buffer, mimeType: string) => Promise<string>;
  converters?: MediaConverters;
  ffmpegPath?: string;
  now?: () => number;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const ATTACHMENTS_DIR = "attachments";

/** Image types vision endpoints take as-is. */
const VISION_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);
/** Audio containers transcription endpoints take without conversion. */
const TRANSCRIBABLE_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/ogg",
]);

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "audio/x-caf": "caf",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

/**
 * Fetches inbound media bytes, persists them under `dataDir/attachments/`
 * (sha-named, so redeliveries are idempotent), records an attachments
 * row per item, and produces the text projections the thread keeps.
 *
 * Deliberately ignores the steering AbortSignal: a newer text must not make
 * the owner's photo vanish. The rows and projections are durable; a steered
 * turn simply replays them from history.
 */
export class MediaIngest {
  readonly #options: MediaIngestOptions;
  readonly #converters: MediaConverters;

  constructor(options: MediaIngestOptions) {
    this.#options = options;
    this.#converters =
      options.converters ?? ffmpegConverters(options.ffmpegPath, options.logger);
  }

  async ingest(
    handle: string,
    media: IncomingMedia[],
    sourceMessageId?: string,
  ): Promise<IngestResult> {
    const projections: string[] = [];
    const refs: MediaRef[] = [];
    for (const item of media) {
      // Never throw out of ingest: the caller persists the owner's text only
      // after this returns, so an infrastructure failure here (disk full, a
      // database error) must degrade to an honest projection, not sink the
      // whole turn and silently drop the message.
      try {
        const { projection, ref } = await this.#ingestOne(handle, item, sourceMessageId);
        projections.push(projection);
        refs.push(ref);
      } catch (error) {
        this.#options.logger.error("Ingesting an inbound attachment failed", {
          name: item.name,
          mimeType: item.mimeType,
          error: error instanceof Error ? error.message : String(error),
        });
        const projection = `[${mediaLabel(item)} — could not be received]`;
        projections.push(projection);
        try {
          refs.push(this.#failed(handle, item, sourceMessageId, projection).ref);
        } catch {
          // Even the failure row could not be written — keep the projection.
        }
      }
    }
    return { projections, refs };
  }

  async #ingestOne(
    handle: string,
    item: IncomingMedia,
    sourceMessageId?: string,
  ): Promise<{ projection: string; ref: MediaRef }> {
    const { logger } = this.#options;
    const label = mediaLabel(item);
    const maxBytes = this.#options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

    // The declared size is checked before download so an oversized send never
    // buffers into memory at all; the post-download check backstops senders
    // that under-declare.
    if (item.sizeBytes !== undefined && item.sizeBytes > maxBytes) {
      return this.#failed(
        handle,
        item,
        sourceMessageId,
        `[${label} — too large (${formatBytes(item.sizeBytes)}, limit ${formatBytes(maxBytes)})]`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await withTimeout(
        item.read(),
        this.#options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
        `downloading ${item.name}`,
      );
    } catch (error) {
      logger.warn("Failed to download an inbound attachment", {
        name: item.name,
        mimeType: item.mimeType,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.#failed(handle, item, sourceMessageId, `[${label} — could not be received]`);
    }

    if (bytes.length > maxBytes) {
      return this.#failed(
        handle,
        item,
        sourceMessageId,
        `[${label} — too large (${formatBytes(bytes.length)}, limit ${formatBytes(maxBytes)})]`,
      );
    }

    const relativePath = this.#persist(bytes, item);
    const stored = { relativePath, bytes };
    if (item.kind === "voice") {
      return this.#storeVoice(handle, item, sourceMessageId, stored);
    }
    if (item.kind === "image") {
      return this.#storeImage(handle, item, sourceMessageId, stored);
    }
    const ref = this.#insert(handle, item, sourceMessageId, {
      path: relativePath,
      sizeBytes: bytes.length,
    });
    return {
      projection: `[file "${projectionName(item.name)}" (${item.mimeType}, ${formatBytes(bytes.length)})]`,
      ref,
    };
  }

  async #storeImage(
    handle: string,
    item: IncomingMedia,
    sourceMessageId: string | undefined,
    stored: { relativePath: string; bytes: Buffer },
  ): Promise<{ projection: string; ref: MediaRef }> {
    const mime = item.mimeType.toLowerCase();
    let visionPath = stored.relativePath;
    let visionEligible = VISION_MIME_TYPES.has(mime);
    let altPath: string | undefined;

    if (!visionEligible && HEIC_MIME_TYPES.has(mime)) {
      const jpegRelative = replaceExtension(stored.relativePath, "jpg");
      try {
        await this.#converters.toJpeg(this.#absolute(stored.relativePath), this.#absolute(jpegRelative));
        altPath = jpegRelative;
        visionPath = jpegRelative;
        visionEligible = true;
      } catch (error) {
        this.#options.logger.warn("Could not convert an HEIC image; storing it without a preview", {
          name: item.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let caption: string | undefined;
    if (visionEligible && this.#options.caption) {
      try {
        caption = await this.#options.caption(
          readFileSync(this.#absolute(visionPath)),
          altPath ? "image/jpeg" : item.mimeType,
        );
      } catch (error) {
        this.#options.logger.warn("Captioning an inbound image failed", {
          name: item.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const ref = this.#insert(handle, item, sourceMessageId, {
      path: stored.relativePath,
      sizeBytes: stored.bytes.length,
      ...(altPath ? { altPath } : {}),
      ...(caption ? { caption } : {}),
      visionEligible,
    });
    const name = projectionName(item.name);
    const projection = caption
      ? `[image "${name}": ${caption}]`
      : visionEligible
        ? `[image "${name}"]`
        : `[image "${name}" (${item.mimeType}, no preview)]`;
    return { projection, ref };
  }

  async #storeVoice(
    handle: string,
    item: IncomingMedia,
    sourceMessageId: string | undefined,
    stored: { relativePath: string; bytes: Buffer },
  ): Promise<{ projection: string; ref: MediaRef }> {
    const duration = formatDuration(item.durationSeconds);
    let transcript: string | undefined;
    let altPath: string | undefined;

    if (this.#options.transcription) {
      try {
        let audio = stored.bytes;
        let mimeType = item.mimeType.toLowerCase();
        let name = item.name;
        if (!TRANSCRIBABLE_MIME_TYPES.has(mimeType)) {
          const wavRelative = replaceExtension(stored.relativePath, "wav");
          await this.#converters.toWav(this.#absolute(stored.relativePath), this.#absolute(wavRelative));
          altPath = wavRelative;
          audio = readFileSync(this.#absolute(wavRelative));
          mimeType = "audio/wav";
          name = replaceExtension(item.name, "wav");
        }
        transcript = await this.#options.transcription.transcribe(audio, { mimeType, name });
      } catch (error) {
        this.#options.logger.warn("Transcribing an inbound voice message failed", {
          name: item.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const ref = this.#insert(handle, item, sourceMessageId, {
      path: stored.relativePath,
      sizeBytes: stored.bytes.length,
      ...(altPath ? { altPath } : {}),
      ...(transcript ? { transcript } : {}),
    });
    const projection = transcript
      ? `[voice memo${duration ? `, ${duration}` : ""}]: "${transcript}"`
      : `[voice message${duration ? `, ${duration}` : ""} — transcription unavailable]`;
    return { projection, ref };
  }

  #failed(
    handle: string,
    item: IncomingMedia,
    sourceMessageId: string | undefined,
    projection: string,
  ): { projection: string; ref: MediaRef } {
    const ref = this.#insert(handle, item, sourceMessageId, {
      status: "failed",
      sizeBytes: item.sizeBytes ?? 0,
    });
    return { projection, ref };
  }

  #insert(
    handle: string,
    item: IncomingMedia,
    sourceMessageId: string | undefined,
    extra: {
      path?: string;
      altPath?: string;
      transcript?: string;
      caption?: string;
      status?: "stored" | "failed";
      sizeBytes: number;
      visionEligible?: boolean;
    },
  ): MediaRef {
    const row = this.#options.store.insertAttachment({
      handle,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: extra.sizeBytes,
      ...(extra.path ? { path: extra.path } : {}),
      ...(extra.altPath ? { altPath: extra.altPath } : {}),
      ...(extra.transcript ? { transcript: extra.transcript } : {}),
      ...(extra.caption ? { caption: extra.caption } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      visionEligible: extra.visionEligible ?? false,
      ...(this.#options.now ? { at: this.#options.now() } : {}),
    });
    return {
      attachmentId: row.id,
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      path: row.path,
      visionEligible: row.visionEligible,
    };
  }

  /** Content-addressed write: a redelivered message lands on the same file. */
  #persist(bytes: Buffer, item: IncomingMedia): string {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const relativePath = join(ATTACHMENTS_DIR, `${hash}.${extensionFor(item)}`);
    const absolute = this.#absolute(relativePath);
    if (!existsSync(absolute)) {
      mkdirSync(join(this.#options.dataDir, ATTACHMENTS_DIR), { recursive: true });
      writeFileSync(absolute, bytes);
    }
    return relativePath;
  }

  #absolute(relativePath: string): string {
    return join(this.#options.dataDir, relativePath);
  }
}

function mediaLabel(item: IncomingMedia): string {
  if (item.kind === "voice") return "voice message";
  return item.kind === "image"
    ? `image "${projectionName(item.name)}"`
    : `file "${projectionName(item.name)}"`;
}

/**
 * Attachment names land inside the bracketed projections the model reads —
 * strip the characters that could forge projection structure or reply tokens.
 */
function projectionName(name: string): string {
  return name.replace(/[[\]"\u0000-\u001f]/g, "").slice(0, 80) || "attachment";
}

function extensionFor(item: IncomingMedia): string {
  const fromName = extname(item.name).slice(1).toLowerCase();
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXTENSION_BY_MIME[item.mimeType.toLowerCase()] ?? "bin";
}

function replaceExtension(path: string, extension: string): string {
  const current = extname(path);
  return current ? `${path.slice(0, -current.length)}.${extension}` : `${path}.${extension}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

/** Seconds → "0:12"; undefined stays undefined so the projection omits it. */
function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out ${what} after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default converters: HEIC via sips (always present on macOS) falling back to
 * ffmpeg; audio via ffmpeg. Every failure throws — callers degrade to
 * "no preview" / "transcription unavailable" projections.
 */
function ffmpegConverters(ffmpegPath: string | undefined, logger: Logger): MediaConverters {
  const ffmpeg = ffmpegPath ?? "ffmpeg";
  return {
    async toWav(inputPath, outputPath) {
      await run(ffmpeg, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", outputPath]);
    },
    async toJpeg(inputPath, outputPath) {
      try {
        await run("sips", ["-s", "format", "jpeg", inputPath, "--out", outputPath]);
      } catch (error) {
        logger.debug("sips is unavailable or failed; trying ffmpeg for HEIC conversion", {
          error: error instanceof Error ? error.message : String(error),
        });
        await run(ffmpeg, ["-y", "-i", inputPath, outputPath]);
      }
    },
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr?.toString().slice(0, 200) || error.message}`));
      } else {
        resolve();
      }
    });
  });
}
