import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { SECRET_SPECS } from "@nudge/server/config";

/**
 * Line-preserving .env editing: comments, ordering, and unrelated entries
 * survive every write, because the owner also edits this file by hand.
 */

export interface SecretInfo {
  key: string;
  set: boolean;
  known: boolean;
  required: boolean;
  description: string;
}

/** The secrets Nudge understands, in display order. */
export const KNOWN_SECRETS: ReadonlyArray<Omit<SecretInfo, "set">> = [
  ...SECRET_SPECS.map((secret) => ({ ...secret, known: true as const })),
];

const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function renderEnvValue(value: string): string {
  if (/^[A-Za-z0-9_@.:/+=-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error("Secret values cannot contain both single and double quotes.");
}

/**
 * Parse cache keyed on mtime+size (size guards sub-ms mtime granularity), so
 * repeat reads cost one stat and any write — ours or an external editor's —
 * invalidates naturally. Callers must treat the returned map as read-only.
 */
const parseCache = new Map<string, { mtimeMs: number; size: number; values: Map<string, string> }>();

export function readEnvKeys(path: string): Map<string, string> {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return new Map();
  }
  const cached = parseCache.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.values;
  }
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = LINE_PATTERN.exec(line);
    if (!match?.[1]) continue;
    let raw = line.slice(line.indexOf("=") + 1).trim();
    if (!(raw.startsWith('"') || raw.startsWith("'"))) {
      const comment = raw.search(/\s+#/);
      if (comment >= 0) raw = raw.slice(0, comment).trimEnd();
    }
    values.set(match[1], raw.replace(/^(["'])(.*)\1$/, "$2"));
  }
  parseCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, values });
  return values;
}

export function listSecrets(path: string): SecretInfo[] {
  const values = readEnvKeys(path);
  const known = KNOWN_SECRETS.map((secret) => ({
    ...secret,
    set: (values.get(secret.key) ?? "") !== "",
  }));
  const knownKeys = new Set(KNOWN_SECRETS.map((secret) => secret.key));
  const custom = [...values.entries()]
    .filter(([key, value]) => !knownKeys.has(key) && key !== "PORT" && value !== "")
    .map(([key]) => ({ key, set: true, known: false, required: false, description: "" }));
  return [...known, ...custom];
}

export function setEnvValue(path: string, key: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error("Secret names must be like MY_API_KEY (letters, digits, underscores).");
  }
  if (value.includes("\n")) {
    throw new Error("Secret values cannot contain newlines.");
  }
  const rendered = renderEnvValue(value);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (LINE_PATTERN.exec(lines[i]!)?.[1] === key) index = i;
  }
  if (index >= 0) {
    lines[index] = `${key}=${rendered}`;
  } else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    lines.push(`${key}=${rendered}`, "");
  }
  writeFileSync(path, lines.join("\n"));
}

export function deleteEnvValue(path: string, key: string): boolean {
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, "utf8").split("\n");
  const filtered = lines.filter((line) => LINE_PATTERN.exec(line)?.[1] !== key);
  if (filtered.length === lines.length) return false;
  writeFileSync(path, filtered.join("\n"));
  return true;
}
