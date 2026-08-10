import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
  {
    key: "SPECTRUM_PROJECT_ID",
    known: true,
    required: true,
    description: "Photon Cloud project id (app.photon.codes)",
  },
  {
    key: "SPECTRUM_PROJECT_SECRET",
    known: true,
    required: true,
    description: "Photon Cloud project secret",
  },
  {
    key: "SPECTRUM_WEBHOOK_SECRET",
    known: true,
    required: true,
    description: "Photon webhook signing secret",
  },
  {
    key: "OPENAI_API_KEY",
    known: true,
    required: false,
    description: "OpenAI API key — API provider, or fallback for subscription auth",
  },
  {
    key: "FIRECRAWL_API_KEY",
    known: true,
    required: false,
    description: "Enables the web_search / web_extract tools",
  },
];

const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function readEnvKeys(path: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = LINE_PATTERN.exec(line);
    if (!match?.[1]) continue;
    const raw = line.slice(line.indexOf("=") + 1).trim();
    values.set(match[1], raw.replace(/^(["'])(.*)\1$/, "$2"));
  }
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
  const rendered = /^[A-Za-z0-9_@.:/+=-]*$/.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const index = lines.findIndex((line) => LINE_PATTERN.exec(line)?.[1] === key);
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
