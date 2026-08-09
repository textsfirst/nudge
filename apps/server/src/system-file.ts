import { readFileSync } from "node:fs";
import type { Logger } from "@nudge/agent";

const SIZE_WARNING_CHARS = 20_000;

/**
 * Reader for DATA_DIR/SYSTEM.md — the user-authored base system prompt.
 * Returns undefined when the file is absent (the built-in default applies).
 * The agent re-invokes this at thread rollover, never mid-thread.
 */
export function createSystemFileReader(
  path: string,
  logger: Logger,
): () => string | undefined {
  let warnedLength: number | undefined;
  return () => {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      logger.error("Failed to read SYSTEM.md; using the built-in default", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    if (content.length > SIZE_WARNING_CHARS && warnedLength !== content.length) {
      warnedLength = content.length;
      logger.warn("SYSTEM.md is very large and is sent in full on every model call", {
        path,
        chars: content.length,
      });
    }
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  };
}
