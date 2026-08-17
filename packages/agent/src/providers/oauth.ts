import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const inflight = new Map<string, Promise<unknown>>();

/** Coalesce concurrent work on the same auth file (refresh + health probe). */
export function singleflight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = run().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

/** Shared plumbing for the subscription OAuth providers (ChatGPT, Grok). */

export function getJwtExpiration(jwt: string): number | undefined {
  const payload = decodeJwtPayload(jwt);
  return typeof payload.exp === "number" ? payload.exp * 1_000 : undefined;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) {
    throw new Error("Invalid JWT");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  if (!isRecord(decoded)) {
    throw new Error("Invalid JWT payload");
  }
  return decoded;
}

/** Atomic owner-only write, so a crash never leaves a partial or readable token file. */
export async function saveTokenFile(path: string, tokens: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function safeResponseText(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
