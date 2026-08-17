import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { confinePath, fileBudget, validateDataFile } from "@nudge/agent";

/**
 * The owner's file surface over data_dir. Broader than the agent's: the owner
 * edits SYSTEM.md. Still hidden: secrets and runtime state. Still read-only:
 * README.md, which the server regenerates at boot.
 */

const HIDDEN_BASENAMES = new Set(["chatgpt-auth.json", "grok-auth.json"]);
const HIDDEN_PREFIXES = ["nudge.db"];
/** Google OAuth credentials + token caches — managed on the Connections page. */
// attachments/ holds inbound media bytes (hash-named, system-managed) — the
// thread view is their surface, not the file editor.
const HIDDEN_DIRS = new Set(["google", "attachments"]);
const SYSTEM_MANAGED = new Set(["README.md", "skills-lock.json"]);

/** Case-insensitive: macOS APFS would route "readme.md" to the same file. */
function isSystemManaged(rel: string): boolean {
  return [...SYSTEM_MANAGED].some((name) => name.toLowerCase() === rel.toLowerCase());
}

export interface FileInfo {
  path: string;
  size: number;
  modifiedAt: number;
  readOnly: boolean;
  budget: number | null;
}

export type FileResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export function listDataFiles(dataDir: string): FileInfo[] {
  if (!existsSync(dataDir)) return [];
  return walk(dataDir, dataDir)
    .filter((rel) => !isHidden(rel))
    .sort()
    .map((rel) => {
      const stats = statSync(join(dataDir, rel));
      return {
        path: rel,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        readOnly: isSystemManaged(rel),
        budget: fileBudget(rel) ?? null,
      };
    });
}

export function readDataFile(dataDir: string, path: string): FileResult<{
  path: string;
  content: string;
  hash: string;
  readOnly: boolean;
  budget: number | null;
}> {
  const check = guard(dataDir, path);
  if (!check.ok) return check;
  if (!existsSync(check.value.abs)) {
    return { ok: false, status: 404, error: `No file "${path}".` };
  }
  const content = readFileSync(check.value.abs, "utf8");
  return {
    ok: true,
    value: {
      path: check.value.rel,
      content,
      hash: contentHash(content),
      readOnly: isSystemManaged(check.value.rel),
      budget: fileBudget(check.value.rel) ?? null,
    },
  };
}

export function writeDataFile(
  dataDir: string,
  path: string,
  content: string,
  expectedHash?: string,
): FileResult<{
  path: string;
}> {
  const check = guard(dataDir, path);
  if (!check.ok) return check;
  if (isSystemManaged(check.value.rel)) {
    return { ok: false, status: 403, error: `${check.value.rel} is system-written; the server regenerates it at boot.` };
  }
  if (expectedHash && existsSync(check.value.abs)) {
    const current = contentHash(readFileSync(check.value.abs, "utf8"));
    if (current !== expectedHash) {
      return {
        ok: false,
        status: 409,
        error: "This file changed since you opened it. Reload and save again.",
      };
    }
  }
  const problem = validateDataFile(check.value.rel, content);
  if (problem) return { ok: false, status: 422, error: problem };
  mkdirSync(dirname(check.value.abs), { recursive: true });
  const temporary = `${check.value.abs}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, check.value.abs);
  return { ok: true, value: { path: check.value.rel } };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function deleteDataFile(dataDir: string, path: string): FileResult<{ path: string }> {
  const check = guard(dataDir, path);
  if (!check.ok) return check;
  if (isSystemManaged(check.value.rel)) {
    return { ok: false, status: 403, error: `${check.value.rel} cannot be deleted.` };
  }
  if (!existsSync(check.value.abs)) {
    return { ok: false, status: 404, error: `No file "${path}".` };
  }
  rmSync(check.value.abs);
  // Deleting the last file of a skill leaves an empty directory behind; prune it.
  let parent = dirname(check.value.abs);
  while (parent !== resolve(dataDir) && readdirSync(parent).length === 0) {
    rmSync(parent, { recursive: true });
    parent = dirname(parent);
  }
  return { ok: true, value: { path: check.value.rel } };
}

function guard(dataDir: string, path: string): FileResult<{ abs: string; rel: string }> {
  const confined = confinePath(dataDir, path);
  if ("error" in confined) {
    return { ok: false, status: 400, error: `"${path}" is outside the data directory.` };
  }
  if (confined.abs === resolve(dataDir) || confined.rel === "") {
    return { ok: false, status: 400, error: `"${path}" is outside the data directory.` };
  }
  if (isHidden(confined.rel)) {
    return { ok: false, status: 403, error: `"${path}" holds secrets or runtime state.` };
  }
  return { ok: true, value: confined };
}

function isHidden(rel: string): boolean {
  const parts = rel.split(sep);
  if (parts.some((part) => part.startsWith("."))) return true;
  if (parts[0] !== undefined && HIDDEN_DIRS.has(parts[0].toLowerCase())) return true;
  const base = (parts.at(-1) ?? rel).toLowerCase();
  if (HIDDEN_BASENAMES.has(base)) return true;
  return HIDDEN_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function walk(dir: string, root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(abs, root));
    } else {
      files.push(relative(root, abs));
    }
  }
  return files;
}
