/**
 * Shared output truncation for tools (pi-style): two independent caps — lines
 * and UTF-8 bytes — whichever is hit first wins. Files truncate from the head
 * (structure lives at the top), shell output from the tail (errors and results
 * live at the end). Callers own the human-facing footer; this module only
 * reports what was kept so footers can name the exact next action.
 */
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncationResult {
  /** The kept slice, without any footer. */
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  /** 1-indexed inclusive bounds of `text` within the input; 0/0 when empty. */
  firstLine: number;
  lastLine: number;
  truncatedBy: "lines" | "bytes" | null;
}

/**
 * Split into lines the way line counts are reported everywhere: a trailing
 * newline does not create an extra empty line ("a\nb\n" is 2 lines).
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function truncateHead(content: string, options?: TruncationOptions): TruncationResult {
  return truncate(content, options, "head");
}

export function truncateTail(content: string, options?: TruncationOptions): TruncationResult {
  return truncate(content, options, "tail");
}

function truncate(
  content: string,
  options: TruncationOptions | undefined,
  end: "head" | "tail",
): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = splitLines(content);
  const totalBytes = Buffer.byteLength(content, "utf8");

  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (let count = 0; count < lines.length; count += 1) {
    const index = end === "head" ? count : lines.length - 1 - count;
    const line = lines[index]!;
    if (count >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const lineBytes = Buffer.byteLength(line, "utf8") + (count > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      // A first line larger than the whole byte budget is kept sliced at a
      // code-point boundary rather than dropped entirely.
      if (count === 0) {
        kept.push(sliceToBytes(line, maxBytes, end));
        keptBytes = maxBytes;
      }
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    keptBytes += lineBytes;
  }

  if (truncatedBy === null) {
    return {
      text: content,
      truncated: false,
      totalLines: lines.length,
      totalBytes,
      firstLine: lines.length > 0 ? 1 : 0,
      lastLine: lines.length,
      truncatedBy: null,
    };
  }

  if (end === "tail") kept.reverse();
  return {
    text: kept.join("\n"),
    truncated: true,
    totalLines: lines.length,
    totalBytes,
    firstLine: end === "head" ? 1 : lines.length - kept.length + 1,
    lastLine: end === "head" ? kept.length : lines.length,
    truncatedBy,
  };
}

/** Slice a string to at most maxBytes of UTF-8, never splitting a code point. */
function sliceToBytes(line: string, maxBytes: number, end: "head" | "tail"): string {
  const chars = Array.from(line);
  if (end === "tail") chars.reverse();
  const out: string[] = [];
  let bytes = 0;
  for (const char of chars) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out.push(char);
    bytes += charBytes;
  }
  if (end === "tail") out.reverse();
  return out.join("");
}
