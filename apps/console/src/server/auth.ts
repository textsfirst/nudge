import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

export const CONSOLE_AUTH_FILE = "console-auth.json";
export const CONSOLE_SESSION_COOKIE = "nudge_console_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_VERSION = 1;

interface StoredConsoleAuth {
  version: number;
  capability: string;
  createdAt: string;
}

export interface ConsoleSession {
  id: string;
  expiresAt: number;
}

export interface ConsoleAuthOptions {
  /** Tests may inject a capability without touching disk. */
  capability?: string | undefined;
  now?: (() => number) | undefined;
  secureCookies?: boolean | undefined;
}

/**
 * Persistent bootstrap capability plus stateless signed browser sessions.
 * The capability is submitted once in a JSON login body and never placed in
 * a URL, cookie, or browser storage.
 */
export class ConsoleAuth {
  readonly file: string;
  readonly created: boolean;
  readonly #capability: string;
  readonly #now: () => number;
  readonly #secureCookies: boolean;

  constructor(dataDir: string, options: ConsoleAuthOptions = {}) {
    this.file = join(dataDir, CONSOLE_AUTH_FILE);
    this.#now = options.now ?? Date.now;
    this.#secureCookies = options.secureCookies ?? false;

    if (options.capability !== undefined) {
      assertCapability(options.capability);
      this.#capability = options.capability;
      this.created = false;
      return;
    }

    const loaded = loadOrCreateAuth(this.file);
    this.#capability = loaded.capability;
    this.created = loaded.created;
  }

  /** Only startup and the explicit auth CLI should reveal this value. */
  revealCapability(): string {
    return this.#capability;
  }

  verifyCapability(candidate: string): boolean {
    return safeEqual(candidate, this.#capability);
  }

  issueSession(): { session: ConsoleSession; cookie: string; csrfToken: string } {
    const session: ConsoleSession = {
      id: randomBytes(24).toString("base64url"),
      expiresAt: this.#now() + SESSION_TTL_MS,
    };
    return {
      session,
      cookie: this.#cookie(this.#encodeSession(session), Math.floor(SESSION_TTL_MS / 1000)),
      csrfToken: this.csrfToken(session),
    };
  }

  session(request: Request): ConsoleSession | null {
    const value = parseCookies(request.headers.get("cookie"))[CONSOLE_SESSION_COOKIE];
    if (!value) return null;
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [id, expiresText, signature] = parts;
    if (!id || !expiresText || !signature || !/^\d+$/.test(expiresText)) return null;
    const expiresAt = Number(expiresText);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#now()) return null;
    const payload = `${id}.${expiresText}`;
    if (!safeEqual(signature, this.#sign(`session:${payload}`))) return null;
    return { id, expiresAt };
  }

  csrfToken(session: ConsoleSession): string {
    return this.#sign(`csrf:${session.id}:${session.expiresAt}`);
  }

  verifyCsrf(session: ConsoleSession, candidate: string | null): boolean {
    return candidate !== null && safeEqual(candidate, this.csrfToken(session));
  }

  clearCookie(): string {
    return this.#cookie("", 0);
  }

  #encodeSession(session: ConsoleSession): string {
    const payload = `${session.id}.${session.expiresAt}`;
    return `${payload}.${this.#sign(`session:${payload}`)}`;
  }

  #sign(value: string): string {
    return createHmac("sha256", this.#capability).update(value).digest("base64url");
  }

  #cookie(value: string, maxAge: number): string {
    return [
      `${CONSOLE_SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
      ...(this.#secureCookies ? ["Secure"] : []),
    ].join("; ");
  }
}

export function rotateConsoleCapability(dataDir: string): string {
  const file = join(dataDir, CONSOLE_AUTH_FILE);
  const capability = newCapability();
  writeStoredAuth(file, capability);
  return capability;
}

function loadOrCreateAuth(file: string): { capability: string; created: boolean } {
  if (existsSync(file)) {
    const parsed = parseStoredAuth(file);
    // Correct old or permissive umasks whenever the console starts.
    chmodSync(file, 0o600);
    return { capability: parsed.capability, created: false };
  }
  const capability = newCapability();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, storedAuthJson(capability), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { capability, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another console process won first-run creation. Never overwrite its key.
    const parsed = parseStoredAuth(file);
    chmodSync(file, 0o600);
    return { capability: parsed.capability, created: false };
  }
}

function parseStoredAuth(file: string): StoredConsoleAuth {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredConsoleAuth>;
    if (parsed.version !== AUTH_VERSION || typeof parsed.capability !== "string") {
      throw new Error("unsupported or incomplete auth data");
    }
    assertCapability(parsed.capability);
    return {
      version: AUTH_VERSION,
      capability: parsed.capability,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "unknown",
    };
  } catch (error) {
    throw new Error(
      `Could not read console auth file ${file}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Fix its permissions/content or run `pnpm console:auth rotate`.",
    );
  }
}

function writeStoredAuth(file: string, capability: string): void {
  assertCapability(capability);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, storedAuthJson(capability), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function storedAuthJson(capability: string): string {
  return `${JSON.stringify(
    { version: AUTH_VERSION, capability, createdAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
}

function newCapability(): string {
  return randomBytes(32).toString("base64url");
}

function assertCapability(capability: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    throw new Error("Console capability must be a 256-bit base64url value.");
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name) cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}
