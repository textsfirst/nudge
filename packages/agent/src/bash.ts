import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, splitLines, truncateTail } from "./truncate.js";

/**
 * Unlike pi, commands time out by default: this agent runs unattended and
 * per-handle serialized, so a hung command would block every future message.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
/** setTimeout's int32 millisecond ceiling. */
export const MAX_BASH_TIMEOUT_SECONDS = 2_147_483;

/** In-memory rolling tail; the model-visible slice is far smaller. */
const MEMORY_TAIL_BYTES = 512 * 1024;
/** Once output can no longer be shown whole, spill everything to a temp file. */
const SPILL_THRESHOLD_BYTES = DEFAULT_MAX_BYTES;
/**
 * After the child exits, wait this long for its stdio to close before
 * force-destroying the streams: a detached grandchild inheriting the pipes
 * would otherwise keep the promise pending for its whole lifetime.
 */
const EXIT_STDIO_GRACE_MS = 250;

export interface BashOptions {
  /** Default working directory only — NOT a security boundary. */
  cwd: string;
  /** Merged over process.env (PATH prepends, gws shim pointers, …). */
  env?: Record<string, string> | undefined;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/**
 * Run a command via bash -c. Always resolves to a model-facing string (never
 * throws): captured output, a truncation footer naming the spill file when the
 * tail was cut, and a status line for anything but a clean silent exit.
 */
export async function executeBash(command: string, options: BashOptions): Promise<string> {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS;
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > MAX_BASH_TIMEOUT_SECONDS
  ) {
    return `Error: invalid timeout — must be a positive number of seconds up to ${MAX_BASH_TIMEOUT_SECONDS}.`;
  }

  const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const child = spawn(shell, ["-c", command], {
    cwd: options.cwd,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    detached: true, // own process group, so timeout/abort can kill the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = new OutputAccumulator();
  // Object wrapper: the closures below mutate it, which defeats TS narrowing.
  const state: { status: "exit" | "timeout" | "abort" } = { status: "exit" };
  let spawnError: string | null = null;

  const killTree = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  const onAbort = (): void => {
    state.status = "abort";
    killTree();
  };

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const timer = setTimeout(() => {
        state.status = "timeout";
        killTree();
      }, timeoutSeconds * 1000);

      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => output.push(chunk));

      let closedStreams = 0;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let settled = false;
      const settle = (): void => {
        if (settled || !exited) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        child.stdout!.destroy();
        child.stderr!.destroy();
        resolve(exited);
      };
      const onStreamClose = (): void => {
        closedStreams += 1;
        if (closedStreams >= 2) settle();
      };
      child.stdout!.on("close", onStreamClose);
      child.stderr!.on("close", onStreamClose);

      child.on("error", (error) => {
        spawnError = error.message;
        exited = { code: null, signal: null };
        settle();
      });
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        if (closedStreams >= 2) {
          settle();
        } else {
          setTimeout(settle, EXIT_STDIO_GRACE_MS);
        }
      });
    },
  );

  const spillPath = await output.finish();
  if (spawnError) return `Error: ${spawnError}`;

  const parts: string[] = [];
  const visible = output.render();
  if (visible.text) parts.push(visible.text);
  if (visible.footer) parts.push(visible.footer);

  if (state.status === "timeout") {
    parts.push(`Command timed out after ${timeoutSeconds} seconds`);
  } else if (state.status === "abort") {
    parts.push("Command aborted");
  } else if (exit.code !== null && exit.code !== 0) {
    parts.push(`Command exited with code ${exit.code}`);
  } else if (exit.signal !== null) {
    parts.push(`Command terminated by signal ${exit.signal}`);
  } else if (parts.length === 0) {
    parts.push("(no output)");
  }
  // The footer already promised the spill path; nothing else references it.
  void spillPath;
  return parts.join("\n");
}

/**
 * Collects interleaved stdout+stderr. Memory holds a rolling tail; once total
 * output exceeds the visible budget, every raw chunk is also streamed to a
 * temp file so the full output stays recoverable.
 */
class OutputAccumulator {
  #chunks: Buffer[] = [];
  #memoryBytes = 0;
  #totalBytes = 0;
  #newlines = 0;
  #lastByte: number | null = null;
  #trimmed = false;
  #spill: WriteStream | null = null;
  #spillPath: string | null = null;
  #spillFailed = false;

  push(chunk: Buffer): void {
    this.#totalBytes += chunk.length;
    for (const byte of chunk) if (byte === 0x0a) this.#newlines += 1;
    if (chunk.length > 0) this.#lastByte = chunk[chunk.length - 1]!;

    const overBudget =
      this.#totalBytes > SPILL_THRESHOLD_BYTES || this.#newlines > DEFAULT_MAX_LINES;
    if (!this.#spill && !this.#spillFailed && overBudget) {
      try {
        this.#spillPath = join(tmpdir(), `nudge-bash-${randomBytes(4).toString("hex")}.log`);
        this.#spill = createWriteStream(this.#spillPath);
        this.#spill.on("error", () => {
          this.#spillFailed = true;
          this.#spill = null;
          this.#spillPath = null;
        });
        // Everything so far is still in memory (trimming starts later).
        for (const buffered of this.#chunks) this.#spill.write(buffered);
      } catch {
        this.#spillFailed = true;
        this.#spill = null;
        this.#spillPath = null;
      }
    }
    this.#spill?.write(chunk);

    this.#chunks.push(chunk);
    this.#memoryBytes += chunk.length;
    while (this.#memoryBytes > MEMORY_TAIL_BYTES && this.#chunks.length > 1) {
      this.#memoryBytes -= this.#chunks.shift()!.length;
      this.#trimmed = true;
    }
  }

  /** Close the spill file; resolves to its path if one was written. */
  finish(): Promise<string | null> {
    const spill = this.#spill;
    if (!spill) return Promise.resolve(null);
    return new Promise((resolve) => {
      spill.end(() => resolve(this.#spillPath));
    });
  }

  render(): { text: string; footer: string | null } {
    const sanitized = sanitize(Buffer.concat(this.#chunks).toString("utf8"));
    const tail = truncateTail(sanitized);
    if (!tail.truncated && !this.#trimmed) {
      return { text: tail.text, footer: null };
    }
    // When the rolling window dropped chunks, line totals come from the raw
    // byte counts (newlines survive sanitization untouched).
    const totalLines = this.#trimmed
      ? this.#newlines + (this.#lastByte === 0x0a ? 0 : 1)
      : tail.totalLines;
    const shown = splitLines(tail.text).length;
    const where = this.#spillPath ? ` Full output: ${this.#spillPath}` : "";
    return {
      text: tail.text,
      footer: `[Output truncated: showing last ${shown} of ${totalLines} lines.${where}]`,
    };
  }
}

/** Strip ANSI escape sequences and control chars other than \t \n \r. */
function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSI (colors, cursor movement)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
