import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { parseSchedule } from "@nudge/schedule";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Google account connections for the gws CLI.
 *
 * The console owns the OAuth authorization-code flow end to end (Web
 * application client, redirect back to the console's own origin) so consent
 * works from any browser that can reach the console — including phones over a
 * tunnel — with no browser or keyring on the server. Tokens are handed to gws
 * through its documented headless path: a plaintext authorized-user
 * credentials file per account, selected per exec by the shim in bin/gws.
 *
 * Layout under DATA_DIR/google/ (invisible to the agent's file tools, same
 * posture as chatgpt-auth.json):
 *   client_secret.json   one OAuth client shared by every account
 *   accounts.json        registry: label, email, scopes, connected_at
 *   <label>/credentials.json   authorized-user file gws reads
 *   <label>/                    also gws's per-account config dir (token cache)
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Labels are typed by the agent in every gws call — keep them short slugs. */
export const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

export interface GoogleService {
  id: string;
  name: string;
  /** Hostname for the Cloud Console "enable this API" deep link. */
  api: string;
  readonlyScope: string;
  fullScope: string;
}

/**
 * The services the connect wizard offers, with one read-only/full scope pair
 * each (mirroring gws's own scope tables). Everything here plus the two base
 * scopes stays far under Google's ~25-scope consent cap for unverified apps.
 */
export const GOOGLE_SERVICES: readonly GoogleService[] = [
  {
    id: "gmail",
    name: "Gmail",
    api: "gmail.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/gmail.readonly",
    fullScope: "https://www.googleapis.com/auth/gmail.modify",
  },
  {
    id: "calendar",
    name: "Calendar",
    api: "calendar-json.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/calendar.readonly",
    fullScope: "https://www.googleapis.com/auth/calendar",
  },
  {
    id: "drive",
    name: "Drive",
    api: "drive.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/drive.readonly",
    fullScope: "https://www.googleapis.com/auth/drive",
  },
  {
    id: "docs",
    name: "Docs",
    api: "docs.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/documents.readonly",
    fullScope: "https://www.googleapis.com/auth/documents",
  },
  {
    id: "sheets",
    name: "Sheets",
    api: "sheets.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    fullScope: "https://www.googleapis.com/auth/spreadsheets",
  },
  {
    id: "contacts",
    name: "Contacts",
    api: "people.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/contacts.readonly",
    fullScope: "https://www.googleapis.com/auth/contacts",
  },
  {
    id: "tasks",
    name: "Tasks",
    api: "tasks.googleapis.com",
    readonlyScope: "https://www.googleapis.com/auth/tasks.readonly",
    fullScope: "https://www.googleapis.com/auth/tasks",
  },
];

/** Always requested: identifies the account (email lands in the id_token). */
export const GOOGLE_BASE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleAccount {
  label: string;
  email: string;
  scopes: string[];
  connectedAt: string;
}

export function googleDir(dataDir: string): string {
  return join(dataDir, "google");
}

export function googleAccountDir(dataDir: string, label: string): string {
  return join(googleDir(dataDir), label);
}

export function googleCredentialsPath(dataDir: string, label: string): string {
  return join(googleAccountDir(dataDir, label), "credentials.json");
}

const CLIENT_FILE = "client_secret.json";
const REGISTRY_FILE = "accounts.json";

// -- OAuth client -----------------------------------------------------------

export function readGoogleClient(dataDir: string): GoogleClient | undefined {
  const path = join(googleDir(dataDir), CLIENT_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    const clientId = parsed.client_id;
    const clientSecret = parsed.client_secret;
    if (typeof clientId === "string" && typeof clientSecret === "string") {
      return { clientId, clientSecret };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepts either bare id+secret fields or the JSON Google Cloud Console
 * offers for download (which wraps them in a "web" or "installed" object).
 */
export function parseGoogleClientInput(input: {
  client_id?: string;
  client_secret?: string;
  json?: string;
}): GoogleClient {
  if (input.json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.json);
    } catch {
      throw new Error("That is not valid JSON — paste the file exactly as downloaded.");
    }
    const record = isRecord(parsed) ? parsed : {};
    const inner = ["web", "installed"]
      .map((key) => record[key])
      .find(isRecord) ?? record;
    if (typeof inner.client_id === "string" && typeof inner.client_secret === "string") {
      return { clientId: inner.client_id, clientSecret: inner.client_secret };
    }
    throw new Error(
      'The JSON has no client_id/client_secret. Download the OAuth client\'s JSON ("Web application" type) and paste it whole.',
    );
  }
  const clientId = input.client_id?.trim() ?? "";
  const clientSecret = input.client_secret?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("Provide both the client ID and the client secret.");
  }
  return { clientId, clientSecret };
}

export function saveGoogleClient(dataDir: string, client: GoogleClient): void {
  mkdirSync(googleDir(dataDir), { recursive: true });
  writeSecretFile(
    join(googleDir(dataDir), CLIENT_FILE),
    JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret }, null, 2),
  );
}

// -- account registry -------------------------------------------------------

export function readGoogleAccounts(dataDir: string): GoogleAccount[] {
  const path = join(googleDir(dataDir), REGISTRY_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) return [];
    return parsed.accounts.filter(isAccount);
  } catch {
    return [];
  }
}

function writeGoogleAccounts(dataDir: string, accounts: GoogleAccount[]): void {
  mkdirSync(googleDir(dataDir), { recursive: true });
  const path = join(googleDir(dataDir), REGISTRY_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
  renameSync(temporary, path);
}

// -- OAuth flow -------------------------------------------------------------

export function googleAuthUrl(input: {
  client: GoogleClient;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.client.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: [...GOOGLE_BASE_SCOPES, ...input.scopes].join(" "),
    // offline + consent guarantees a refresh token even on re-auth.
    access_type: "offline",
    prompt: "select_account consent",
    state: input.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokens {
  refreshToken: string;
  email: string;
  /** Scopes Google actually granted — consent screens allow partial grants. */
  grantedScopes: string[];
}

export async function exchangeGoogleCode(input: {
  code: string;
  redirectUri: string;
  client: GoogleClient;
  fetch?: typeof globalThis.fetch;
}): Promise<GoogleTokens> {
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      redirect_uri: input.redirectUri,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Google rejected the code exchange (${response.status}): ${describeOAuthError(body)}`);
  }
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error(
      "Google returned no refresh token. Remove Nudge's access at myaccount.google.com/permissions and connect again.",
    );
  }
  const idToken = typeof body.id_token === "string" ? body.id_token : "";
  const email = emailFromIdToken(idToken);
  if (!email) {
    throw new Error("Google's response did not identify the account (no email in the id_token).");
  }
  const grantedScopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
  return { refreshToken, email, grantedScopes };
}

/**
 * Persist a connected account: the authorized-user credentials file gws reads
 * (via GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, set per exec by the shim) plus
 * the registry entry. Reconnecting an existing label replaces both.
 */
export function saveGoogleAccount(
  dataDir: string,
  input: { label: string; client: GoogleClient; tokens: GoogleTokens },
): GoogleAccount {
  const dir = googleAccountDir(dataDir, input.label);
  mkdirSync(dir, { recursive: true });
  writeSecretFile(
    googleCredentialsPath(dataDir, input.label),
    JSON.stringify(
      {
        type: "authorized_user",
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        refresh_token: input.tokens.refreshToken,
      },
      null,
      2,
    ),
  );
  const account: GoogleAccount = {
    label: input.label,
    email: input.tokens.email,
    scopes: input.tokens.grantedScopes.filter((scope) => !GOOGLE_BASE_SCOPES.includes(scope)),
    connectedAt: new Date().toISOString(),
  };
  const rest = readGoogleAccounts(dataDir).filter((entry) => entry.label !== input.label);
  writeGoogleAccounts(dataDir, [...rest, account].sort((a, b) => a.label.localeCompare(b.label)));
  seedGoogleSkill(dataDir);
  try {
    seedInboxJobs(dataDir, account);
  } catch {
    // Seeding is a bonus on top of the connect; it must never fail one.
  }
  return account;
}

/** Best-effort token revocation, then remove the account dir and registry entry. */
export async function removeGoogleAccount(
  dataDir: string,
  label: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  const accounts = readGoogleAccounts(dataDir);
  if (!accounts.some((account) => account.label === label)) return false;
  const refreshToken = readRefreshToken(dataDir, label);
  if (refreshToken) {
    try {
      await fetchImplementation(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
        method: "POST",
      });
    } catch {
      // Revocation is a courtesy; disconnecting must work offline too.
    }
  }
  rmSync(googleAccountDir(dataDir, label), { recursive: true, force: true });
  writeGoogleAccounts(dataDir, accounts.filter((account) => account.label !== label));
  try {
    removeSeededInboxWatch(dataDir, label);
  } catch {
    // A leftover watcher fails loudly on its next check; never block a disconnect on it.
  }
  return true;
}

export type GoogleAccountStatus = "ok" | "expired" | "unreachable" | "missing";

/**
 * Live token check: a refresh grant against Google. invalid_grant means the
 * refresh token is dead (revoked, consent-screen testing expiry, password
 * change) and the owner must reconnect; network trouble is not "expired".
 */
export async function probeGoogleAccount(
  dataDir: string,
  label: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<GoogleAccountStatus> {
  const credentials = readCredentialsFile(dataDir, label);
  if (!credentials) return "missing";
  try {
    const response = await fetchImplementation(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return "ok";
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return body.error === "invalid_grant" ? "expired" : "unreachable";
  } catch {
    return "unreachable";
  }
}

// -- gws binary + agent environment ----------------------------------------

/** The directory holding the agent-facing gws shim (apps/server/bin). */
export function gwsShimDir(): string {
  return fileURLToPath(new URL("../bin", import.meta.url));
}

/**
 * Environment for the agent's bash tool: the shim first on PATH plus the
 * pointers it needs. GOOGLE_WORKSPACE_CLI_* stays out of the agent's env on
 * purpose — the shim sets it per exec for the chosen account.
 */
export function buildGwsBashEnv(options: {
  dataDir: string;
  defaultAccount?: string | undefined;
  gwsPath?: string | undefined;
}): Record<string, string> {
  return {
    PATH: `${gwsShimDir()}${delimiter}${process.env.PATH ?? ""}`,
    NUDGE_GOOGLE_DIR: googleDir(options.dataDir),
    ...(options.defaultAccount ? { NUDGE_GOOGLE_DEFAULT_ACCOUNT: options.defaultAccount } : {}),
    ...(options.gwsPath ? { GWS_BINARY: options.gwsPath } : {}),
  };
}

/**
 * Locate the real gws binary the shim will exec: an explicit configured path,
 * else a PATH scan that skips the shim's own directory. Reports the version so
 * the console can show install state.
 */
export async function findGwsBinary(
  gwsPath?: string,
): Promise<{ path: string; version: string } | undefined> {
  const shimDir = gwsShimDir();
  const candidates = gwsPath
    ? [gwsPath]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => dir && dir !== shimDir)
        .map((dir) => join(dir, "gws"));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const version = await runForVersion(candidate);
    if (version !== undefined) return { path: candidate, version };
  }
  return undefined;
}

function runForVersion(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output.trim() : undefined);
    });
  });
}

// -- seeded skill -----------------------------------------------------------

export const GOOGLE_SKILL_NAME = "google-workspace";

const GOOGLE_SKILL = `---
name: google-workspace
description: Use the gws CLI (bash) for the owner's Gmail, Calendar, Drive, Docs, Sheets, Contacts, and Tasks
version: 2
---

# Google Workspace via gws

The owner's Google accounts are available through the \`gws\` CLI in bash. Your
prompt lists the connected accounts; \`gws accounts\` prints them with the
services each one was granted.

## Choosing the account

    gws -a work gmail +triage
    gws -a personal calendar +agenda

With one account connected (or a configured default) you can omit \`-a\`.
Accounts may have different services and read-only vs full access — check
\`gws accounts\` before assuming an account can send mail or edit files.

## High-value commands

    gws gmail +triage                 # unread inbox summary
    gws gmail +send --to a@b.c --subject "Hi" --body "..."   # see "Outbound mail"
    gws gmail +reply --message-id ID --body "..."            # see "Outbound mail"
    gws calendar +agenda              # upcoming events, owner's timezone
    gws calendar +insert ...          # create an event
    gws drive +upload ./file.pdf
    gws workflow +standup-report      # meetings + tasks summary

## Outbound mail: drafts first

Sending (+send, +reply, +forward, and raw ...messages/drafts send calls) only
works in the assistant's own conversation with the owner, after the owner has
approved the exact message; everywhere else gws refuses (exit 3). Background
agents and scheduled runs prepare Gmail drafts and report the draft id:

    gws schema gmail.users.drafts.create      # verify the exact shape first
    gws gmail users drafts create --params '{"message": ...}'
    gws gmail users drafts send --params '{"id": "..."}'   # after approval

On approval, send the approved draft by id — never recompose — so what goes
out is exactly what the owner saw.

## Discovering everything else

gws exposes every Google Workspace API method, generated live:

    gws <service> --help              # methods + helper commands
    gws schema gmail.users.messages.list
    gws drive files list --params '{"pageSize": 5}'   # JSON out; pipe to jq
    ... --dry-run                     # preview a request without sending it

Wrap Sheets ranges in single quotes ('Sheet1!A1:C10') — \`!\` breaks bash.

## When it fails

- Exit code 2 = the account's Google auth expired. Do not retry; tell the
  owner to reconnect it in the console (Connections page).
- \`gws auth ...\` is owner-managed and blocked for you, by design.
- A refusal about sending means this turn cannot send by design — create a
  draft and hand it off instead of retrying.
- Exit code 1 = the API said no (permissions, bad id); the JSON error says why.
`;

/**
 * sha256 of every prior GOOGLE_SKILL revision ever shipped. An on-disk copy
 * matching one of these was never customized and is safe to replace with the
 * current text; anything else belongs to the owner or the agent and is kept
 * forever — the same rule syncBundledContent applies to bundled skills.
 */
const GOOGLE_SKILL_PRIOR_HASHES: ReadonlySet<string> = new Set([
  // v1: pre drafts-first (no "Outbound mail" section).
  "e2acecd79d9eb34e261af4df6ade06c72cbb53e9b1afd1928c402af8101aa5a8",
]);

/**
 * Seed the skill (on connect) and upgrade it in place when the on-disk copy
 * is an unmodified prior revision. A customized copy is the owner's or the
 * agent's and is never touched. Boot passes createIfMissing: false so a
 * deleted skill is only re-created by a deliberate reconnect, never by a
 * restart.
 */
export function seedGoogleSkill(
  dataDir: string,
  options?: { createIfMissing?: boolean; priorHashes?: ReadonlySet<string> },
): void {
  const dir = join(dataDir, "skills", GOOGLE_SKILL_NAME);
  const path = join(dir, "SKILL.md");
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === GOOGLE_SKILL) return;
    const hash = createHash("sha256").update(current).digest("hex");
    if (!(options?.priorHashes ?? GOOGLE_SKILL_PRIOR_HASHES).has(hash)) return;
  } else if (options?.createIfMissing === false) {
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, GOOGLE_SKILL);
}

// -- seeded inbox job -------------------------------------------------------

/**
 * A Gmail-scoped connect turns the inbox into a standing job by default: a
 * check-gated SCHEDULE.md watcher per account (all sharing one standing
 * "email" agent, which materializes on first fire) plus one morning-rundown
 * entry. The owner turns any of it off by deleting the entry — the marker
 * below records what was seeded so a deletion is never overridden.
 */

const GMAIL_SCOPE_PREFIX = "https://www.googleapis.com/auth/gmail.";
const RUNDOWN_ENTRY_NAME = "Morning rundown";
const SEEDS_FILE = "seeds.json";

export function inboxWatchEntryName(label: string): string {
  return `Inbox watch (${label})`;
}

interface InboxSeeds {
  rundown: boolean;
  inboxWatch: string[];
}

function readInboxSeeds(dataDir: string): InboxSeeds {
  const none: InboxSeeds = { rundown: false, inboxWatch: [] };
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(googleDir(dataDir), SEEDS_FILE), "utf8"),
    );
    if (!isRecord(parsed)) return none;
    return {
      rundown: parsed.rundown === true,
      inboxWatch: Array.isArray(parsed.inboxWatch)
        ? parsed.inboxWatch.filter((label): label is string => typeof label === "string")
        : [],
    };
  } catch {
    return none;
  }
}

function writeInboxSeeds(dataDir: string, seeds: InboxSeeds): void {
  mkdirSync(googleDir(dataDir), { recursive: true });
  writeFileSync(
    join(googleDir(dataDir), SEEDS_FILE),
    `${JSON.stringify({ version: 1, ...seeds }, null, 2)}\n`,
  );
}

function schedulePath(dataDir: string): string {
  return join(dataDir, "SCHEDULE.md");
}

/** Section names already present in the file — malformed sections still occupy their name. */
function scheduleHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  for (const match of markdown.matchAll(/^##\s+(.+?)\s*$/gm)) {
    headings.add(match[1]!.toLowerCase());
  }
  return headings;
}

function inboxWatchSection(account: GoogleAccount): string {
  // The check is gmail-tail's arrivals journal, not an inbox snapshot: its
  // output changes exactly when mail arrives (Gmail history cursor), so the
  // agent never wakes because the owner merely read or archived something,
  // and mail handled on another device before the sweep is still seen.
  const name = inboxWatchEntryName(account.label);
  return `## ${name}
when: every 5 minutes
agent: email
check: gmail-tail ${account.label}
New mail arrived on the ${account.label} account (${account.email}) — the
last lines of the check output are the arrivals journal, newest last; the
ones you have not seen before are what landed. A [gap] line means arrivals
may have been missed — sweep the inbox with gws to catch up. Triage with
gws -a ${account.label}: read what arrived, judge what actually matters
against the owner's interruption budget, and prepare Gmail drafts — never
send — for anything that needs a reply. Report only what needs the owner
(what landed, why it matters, which drafts are waiting); if nothing does,
say so briefly.`;
}

/**
 * Every prior revision of the seeded inbox-watch section, reconstructed per
 * account. An on-disk section still matching one of these verbatim was never
 * customized and is safe to upgrade in place; anything else belongs to the
 * owner or the agent and is kept forever — the same rule seedGoogleSkill
 * applies to its prior hashes.
 */
function priorInboxWatchSections(account: GoogleAccount): string[] {
  const name = inboxWatchEntryName(account.label);
  // v1: snapshot check — hash of the current unread inbox.
  const v1 = `## ${name}
when: every 5 minutes
agent: email
check: gws -a ${account.label} gmail search "in:inbox is:unread" | sort
New unread mail on the ${account.label} account (${account.email}). Triage it
with gws -a ${account.label}: read what arrived, judge what actually matters
against the owner's interruption budget, and prepare Gmail drafts — never
send — for anything that needs a reply. Your earlier sweeps are the turns
above; dedupe against them. Report only what needs the owner (what landed,
why it matters, which drafts are waiting); if nothing does, say so briefly.`;
  return [v1];
}

/**
 * Upgrade seeded inbox-watch entries whose text is still an unmodified prior
 * revision to the current section. Runs at boot; a customized or renamed
 * entry is never touched, and the scheduler's command-change re-baseline
 * keeps the swap silent. Returns the labels upgraded.
 */
export function upgradeSeededInboxWatches(dataDir: string): string[] {
  const seeds = readInboxSeeds(dataDir);
  const path = schedulePath(dataDir);
  if (!existsSync(path)) return [];
  const accounts = readGoogleAccounts(dataDir).filter((account) =>
    seeds.inboxWatch.includes(account.label),
  );
  if (accounts.length === 0) return [];

  const existing = readFileSync(path, "utf8");
  let candidate = existing;
  const upgraded: string[] = [];
  for (const account of accounts) {
    const sections = candidate.split(/^(?=##\s)/m);
    const index = sections.findIndex((section) =>
      priorInboxWatchSections(account).some((prior) => section.trim() === prior.trim()),
    );
    if (index === -1) continue;
    const trailing = /\s*$/.exec(sections[index]!)?.[0] ?? "\n";
    sections[index] = `${inboxWatchSection(account)}${trailing}`;
    candidate = sections.join("");
    upgraded.push(account.label);
  }
  if (upgraded.length === 0) return [];
  // The current template must not parse worse than what it replaces; on any
  // doubt leave the file alone — the old watcher keeps working.
  if (parseSchedule(candidate).errors.length > parseSchedule(existing).errors.length) {
    return [];
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, candidate);
  renameSync(temporary, path);
  return upgraded;
}

const RUNDOWN_SECTION = `## ${RUNDOWN_ENTRY_NAME}
when: weekdays at 7:30
Build the owner's morning rundown per the proactive-rhythm skill: calendar,
what needs them in email (drafts already waiting, via the email agent's
recent reports and gws), open loops from LOOPS.md. One skimmable message.
[SILENT] if there's truly nothing worth saying.`;

/**
 * Seed the inbox watcher (per account) and the morning rundown (once ever)
 * into SCHEDULE.md. Idempotent and deletion-respecting via the marker file;
 * appends atomically and never introduces new parse errors — on any doubt it
 * leaves the file alone and stays unmarked so a later connect retries.
 */
export function seedInboxJobs(dataDir: string, account: GoogleAccount): void {
  if (!account.scopes.some((scope) => scope.startsWith(GMAIL_SCOPE_PREFIX))) return;
  const seeds = readInboxSeeds(dataDir);
  const wantWatch = !seeds.inboxWatch.includes(account.label);
  const wantRundown = !seeds.rundown;
  if (!wantWatch && !wantRundown) return;

  const path = schedulePath(dataDir);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = scheduleHeadings(existing);
  const sections: string[] = [];
  if (wantWatch && !present.has(inboxWatchEntryName(account.label).toLowerCase())) {
    sections.push(inboxWatchSection(account));
  }
  if (wantRundown && !present.has(RUNDOWN_ENTRY_NAME.toLowerCase())) {
    sections.push(RUNDOWN_SECTION);
  }

  if (sections.length > 0) {
    const candidate = existing.trim()
      ? `${existing.trimEnd()}\n\n${sections.join("\n\n")}\n`
      : `${sections.join("\n\n")}\n`;
    // Pre-existing breakage is already the scheduler's (loud) problem; only a
    // NEW error — which the collision check should have made impossible —
    // aborts, unmarked, so a later connect retries.
    if (parseSchedule(candidate).errors.length > parseSchedule(existing).errors.length) {
      return;
    }
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, candidate);
    renameSync(temporary, path);
  }

  // Name collisions count as seeded too: the owner already has an entry by
  // that name, and re-seeding over it later would be an override.
  writeInboxSeeds(dataDir, {
    rundown: seeds.rundown || wantRundown,
    inboxWatch: wantWatch ? [...seeds.inboxWatch, account.label] : seeds.inboxWatch,
  });
}

/**
 * On disconnect, retire the account's seeded watcher: its check would fail
 * every firing and wake the email agent each time. Only the exact seeded
 * entry is removed (and unmarked, so reconnecting re-seeds); anything the
 * owner renamed or wrote themselves is left alone. The rundown stays — it is
 * not account-scoped.
 */
function removeSeededInboxWatch(dataDir: string, label: string): void {
  const seeds = readInboxSeeds(dataDir);
  if (!seeds.inboxWatch.includes(label)) return;
  const path = schedulePath(dataDir);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const name = inboxWatchEntryName(label);
    const sections = existing.split(/^(?=##\s)/m);
    const kept = sections.filter(
      (section) => !section.match(/^##\s+(.+?)\s*$/m) || section.match(/^##\s+(.+?)\s*$/m)![1] !== name,
    );
    if (kept.length < sections.length) {
      const candidate = `${kept.join("").trimEnd()}\n`.replace(/^\n+$/, "");
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, candidate);
      renameSync(temporary, path);
    }
  }
  writeInboxSeeds(dataDir, {
    rundown: seeds.rundown,
    inboxWatch: seeds.inboxWatch.filter((entry) => entry !== label),
  });
}

// -- helpers ----------------------------------------------------------------

function readCredentialsFile(
  dataDir: string,
  label: string,
): { client_id: string; client_secret: string; refresh_token: string } | undefined {
  const path = googleCredentialsPath(dataDir, label);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    const { client_id, client_secret, refresh_token } = parsed;
    if (
      typeof client_id === "string" &&
      typeof client_secret === "string" &&
      typeof refresh_token === "string"
    ) {
      return { client_id, client_secret, refresh_token };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readRefreshToken(dataDir: string, label: string): string | undefined {
  return readCredentialsFile(dataDir, label)?.refresh_token;
}

function emailFromIdToken(idToken: string): string | undefined {
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (isRecord(decoded) && typeof decoded.email === "string") return decoded.email;
    return undefined;
  } catch {
    return undefined;
  }
}

function describeOAuthError(body: Record<string, unknown>): string {
  const error = typeof body.error === "string" ? body.error : "unknown_error";
  const description = typeof body.error_description === "string" ? ` — ${body.error_description}` : "";
  return `${error}${description}`;
}

function writeSecretFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${content}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function newOAuthState(): string {
  return randomBytes(16).toString("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAccount(value: unknown): value is GoogleAccount {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.email === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    typeof value.connectedAt === "string"
  );
}
