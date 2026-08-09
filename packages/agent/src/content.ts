import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * packages/agent/content — the shipped product opinions (default SYSTEM.md,
 * the data-directory README, bundled skills) as real markdown files. Resolved
 * relative to this module so the same path works from src/ (vitest) and dist/.
 */
export const BUNDLED_CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "content");

export const BUNDLED_SKILLS_DIR = join(BUNDLED_CONTENT_DIR, "skills");

export function readBundledFile(name: string): string {
  return readFileSync(join(BUNDLED_CONTENT_DIR, name), "utf8");
}
