import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSchedule } from "@nudge/schedule";
import { applyEdits, type FileEdit } from "./edits.js";
import { MCP_CONFIG_PATH, parseMcpConfig } from "./mcp-config.js";
import { validateSkillMd } from "./skills.js";
import { DEFAULT_MAX_BYTES, splitLines, truncateHead } from "./truncate.js";

/** Character budgets for the curated memory files (Hermes-style bounds). */
export const MEMORY_LIMITS: Record<string, number> = {
  "MEMORY.md": 2_200,
  "USER.md": 1_375,
  "LOOPS.md": 4_000,
};

/** Per-file cap for people/<name>.md (not an exact-path MEMORY_LIMITS entry). */
export const PEOPLE_FILE_LIMIT = 1_500;

/** Character budget for a data-dir-relative path, if the path is capped. */
export function fileBudget(rel: string): number | undefined {
  const exact = MEMORY_LIMITS[rel];
  if (exact !== undefined) return exact;
  if (isPeopleFile(rel.split(sep))) return PEOPLE_FILE_LIMIT;
  return undefined;
}

function isPeopleFile(parts: string[]): boolean {
  const name = parts[1];
  return (
    parts[0] === "people" &&
    parts.length === 2 &&
    name !== undefined &&
    name.endsWith(".md") &&
    name !== ".md"
  );
}

/** list() cap; a data directory this size is already pathological. */
export const MAX_LIST_ENTRIES = 500;

/** Files the agent may never read or write (secrets and runtime state). */
const HIDDEN_BASENAMES = new Set([
  "chatgpt-auth.json",
  "grok-auth.json",
  "console-auth.json",
]);
const HIDDEN_PREFIXES = ["nudge.db"];
/** Directories that hold secrets (Google OAuth credentials + token caches). */
const HIDDEN_DIRS = new Set(["google"]);

/** Files the agent may read but never write. */
const READ_ONLY = new Set(["SYSTEM.md", "README.md"]);

/**
 * The agent's file surface: everything in DATA_DIR except secrets and runtime
 * state, with per-path validation on writes. Files are the API — this replaces
 * the bespoke schedule/skill/memory tools.
 */
export class FileWorkspace {
  constructor(private readonly dataDir: string) {}

  list(): string {
    if (!existsSync(this.dataDir)) return "(no files yet)";
    const files = this.#walk(this.dataDir)
      .filter((path) => !isHidden(path))
      .sort();
    if (files.length === 0) return "(no files yet)";
    const capped = truncateHead(files.join("\n"), { maxLines: MAX_LIST_ENTRIES });
    return capped.truncated
      ? `${capped.text}\n[Showing ${capped.lastLine} of ${files.length} files.]`
      : capped.text;
  }

  read(path: string, options?: { offset?: number | undefined; limit?: number | undefined }): string {
    const check = this.#resolve(path);
    if ("error" in check) return check.error;
    if (isHidden(check.rel)) return `Error: ${path} is not readable.`;
    if (!existsSync(check.abs)) {
      return `Error: no file "${path}". Files:\n${this.list()}`;
    }
    return page(readFileSync(check.abs, "utf8"), path, options?.offset ?? 1, options?.limit);
  }

  edit(path: string, edits: FileEdit[]): string {
    const check = this.#resolve(path);
    if ("error" in check) return check.error;
    if (isHidden(check.rel)) return `Error: ${path} is not writable.`;
    if (isReadOnly(check.rel)) {
      return `Error: ${check.rel} is owner/system-maintained and read-only to you.`;
    }
    if (!existsSync(check.abs)) {
      return `Error: no file "${path}". Files:\n${this.list()}`;
    }
    const outcome = applyEdits(readFileSync(check.abs, "utf8"), edits);
    if (!outcome.ok) return outcome.error;
    const problem = validateDataFile(check.rel, outcome.result);
    if (problem) return `Error: not saved. ${problem}`;

    writeFileSync(check.abs, outcome.result);
    const count = edits.length === 1 ? "1 edit" : `${edits.length} edits`;
    return `Applied ${count} to ${check.rel} (${outcome.result.length} chars).`;
  }

  write(path: string, content: string): string {
    const check = this.#resolve(path);
    if ("error" in check) return check.error;
    if (isHidden(check.rel)) return `Error: ${path} is not writable.`;
    if (isReadOnly(check.rel)) {
      return `Error: ${check.rel} is owner/system-maintained and read-only to you.`;
    }
    const problem = validateDataFile(check.rel, content);
    if (problem) return `Error: not saved. ${problem}`;

    mkdirSync(dirname(check.abs), { recursive: true });
    writeFileSync(check.abs, content);
    return `Saved ${check.rel} (${content.length} chars).`;
  }

  /**
   * The data-directory jail check for tools that read bytes directly.
   * Hidden files (credentials, the database) are as unreadable here as they
   * are through read_file.
   */
  resolvePath(path: string): { abs: string; rel: string } | { error: string } {
    const check = this.#resolve(path);
    if ("error" in check) return check;
    if (isHidden(check.rel)) return { error: `Error: ${path} is not readable.` };
    return check;
  }

  #resolve(path: string): { abs: string; rel: string } | { error: string } {
    const confined = confinePath(this.dataDir, path);
    if ("error" in confined) {
      return { error: `Error: "${path}" is outside your data directory.` };
    }
    return confined;
  }

  #walk(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.#walk(abs));
      } else {
        files.push(relative(this.dataDir, abs));
      }
    }
    return files;
  }
}

/**
 * Window a file by 1-indexed line offset/limit, then head-truncate to the
 * shared caps. Footers name absolute line numbers and the exact next call.
 */
function page(content: string, path: string, offset: number, limit?: number): string {
  const lines = splitLines(content);
  if (lines.length === 0) return content;
  if (offset > lines.length) {
    return `Error: offset ${offset} is beyond the end of ${path} (${lines.length} lines).`;
  }

  const window = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
  const paged = truncateHead(window.join("\n"));
  const last = offset - 1 + paged.lastLine;

  if (paged.truncated) {
    const cap = paged.truncatedBy === "bytes" ? ` (${DEFAULT_MAX_BYTES / 1024}KB limit)` : "";
    return `${paged.text}\n\n[Showing lines ${offset}-${last} of ${lines.length}${cap}. Use offset=${last + 1} to continue.]`;
  }
  if (last < lines.length) {
    return `${paged.text}\n\n[${lines.length - last} more lines in file. Use offset=${last + 1} to continue.]`;
  }
  // The whole remainder fit; return the original verbatim when nothing was cut.
  return offset === 1 ? content : paged.text;
}

function isHidden(rel: string): boolean {
  const parts = rel.split(sep);
  const base = (parts.at(-1) ?? rel).toLowerCase();
  if (parts.some((part) => part.startsWith("."))) return true;
  if (parts[0] !== undefined && HIDDEN_DIRS.has(parts[0].toLowerCase())) return true;
  if (HIDDEN_BASENAMES.has(base)) return true;
  return HIDDEN_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function isReadOnly(rel: string): boolean {
  return [...READ_ONLY].some((name) => name.toLowerCase() === rel.toLowerCase());
}

/** Resolve `path` under `dataDir`, rejecting traversal and symlink escapes. */
export function confinePath(
  dataDir: string,
  path: string,
): { abs: string; rel: string } | { error: string } {
  const root = existsSync(dataDir) ? realpathSync(dataDir) : resolve(dataDir);
  const abs = resolve(root, path);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { error: "outside" };
  }
  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) return { error: "symlink" };
    const real = realpathSync(abs);
    if (real !== root && !real.startsWith(root + sep)) return { error: "outside" };
  } else {
    let parent = dirname(abs);
    while (!existsSync(parent) && parent.startsWith(root)) {
      parent = dirname(parent);
    }
    if (existsSync(parent)) {
      if (lstatSync(parent).isSymbolicLink()) return { error: "symlink" };
      const realParent = realpathSync(parent);
      if (realParent !== root && !realParent.startsWith(root + sep)) return { error: "outside" };
    }
  }
  return { abs, rel: relative(root, abs) };
}

/**
 * Per-path write validation. Returns a problem description, or undefined.
 * Exported for the console, whose owner-facing editor enforces the same rules.
 */
export function validateDataFile(rel: string, content: string): string | undefined {
  if (rel === "skills-lock.json") {
    return "skills-lock.json is managed by the skills CLI — use `skills add/update/rm` instead.";
  }

  if (rel === "SCHEDULE.md") {
    const { errors } = parseSchedule(content);
    if (errors.length > 0) {
      return `SCHEDULE.md has problems — fix and retry (formats are in README.md):\n${errors.join("\n")}`;
    }
    return undefined;
  }

  if (rel === MCP_CONFIG_PATH) {
    const parsed = parseMcpConfig(content);
    if (!parsed.ok) {
      return `mcp/servers.json rejected — ${parsed.error} (format is in README.md).`;
    }
    return undefined;
  }

  const limit = fileBudget(rel);
  if (limit !== undefined && content.length > limit) {
    return (
      `${rel} is capped at ${limit} characters and this write is ${content.length}. ` +
      `Consolidate: keep only durable, high-value entries.`
    );
  }

  const parts = rel.split(sep);
  if (parts[0] === "people") {
    if (!isPeopleFile(parts)) {
      return `people files are laid out as people/<name>.md, got "${rel}".`;
    }
    return undefined;
  }
  if (parts[0] === "skills" && parts.at(-1) === "SKILL.md") {
    if (parts.length !== 3 || parts[1] === undefined) {
      return `skills are laid out as skills/<name>/SKILL.md, got "${rel}".`;
    }
    const problem = validateSkillMd(parts[1], content);
    if (problem) return `${rel} rejected — ${problem} (format is in README.md).`;
  }
  return undefined;
}
