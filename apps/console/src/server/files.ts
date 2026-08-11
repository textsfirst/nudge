import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MEMORY_LIMITS, validateDataFile } from "@nudge/agent";

/**
 * The owner's file surface over data_dir. Broader than the agent's: the owner
 * edits SYSTEM.md. Still hidden: secrets and runtime state. Still read-only:
 * README.md, which the server regenerates at boot.
 */

const HIDDEN_BASENAMES = new Set(["chatgpt-auth.json"]);
const HIDDEN_PREFIXES = ["nudge.db"];
/** Google OAuth credentials + token caches — managed on the Connections page. */
// attachments/ holds inbound media bytes (hash-named, system-managed) — the
// thread view is their surface, not the file editor.
const HIDDEN_DIRS = new Set(["google", "attachments"]);
const SYSTEM_MANAGED = new Set(["README.md", "skills-lock.json"]);

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
        readOnly: SYSTEM_MANAGED.has(rel),
        budget: MEMORY_LIMITS[rel] ?? null,
      };
    });
}

export function readDataFile(dataDir: string, path: string): FileResult<{
  path: string;
  content: string;
  readOnly: boolean;
  budget: number | null;
}> {
  const check = guard(dataDir, path);
  if (!check.ok) return check;
  if (!existsSync(check.value.abs)) {
    return { ok: false, status: 404, error: `No file "${path}".` };
  }
  return {
    ok: true,
    value: {
      path: check.value.rel,
      content: readFileSync(check.value.abs, "utf8"),
      readOnly: SYSTEM_MANAGED.has(check.value.rel),
      budget: MEMORY_LIMITS[check.value.rel] ?? null,
    },
  };
}

export function writeDataFile(dataDir: string, path: string, content: string): FileResult<{
  path: string;
}> {
  const check = guard(dataDir, path);
  if (!check.ok) return check;
  if (SYSTEM_MANAGED.has(check.value.rel)) {
    return { ok: false, status: 403, error: `${check.value.rel} is system-written; the server regenerates it at boot.` };
  }
  const problem = validateDataFile(check.value.rel, content);
  if (problem) return { ok: false, status: 422, error: problem };
  mkdirSync(dirname(check.value.abs), { recursive: true });
  writeFileSync(check.value.abs, content);
  return { ok: true, value: { path: check.value.rel } };
}

export function deleteDataFile(dataDir: string, path: string): FileResult<{ path: string }> {
  const check = guard(dataDir, path);
  if (!check.ok) return check;
  if (SYSTEM_MANAGED.has(check.value.rel)) {
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
  const base = resolve(dataDir);
  const abs = resolve(base, path);
  if (abs === base || !abs.startsWith(base + sep)) {
    return { ok: false, status: 400, error: `"${path}" is outside the data directory.` };
  }
  const rel = relative(base, abs);
  if (isHidden(rel)) {
    return { ok: false, status: 403, error: `"${path}" holds secrets or runtime state.` };
  }
  return { ok: true, value: { abs, rel } };
}

function isHidden(rel: string): boolean {
  const parts = rel.split(sep);
  if (parts.some((part) => part.startsWith("."))) return true;
  if (parts[0] !== undefined && HIDDEN_DIRS.has(parts[0])) return true;
  const base = parts.at(-1) ?? rel;
  if (HIDDEN_BASENAMES.has(base)) return true;
  return HIDDEN_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function walk(dir: string, root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(abs, root));
    } else {
      files.push(relative(root, abs));
    }
  }
  return files;
}
