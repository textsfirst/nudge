// Multi-account front for the gws CLI, used by Nudge's agent through bash.
//
// gws stores one credential set per config dir, so Nudge keeps one dir per
// account under DATA_DIR/google/<label>/ and this shim selects it per call:
//
//   gws -a work gmail +triage        (or GWS_ACCOUNT=work gws ...)
//   gws accounts                     connected accounts as JSON
//
// Auth is owner-managed in the console; `gws auth ...` is refused here.
// Dependency-free on purpose — it runs bare, outside the workspace build.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const EXIT_AUTH = 2; // gws: credentials missing, expired, or invalid
const EXIT_USAGE = 3; // gws: validation error — reused for shim diagnostics

const googleDir = process.env.NUDGE_GOOGLE_DIR;
if (!googleDir) {
  fail("gws is managed by Nudge and only available inside its bash tool (NUDGE_GOOGLE_DIR is unset).");
}

const accounts = readAccounts(join(googleDir, "accounts.json"));
const { account, command } = parseArguments(process.argv.slice(2));

if (command[0] === "accounts") {
  process.stdout.write(
    `${JSON.stringify(
      accounts.map((entry) => ({
        label: entry.label,
        email: entry.email,
        scopes: entry.scopes,
        default: entry.label === defaultLabel(),
      })),
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (command[0] === "auth") {
  fail(
    "Google auth is managed by the owner, not you. If an account is missing or expired, " +
      "tell the owner to open the console (Connections page).",
  );
}

// Outbound mail is drafts-first: Gmail send commands only work in turns Nudge
// marks with NUDGE_GWS_SEND=1 (the assistant's own conversation, where the
// owner's approval lives). Everything else — background agents, scheduled
// runs, watcher checks — can only prepare drafts. Gated before account and
// binary resolution so the refusal fires no matter what.
if (
  command[0] === "gmail" &&
  isSendInvocation(command.slice(1)) &&
  process.env.NUDGE_GWS_SEND !== "1"
) {
  fail(
    "Sending email is reserved for the assistant in the owner's conversation, after the owner " +
      "has approved the exact message. Prepare a Gmail draft instead (see the google-workspace " +
      "skill — gws gmail users drafts create) and report the draft id; the assistant sends " +
      "that draft once the owner says yes.",
  );
}

if (accounts.length === 0) {
  fail(
    "No Google accounts are connected yet. Tell the owner to connect one in the console " +
      "(Connections page).",
  );
}

const label = account ?? defaultLabel() ?? (accounts.length === 1 ? accounts[0].label : undefined);
if (!label) {
  fail(
    `Multiple Google accounts are connected — pick one with -a <account>. Available: ${labels()}.`,
  );
}
const selected = accounts.find((entry) => entry.label === label);
const credentialsFile = join(googleDir, label, "credentials.json");
if (!selected || !existsSync(credentialsFile)) {
  fail(`No Google account "${label}". Available: ${labels() || "(none)"}.`);
}

const binary = findRealGws();
if (!binary) {
  fail(
    "The gws CLI is not installed on this machine. Tell the owner: install it with " +
      "`brew install googleworkspace-cli` (or `npm i -g @googleworkspace/cli`), or set " +
      "google.gws_path in nudge.config.yaml.",
    127,
  );
}

const child = spawn(binary, command, {
  stdio: "inherit",
  env: {
    ...process.env,
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: credentialsFile,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: join(googleDir, label),
  },
});
child.on("error", (error) => fail(`Could not run gws: ${error.message}`, 127));
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  if (code === EXIT_AUTH) {
    process.stderr.write(
      `\n[Google auth for "${label}" has expired or been revoked. Do not retry — tell the ` +
        "owner to reconnect it in the console (Connections page).]\n",
    );
  }
  process.exit(code ?? 1);
});

// -- helpers ----------------------------------------------------------------

function parseArguments(argv) {
  let account;
  const command = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-a" || argument === "--account") {
      account = argv[index + 1];
      if (account === undefined) fail("-a needs an account label.");
      index += 1;
    } else if (argument.startsWith("--account=")) {
      account = argument.slice("--account=".length);
    } else {
      command.push(argument);
    }
  }
  return { account: account ?? process.env.GWS_ACCOUNT, command };
}

/**
 * Does this gmail invocation send mail? Rule of record:
 * - Only the command path is inspected: the leading tokens up to the first
 *   `-`-prefixed argument. Flags and their values (--params JSON, quoted
 *   search queries) can legitimately contain the word "send" and are never
 *   looked at.
 * - Helper form: +send, +reply, +forward as the first path token.
 * - Raw method form: the path ends in exactly `send` AND names a sending
 *   resource (`messages` or `drafts`) — covers `users messages send` and
 *   `users drafts send`, while `gmail search send` (a stray query term)
 *   passes because no resource token is present.
 * Drafts creation (`users drafts create`) always passes: that IS the
 * drafts-first workflow.
 */
function isSendInvocation(rest) {
  const flagIndex = rest.findIndex((token) => token.startsWith("-"));
  const path = flagIndex === -1 ? rest : rest.slice(0, flagIndex);
  if (path.length === 0) return false;
  if (["+send", "+reply", "+forward"].includes(path[0])) return true;
  return (
    path[path.length - 1] === "send" &&
    (path.includes("messages") || path.includes("drafts"))
  );
}

function readAccounts(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

function defaultLabel() {
  const configured = process.env.NUDGE_GOOGLE_DEFAULT_ACCOUNT;
  return configured && accounts.some((entry) => entry.label === configured)
    ? configured
    : undefined;
}

function labels() {
  return accounts.map((entry) => `${entry.label} (${entry.email})`).join(", ");
}

function findRealGws() {
  const explicit = process.env.GWS_BINARY;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const shimDir = dirname(fileURLToPath(import.meta.url));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === shimDir) continue;
    const candidate = join(dir, "gws");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
