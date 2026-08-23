// gmail-tail — a cursor-based Gmail arrivals journal, built for watcher checks.
//
// Prints the tail of an append-only journal of inbox arrivals for one
// connected account, advancing a persisted Gmail history cursor
// (users.history.list) on every run. The output is monotone: it changes
// exactly when new mail has arrived — never when the owner merely reads or
// archives — so a hash-diffing watcher gate wakes its agent precisely on
// arrivals, and mail handled on another device before the sweep is still
// seen. When Gmail expires the cursor (HTTP 404, typically after a week
// offline), the journal gains a [gap] line and the cursor re-baselines, so
// the wake reports the blind spot instead of hiding it.
//
// Usage: gmail-tail [label]        (label optional with a default or a
//                                   single connected account)
//
// State, invisible to the agent's file tools like the rest of the google
// dir, lives next to the account's gws credentials:
//   <NUDGE_GOOGLE_DIR>/<label>/inbox-watch.json    cursor + token cache
//   <NUDGE_GOOGLE_DIR>/<label>/inbox-journal.log   append-only arrivals
//
// Exit codes mirror gws: 0 ok, 1 API/network error, 2 dead auth (owner must
// reconnect), 3 usage. Dependency-free on purpose — like gws-shim.mjs it
// runs bare from bin/, outside the workspace build.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const EXIT_API = 1;
const EXIT_AUTH = 2;
const EXIT_USAGE = 3;

/** Journal lines printed per run — the watcher brief is capped at ~4k chars. */
const TAIL_LINES = 20;
/** Arrivals detailed (From/Subject fetched) per run; the rest get a [more] line. */
const DETAIL_CAP = 25;
/** Journal rotation: beyond MAX lines, keep the newest KEEP. */
const JOURNAL_MAX_LINES = 400;
const JOURNAL_KEEP_LINES = 200;
/** A lock older than this belongs to a crashed run and is stolen. */
const LOCK_STALE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Arrivals the owner did not receive: their own drafts, sent mail, spam, chat. */
const SKIP_LABELS = new Set(["DRAFT", "SENT", "SPAM", "TRASH", "CHAT"]);

const API_BASE = process.env.GMAIL_TAIL_API_BASE ?? "https://gmail.googleapis.com";
const TOKEN_URL = process.env.GMAIL_TAIL_TOKEN_URL ?? "https://oauth2.googleapis.com/token";

const googleDir = process.env.NUDGE_GOOGLE_DIR;
if (!googleDir) {
  fail(
    "gmail-tail is managed by Nudge and only available inside its bash tool " +
      "(NUDGE_GOOGLE_DIR is unset).",
  );
}

main().catch((error) => {
  fail(`gmail-tail failed: ${error instanceof Error ? error.message : String(error)}`, EXIT_API);
});

async function main() {
  const label = resolveLabel(process.argv.slice(2));
  const accountDir = join(googleDir, label);
  const credentialsPath = join(accountDir, "credentials.json");
  if (!existsSync(credentialsPath)) {
    fail(`No Google account "${label}". Available: ${labels() || "(none)"}.`);
  }
  const journalPath = join(accountDir, "inbox-journal.log");
  const statePath = join(accountDir, "inbox-watch.json");

  const lock = acquireLock(join(accountDir, "inbox-watch.lock"));
  if (!lock) {
    // Another run is mid-sweep; report the current tail — unchanged output
    // is exactly what a concurrent firing should look like.
    printTail(label, journalPath);
    return;
  }
  try {
    await sweep({ label, credentialsPath, statePath, journalPath });
  } finally {
    lock.release();
  }
  printTail(label, journalPath);
}

async function sweep({ label, credentialsPath, statePath, journalPath }) {
  const state = readJson(statePath) ?? {};
  const token = await accessToken(label, credentialsPath, state, statePath);

  if (typeof state.historyId !== "string" || !state.historyId) {
    const profile = await api(token, "/gmail/v1/users/me/profile");
    if (!profile.ok) failApi("read the Gmail profile", profile);
    appendJournal(journalPath, [
      `[baseline] watching ${profile.body.emailAddress ?? label} from ${stamp(Date.now())}`,
    ]);
    saveState(statePath, { ...state, historyId: String(profile.body.historyId) });
    return;
  }

  // Collect everything added since the cursor. History records repeat across
  // pages and reruns (an interrupted sweep advances the journal before the
  // cursor), so arrivals are deduped by id here and against the journal below.
  const added = new Map();
  let nextHistoryId = state.historyId;
  let pageToken;
  do {
    const params = new URLSearchParams({ startHistoryId: state.historyId, maxResults: "500" });
    params.append("historyTypes", "messageAdded");
    if (pageToken) params.set("pageToken", pageToken);
    const page = await api(token, `/gmail/v1/users/me/history?${params.toString()}`);
    if (page.status === 404) {
      // The cursor expired — a blind spot, not an error. Surface it in the
      // journal (which wakes the agent) and start a fresh cursor.
      const profile = await api(token, "/gmail/v1/users/me/profile");
      if (!profile.ok) failApi("re-baseline after an expired cursor", profile);
      appendJournal(journalPath, [
        "[gap] Gmail expired the sync cursor; arrivals since the last line above " +
          "may be missing — sweep the inbox directly to catch up",
      ]);
      saveState(statePath, { ...state, historyId: String(profile.body.historyId) });
      return;
    }
    if (!page.ok) failApi("list Gmail history", page);
    for (const record of page.body.history ?? []) {
      for (const entry of record.messagesAdded ?? []) {
        const message = entry.message;
        if (!message?.id) continue;
        if ((message.labelIds ?? []).some((labelId) => SKIP_LABELS.has(labelId))) continue;
        added.set(message.id, message);
      }
    }
    nextHistoryId = String(page.body.historyId ?? nextHistoryId);
    pageToken = page.body.nextPageToken;
  } while (pageToken);

  const seen = journalIds(journalPath);
  const fresh = [...added.keys()].filter((id) => !seen.has(id));
  const detailed = fresh.slice(0, DETAIL_CAP);
  const lines = [];
  for (const id of detailed) {
    const line = await describeMessage(token, id);
    if (line) lines.push(line);
  }
  lines.sort();
  if (fresh.length > detailed.length) {
    lines.push(
      `[more] ${fresh.length - detailed.length} further arrivals this sweep — list them with gws`,
    );
  }
  appendJournal(journalPath, lines);
  saveState(statePath, { ...state, historyId: nextHistoryId });
}

/** One journal line: "<utc-minute>\t<id>\t<from>\t<subject>", stable once written. */
async function describeMessage(token, id) {
  const params = new URLSearchParams({ format: "metadata" });
  params.append("metadataHeaders", "From");
  params.append("metadataHeaders", "Subject");
  const message = await api(token, `/gmail/v1/users/me/messages/${id}?${params.toString()}`);
  if (message.status === 404) return undefined; // hard-deleted since the sweep began
  if (!message.ok) failApi("read a message's headers", message);
  const headers = message.body.payload?.headers ?? [];
  const header = (name) =>
    headers.find((entry) => entry.name?.toLowerCase() === name)?.value ?? "";
  const from = clean(header("from"), 60) || "(unknown sender)";
  const subject = clean(header("subject"), 100) || "(no subject)";
  return `${stamp(Number(message.body.internalDate) || Date.now())}\t${id}\t${from}\t${subject}`;
}

// -- auth -------------------------------------------------------------------

async function accessToken(label, credentialsPath, state, statePath) {
  const cached = state.token;
  if (cached?.accessToken && typeof cached.expiresAt === "number" && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }
  const credentials = readJson(credentialsPath);
  if (
    typeof credentials?.client_id !== "string" ||
    typeof credentials?.client_secret !== "string" ||
    typeof credentials?.refresh_token !== "string"
  ) {
    fail(`The credentials for "${label}" are unreadable. Tell the owner to reconnect the account in the console (Connections page).`);
  }
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`Could not reach Google's token endpoint: ${error.message}`, EXIT_API);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error === "invalid_grant") {
      fail(
        `[Google auth for "${label}" has expired or been revoked. Do not retry — tell the ` +
          "owner to reconnect it in the console (Connections page).]",
        EXIT_AUTH,
      );
    }
    fail(`Google's token endpoint said no (${response.status}): ${body.error ?? "unknown"}`, EXIT_API);
  }
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    fail("Google's token response had no access token.", EXIT_API);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  state.token = { accessToken, expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000 };
  saveState(statePath, state);
  return accessToken;
}

// -- Gmail API --------------------------------------------------------------

async function api(token, path) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`Could not reach the Gmail API: ${error.message}`, EXIT_API);
  }
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function failApi(what, response) {
  const message = response.body?.error?.message ?? "no detail";
  fail(`The Gmail API refused to ${what} (${response.status}): ${message}`, EXIT_API);
}

// -- journal + state --------------------------------------------------------

function journalLines(journalPath) {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
}

/** Ids already journaled — field two of every non-marker line. */
function journalIds(journalPath) {
  const ids = new Set();
  for (const line of journalLines(journalPath)) {
    const id = line.split("\t")[1];
    if (id) ids.add(id);
  }
  return ids;
}

function appendJournal(journalPath, lines) {
  if (lines.length === 0) return;
  appendFileSync(journalPath, `${lines.join("\n")}\n`);
  const all = journalLines(journalPath);
  if (all.length > JOURNAL_MAX_LINES) {
    const kept = all.slice(-JOURNAL_KEEP_LINES);
    const temporary = `${journalPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${kept.join("\n")}\n`);
    renameSync(temporary, journalPath);
  }
}

function printTail(label, journalPath) {
  const lines = journalLines(journalPath);
  const tail = lines.slice(-TAIL_LINES);
  process.stdout.write(
    `# ${label} inbox arrivals — newest last; full journal: google/${label}/inbox-journal.log\n` +
      (tail.length > 0 ? `${tail.join("\n")}\n` : ""),
  );
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Atomic, owner-only: the state file caches an access token. */
function saveState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
}

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath);
      return { release: () => rmdirSync(lockPath, { recursive: false }) };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockPath, { recursive: false });
          continue;
        }
      } catch {
        continue; // the holder finished between our attempts — try again
      }
      return undefined;
    }
  }
  return undefined;
}

// -- helpers ----------------------------------------------------------------

function resolveLabel(argv) {
  const positional = argv.filter((argument) => !argument.startsWith("-"));
  if (positional.length > 1) fail("Usage: gmail-tail [label]");
  if (positional[0]) return positional[0];
  const fallback = process.env.NUDGE_GOOGLE_DEFAULT_ACCOUNT;
  if (fallback) return fallback;
  const accounts = readAccounts();
  if (accounts.length === 1) return accounts[0].label;
  fail(
    accounts.length === 0
      ? "No Google accounts are connected yet. Tell the owner to connect one in the console (Connections page)."
      : `Multiple Google accounts are connected — name one: gmail-tail <label>. Available: ${labels()}.`,
  );
}

function readAccounts() {
  const parsed = readJson(join(googleDir, "accounts.json"));
  return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
}

function labels() {
  return readAccounts()
    .map((account) => `${account.label} (${account.email})`)
    .join(", ");
}

/** UTC to the minute — sortable, and stable once a line is written. */
function stamp(epochMs) {
  return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

function clean(value, max) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
