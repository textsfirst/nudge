import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  const temporaryPath = `${path}.${process.pid}.tmp`;
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
