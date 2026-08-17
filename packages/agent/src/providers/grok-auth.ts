import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceLoginPrompt } from "./chatgpt-auth.js";
import { SubscriptionAuthError } from "./errors.js";
import {
  decodeJwtPayload,
  getJwtExpiration,
  isRecord,
  safeResponseText,
  saveTokenFile,
  singleflight,
} from "./oauth.js";

/**
 * Grok subscription auth: the standard RFC 8628 device flow against auth.x.ai
 * using xAI's public Grok Build CLI client, so usage rides a SuperGrok /
 * SuperGrok Heavy / X Premium+ subscription instead of api.x.ai credits.
 * Unlike the ChatGPT flow there is no bespoke authorization-code relay — the
 * token endpoint is polled directly — and no account id claim; the id token's
 * email is kept purely for display.
 */

export const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_ISSUER = "https://auth.x.ai";
export const GROK_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
/** The client the CLI proxy expects; bump provider.grok.client_version when it starts answering 426. */
export const GROK_CLIENT_VERSION = "0.2.101";
export const GROK_CLIENT_IDENTIFIER = "grok-shell";

/** Fallback lifetime when the token response omits expires_in and the JWT has no exp. */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000;

export interface StoredGrokTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number;
  idToken?: string;
  /** Display only — from the id token's email claim. */
  email?: string;
  updatedAt: string;
}

export interface GrokCredentials {
  accessToken: string;
}

interface GrokDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface GrokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface RunGrokDeviceLoginOptions {
  authFile: string;
  onPrompt: (prompt: DeviceLoginPrompt) => void;
  fetch?: typeof globalThis.fetch;
  issuer?: string;
  clientId?: string;
  clientVersion?: string;
}

export interface GrokAuthManagerOptions {
  authFile: string;
  fetch?: typeof globalThis.fetch;
  issuer?: string;
  clientId?: string;
  clientVersion?: string;
  refreshLeewaySeconds?: number;
}

export class GrokAuthManager {
  readonly #authFile: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #clientVersion: string;
  readonly #refreshLeewaySeconds: number;

  constructor(options: GrokAuthManagerOptions) {
    this.#authFile = options.authFile;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#issuer = options.issuer ?? GROK_ISSUER;
    this.#clientId = options.clientId ?? GROK_OAUTH_CLIENT_ID;
    this.#clientVersion = options.clientVersion ?? GROK_CLIENT_VERSION;
    this.#refreshLeewaySeconds = options.refreshLeewaySeconds ?? 60;
  }

  /** Validate the stored file without refreshing tokens or making a request. */
  async validateStored(): Promise<void> {
    await this.#load();
  }

  async credentials(): Promise<GrokCredentials> {
    return singleflight(`grok:${this.#authFile}`, () => this.#credentials());
  }

  async #credentials(): Promise<GrokCredentials> {
    const stored = await this.#load();
    const shouldRefresh =
      effectiveExpiry(stored) <= Date.now() + this.#refreshLeewaySeconds * 1_000;
    const current = shouldRefresh ? await this.#refresh(stored) : stored;
    return { accessToken: current.accessToken };
  }

  async #load(): Promise<StoredGrokTokens> {
    let contents: string;
    try {
      contents = await readFile(this.#authFile, "utf8");
    } catch (error) {
      throw new SubscriptionAuthError(
        `Grok subscription auth is missing at ${this.#authFile}. Connect it in the console (Connections page).`,
        { cause: error },
      );
    }

    try {
      return parseStoredTokens(JSON.parse(contents) as unknown);
    } catch (error) {
      throw new SubscriptionAuthError(
        `Grok subscription auth at ${this.#authFile} is invalid. Reconnect it in the console (Connections page).`,
        { cause: error },
      );
    }
  }

  async #refresh(stored: StoredGrokTokens): Promise<StoredGrokTokens> {
    const response = await this.#fetch(`${this.#issuer}/oauth2/token`, {
      method: "POST",
      headers: grokAuthHeaders(this.#clientVersion),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.#clientId,
        refresh_token: stored.refreshToken,
      }),
    });

    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new SubscriptionAuthError(
        `Grok subscription token refresh failed (${response.status}). Reconnect it in the console (Connections page).${detail ? ` ${detail}` : ""}`,
      );
    }

    const refreshed = (await response.json()) as GrokTokenResponse;
    const accessToken = refreshed.access_token ?? stored.accessToken;
    const idToken = refreshed.id_token ?? stored.idToken;
    const email = emailFrom(idToken) ?? stored.email;
    const next: StoredGrokTokens = {
      accessToken,
      refreshToken: refreshed.refresh_token ?? stored.refreshToken,
      expiresAt: computeExpiry(accessToken, refreshed.expires_in),
      ...(idToken ? { idToken } : {}),
      ...(email ? { email } : {}),
      updatedAt: new Date().toISOString(),
    };
    await saveTokenFile(this.#authFile, next);
    return next;
  }
}

export async function runGrokDeviceLogin(
  options: RunGrokDeviceLoginOptions,
): Promise<StoredGrokTokens> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const issuer = options.issuer ?? GROK_ISSUER;
  const clientId = options.clientId ?? GROK_OAUTH_CLIENT_ID;
  const clientVersion = options.clientVersion ?? GROK_CLIENT_VERSION;
  const headers = grokAuthHeaders(clientVersion);

  const codeResponse = await fetchImplementation(`${issuer}/oauth2/device/code`, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      client_id: clientId,
      scope: GROK_OAUTH_SCOPE,
      referrer: "grok-build",
    }),
  });
  if (!codeResponse.ok) {
    throw new Error(`Device login could not start (${codeResponse.status})`);
  }
  const device = (await codeResponse.json()) as GrokDeviceCodeResponse;
  if (!device.device_code || !device.user_code || !device.verification_uri) {
    throw new Error("Device login returned an invalid response");
  }
  options.onPrompt({
    verificationUrl: device.verification_uri_complete ?? device.verification_uri,
    userCode: device.user_code,
  });

  const deadline = Date.now() + (device.expires_in ?? 15 * 60) * 1_000;
  let intervalMs = Math.max(device.interval ?? 5, 1) * 1_000;
  while (Date.now() < deadline) {
    const poll = await fetchImplementation(`${issuer}/oauth2/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: clientId,
      }),
    });
    if (poll.ok) {
      return await saveLoginTokens(options.authFile, (await poll.json()) as GrokTokenResponse);
    }
    const failure = (await poll.json().catch(() => ({}))) as GrokTokenResponse;
    switch (failure.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += 5_000;
        break;
      case "access_denied":
        throw new Error("Sign-in was denied");
      case "expired_token":
        throw new Error("The sign-in code expired — start again");
      default:
        throw new Error(
          `Device login failed (${poll.status})${failure.error_description ? `: ${failure.error_description}` : ""}`,
        );
    }
    await delay(intervalMs);
  }
  throw new Error("Device login timed out");
}

async function saveLoginTokens(
  authFile: string,
  oauth: GrokTokenResponse,
): Promise<StoredGrokTokens> {
  if (!oauth.access_token || !oauth.refresh_token) {
    throw new Error("OAuth token exchange returned incomplete credentials");
  }
  const email = emailFrom(oauth.id_token);
  const stored: StoredGrokTokens = {
    accessToken: oauth.access_token,
    refreshToken: oauth.refresh_token,
    expiresAt: computeExpiry(oauth.access_token, oauth.expires_in),
    ...(oauth.id_token ? { idToken: oauth.id_token } : {}),
    ...(email ? { email } : {}),
    updatedAt: new Date().toISOString(),
  };
  await saveTokenFile(authFile, stored);
  return stored;
}

function grokAuthHeaders(clientVersion: string): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-grok-client-version": clientVersion,
    "x-grok-client-surface": "cli",
  };
}

/**
 * expires_in is authoritative, capped by the access token's own exp when it is
 * a readable JWT — the refresh must never run later than the token dies.
 */
function computeExpiry(accessToken: string, expiresInSeconds?: number): number {
  const fromExpiresIn =
    expiresInSeconds !== undefined ? Date.now() + expiresInSeconds * 1_000 : undefined;
  let fromJwt: number | undefined;
  try {
    fromJwt = getJwtExpiration(accessToken);
  } catch {
    fromJwt = undefined;
  }
  if (fromExpiresIn !== undefined && fromJwt !== undefined) return Math.min(fromExpiresIn, fromJwt);
  return fromExpiresIn ?? fromJwt ?? Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS;
}

function effectiveExpiry(stored: StoredGrokTokens): number {
  try {
    return Math.min(stored.expiresAt, getJwtExpiration(stored.accessToken) ?? stored.expiresAt);
  } catch {
    return stored.expiresAt;
  }
}

function emailFrom(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = decodeJwtPayload(idToken);
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredTokens(value: unknown): StoredGrokTokens {
  if (!isRecord(value)) {
    throw new Error("Expected an object");
  }
  for (const key of ["accessToken", "refreshToken", "updatedAt"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`Missing ${key}`);
    }
  }
  if (typeof value.expiresAt !== "number") {
    throw new Error("Missing expiresAt");
  }
  return value as unknown as StoredGrokTokens;
}
