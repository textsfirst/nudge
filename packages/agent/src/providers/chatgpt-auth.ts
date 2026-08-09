import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SubscriptionAuthError } from "./errors.js";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_ISSUER = "https://auth.openai.com";

export interface StoredChatGptTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  updatedAt: string;
}

export interface ChatGptCredentials {
  accessToken: string;
  accountId: string;
}

interface DeviceCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval: string | number;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

export interface DeviceLoginPrompt {
  verificationUrl: string;
  userCode: string;
}

export interface RunDeviceLoginOptions {
  authFile: string;
  onPrompt: (prompt: DeviceLoginPrompt) => void;
  fetch?: typeof globalThis.fetch;
  issuer?: string;
  clientId?: string;
}

export interface ChatGptAuthManagerOptions {
  authFile: string;
  fetch?: typeof globalThis.fetch;
  issuer?: string;
  clientId?: string;
  refreshLeewaySeconds?: number;
}

export class ChatGptAuthManager {
  readonly #authFile: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #refreshLeewaySeconds: number;

  constructor(options: ChatGptAuthManagerOptions) {
    this.#authFile = options.authFile;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#issuer = options.issuer ?? CHATGPT_ISSUER;
    this.#clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
    this.#refreshLeewaySeconds = options.refreshLeewaySeconds ?? 60;
  }

  async credentials(): Promise<ChatGptCredentials> {
    const stored = await this.#load();
    let expiration: number | undefined;
    try {
      expiration = getJwtExpiration(stored.accessToken);
    } catch {
      expiration = 0;
    }
    const shouldRefresh =
      expiration === undefined ||
      expiration <= Date.now() + this.#refreshLeewaySeconds * 1_000;
    const current = shouldRefresh ? await this.#refresh(stored) : stored;
    return { accessToken: current.accessToken, accountId: current.accountId };
  }

  async #load(): Promise<StoredChatGptTokens> {
    let contents: string;
    try {
      contents = await readFile(this.#authFile, "utf8");
    } catch (error) {
      throw new SubscriptionAuthError(
        `ChatGPT subscription auth is missing at ${this.#authFile}. Run \"pnpm auth:chatgpt\".`,
        { cause: error },
      );
    }

    try {
      return parseStoredTokens(JSON.parse(contents) as unknown);
    } catch (error) {
      throw new SubscriptionAuthError(
        `ChatGPT subscription auth at ${this.#authFile} is invalid. Run \"pnpm auth:chatgpt\" again.`,
        { cause: error },
      );
    }
  }

  async #refresh(stored: StoredChatGptTokens): Promise<StoredChatGptTokens> {
    const response = await this.#fetch(`${this.#issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.#clientId,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    });

    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new SubscriptionAuthError(
        `ChatGPT subscription token refresh failed (${response.status}). Run \"pnpm auth:chatgpt\" again.${detail ? ` ${detail}` : ""}`,
      );
    }

    const refreshed = (await response.json()) as OAuthTokenResponse;
    const idToken = refreshed.id_token ?? stored.idToken;
    const next: StoredChatGptTokens = {
      accessToken: refreshed.access_token ?? stored.accessToken,
      refreshToken: refreshed.refresh_token ?? stored.refreshToken,
      idToken,
      accountId: extractAccountId(idToken) ?? stored.accountId,
      updatedAt: new Date().toISOString(),
    };
    await saveTokens(this.#authFile, next);
    return next;
  }
}

export async function runChatGptDeviceLogin(
  options: RunDeviceLoginOptions,
): Promise<StoredChatGptTokens> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
  const apiBase = `${issuer}/api/accounts`;

  const codeResponse = await fetchImplementation(`${apiBase}/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!codeResponse.ok) {
    throw new Error(`Device login could not start (${codeResponse.status})`);
  }
  const device = (await codeResponse.json()) as DeviceCodeResponse;
  const userCode = device.user_code ?? device.usercode;
  if (!device.device_auth_id || !userCode) {
    throw new Error("Device login returned an invalid response");
  }
  options.onPrompt({
    verificationUrl: `${issuer}/codex/device`,
    userCode,
  });

  const deadline = Date.now() + 15 * 60 * 1_000;
  const intervalMs = Math.max(Number(device.interval) || 5, 1) * 1_000;
  let authorization: DeviceTokenResponse | undefined;
  while (Date.now() < deadline) {
    const poll = await fetchImplementation(`${apiBase}/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: device.device_auth_id,
        user_code: userCode,
      }),
    });
    if (poll.ok) {
      authorization = (await poll.json()) as DeviceTokenResponse;
      break;
    }
    if (poll.status !== 403 && poll.status !== 404) {
      throw new Error(`Device login failed (${poll.status})`);
    }
    await delay(intervalMs);
  }
  if (!authorization) {
    throw new Error("Device login timed out after 15 minutes");
  }
  if (!authorization.authorization_code || !authorization.code_verifier) {
    throw new Error("Device login returned incomplete authorization data");
  }

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorization.authorization_code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: clientId,
    code_verifier: authorization.code_verifier,
  });
  const tokenResponse = await fetchImplementation(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) {
    throw new Error(`OAuth token exchange failed (${tokenResponse.status})`);
  }
  const oauth = (await tokenResponse.json()) as OAuthTokenResponse;
  if (!oauth.access_token || !oauth.refresh_token || !oauth.id_token) {
    throw new Error("OAuth token exchange returned incomplete credentials");
  }
  const accountId = extractAccountId(oauth.id_token);
  if (!accountId) {
    throw new Error("The ChatGPT OAuth token did not contain an account ID");
  }

  const stored: StoredChatGptTokens = {
    accessToken: oauth.access_token,
    refreshToken: oauth.refresh_token,
    idToken: oauth.id_token,
    accountId,
    updatedAt: new Date().toISOString(),
  };
  await saveTokens(options.authFile, stored);
  return stored;
}

export function getJwtExpiration(jwt: string): number | undefined {
  const payload = decodeJwtPayload(jwt);
  return typeof payload.exp === "number" ? payload.exp * 1_000 : undefined;
}

export function extractAccountId(jwt: string): string | undefined {
  const payload = decodeJwtPayload(jwt);
  const auth = payload["https://api.openai.com/auth"];
  if (isRecord(auth) && typeof auth.chatgpt_account_id === "string") {
    return auth.chatgpt_account_id;
  }
  return typeof payload.chatgpt_account_id === "string"
    ? payload.chatgpt_account_id
    : undefined;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
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

function parseStoredTokens(value: unknown): StoredChatGptTokens {
  if (!isRecord(value)) {
    throw new Error("Expected an object");
  }
  for (const key of ["accessToken", "refreshToken", "idToken", "accountId", "updatedAt"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`Missing ${key}`);
    }
  }
  return value as unknown as StoredChatGptTokens;
}

async function saveTokens(path: string, tokens: StoredChatGptTokens): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function safeResponseText(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
