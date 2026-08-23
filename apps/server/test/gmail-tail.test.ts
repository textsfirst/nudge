import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gwsShimDir } from "../src/google.js";

const run = promisify(execFile);
const SCRIPT = join(gwsShimDir(), "gmail-tail.mjs");

// -- fake Gmail API ---------------------------------------------------------

interface FakeMessage {
  labelIds: string[];
  internalDate: string;
  from?: string;
  subject?: string;
}

interface Fake {
  /** Current mailbox historyId, returned by profile and history responses. */
  historyId: string;
  email: string;
  /** messageAdded records returned by every history call. */
  added: { id: string; labelIds: string[] }[];
  messages: Record<string, FakeMessage>;
  historyStatus?: number;
  /** When set, history responses page through this list via pageToken. */
  historyPages?: object[];
  tokenStatus?: number;
  tokenBody?: object;
  requests: string[];
}

function fakeServer(fake: Fake): Promise<Server> {
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    fake.requests.push(`${request.method} ${url}`);
    const json = (status: number, body: object) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url === "/token") {
      json(fake.tokenStatus ?? 200, fake.tokenBody ?? { access_token: "tok-1", expires_in: 3600 });
      return;
    }
    if (url.startsWith("/gmail/v1/users/me/profile")) {
      json(200, { emailAddress: fake.email, historyId: fake.historyId });
      return;
    }
    if (url.startsWith("/gmail/v1/users/me/history")) {
      if (fake.historyStatus) {
        json(fake.historyStatus, { error: { message: "history says no" } });
        return;
      }
      if (fake.historyPages) {
        const token = new URL(url, "http://x").searchParams.get("pageToken");
        json(200, fake.historyPages[token ? Number(token) : 0]!);
        return;
      }
      json(200, {
        historyId: fake.historyId,
        ...(fake.added.length > 0
          ? {
              history: [
                {
                  id: fake.historyId,
                  messagesAdded: fake.added.map((entry) => ({
                    message: { id: entry.id, threadId: entry.id, labelIds: entry.labelIds },
                  })),
                },
              ],
            }
          : {}),
      });
      return;
    }
    const message = /\/gmail\/v1\/users\/me\/messages\/([^?]+)/.exec(url);
    if (message) {
      const found = fake.messages[message[1]!];
      if (!found) {
        json(404, { error: { message: "not found" } });
        return;
      }
      json(200, {
        id: message[1],
        internalDate: found.internalDate,
        labelIds: found.labelIds,
        payload: {
          headers: [
            ...(found.from ? [{ name: "From", value: found.from }] : []),
            ...(found.subject ? [{ name: "Subject", value: found.subject }] : []),
          ],
        },
      });
      return;
    }
    json(500, { error: { message: `unexpected ${url}` } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// -- harness ----------------------------------------------------------------

let root: string | undefined;
let server: Server | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  server?.close();
  server = undefined;
});

function makeGoogleDir(labels: string[]): string {
  root = mkdtempSync(join(tmpdir(), "gmail-tail-"));
  const googleDir = join(root, "google");
  mkdirSync(googleDir, { recursive: true });
  writeFileSync(
    join(googleDir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: labels.map((label) => ({
        label,
        email: `${label}@x.y`,
        scopes: [],
        connectedAt: "2026-01-01",
      })),
    }),
  );
  for (const label of labels) {
    mkdirSync(join(googleDir, label));
    writeFileSync(
      join(googleDir, label, "credentials.json"),
      JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
    );
  }
  return googleDir;
}

async function tail(
  args: string[],
  googleDir: string | undefined,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const port = (server?.address() as AddressInfo | undefined)?.port;
  const base = port !== undefined ? `http://127.0.0.1:${port}` : "http://127.0.0.1:1";
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        ...(googleDir ? { NUDGE_GOOGLE_DIR: googleDir } : {}),
        GMAIL_TAIL_API_BASE: base,
        GMAIL_TAIL_TOKEN_URL: `${base}/token`,
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function newFake(overrides: Partial<Fake> = {}): Fake {
  return {
    historyId: "1000",
    email: "work@x.y",
    added: [],
    messages: {},
    requests: [],
    ...overrides,
  };
}

function state(googleDir: string, label: string): { historyId?: string } {
  return JSON.parse(readFileSync(join(googleDir, label, "inbox-watch.json"), "utf8"));
}

// -- tests ------------------------------------------------------------------

describe("gmail-tail", () => {
  it("refuses to run outside Nudge's bash tool", async () => {
    const result = await tail(["work"], undefined);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("NUDGE_GOOGLE_DIR");
  });

  it("baselines silently on first run, then holds output stable", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);

    const first = await tail(["work"], googleDir);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("[baseline] watching work@x.y");
    expect(state(googleDir, "work").historyId).toBe("1000");

    const second = await tail(["work"], googleDir);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it("journals an arrival once and advances the cursor", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir); // baseline at 1000

    fake.historyId = "1010";
    fake.added = [{ id: "m1", labelIds: ["INBOX", "UNREAD"] }];
    fake.messages.m1 = {
      labelIds: ["INBOX", "UNREAD"],
      internalDate: "1755950000000",
      from: "Jane Doe <jane@x.y>",
      subject: "Q3 numbers",
    };
    const changed = await tail(["work"], googleDir);
    expect(changed.code).toBe(0);
    expect(changed.stdout).toContain("Jane Doe <jane@x.y>");
    expect(changed.stdout).toContain("Q3 numbers");
    expect(state(googleDir, "work").historyId).toBe("1010");
    expect(fake.requests.some((entry) => entry.includes("startHistoryId=1000"))).toBe(true);

    // The same history records coming back (crash before the cursor advanced,
    // or Gmail repeating them) must not duplicate journal lines.
    const again = await tail(["work"], googleDir);
    expect(again.stdout).toBe(changed.stdout);
    const journal = readFileSync(join(googleDir, "work", "inbox-journal.log"), "utf8");
    expect(journal.match(/\tm1\t/g)).toHaveLength(1);
  });

  it("ignores the account's own sent mail and drafts", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    const baseline = await tail(["work"], googleDir);

    fake.historyId = "1010";
    fake.added = [
      { id: "d1", labelIds: ["DRAFT"] },
      { id: "s1", labelIds: ["SENT"] },
    ];
    const after = await tail(["work"], googleDir);
    expect(after.stdout).toBe(baseline.stdout);
    expect(state(googleDir, "work").historyId).toBe("1010");
  });

  it("re-baselines with a [gap] line when Gmail expires the cursor", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir);

    fake.historyStatus = 404;
    fake.historyId = "2000";
    const gapped = await tail(["work"], googleDir);
    expect(gapped.code).toBe(0);
    expect(gapped.stdout).toContain("[gap] Gmail expired the sync cursor");
    expect(state(googleDir, "work").historyId).toBe("2000");
  });

  it("journals a burst in full: detail cap, id-only overflow, visible [burst] marker", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir);

    fake.historyId = "1010";
    fake.added = Array.from({ length: 30 }, (_, index) => ({
      id: `m${index}`,
      labelIds: ["INBOX"],
    }));
    for (const entry of fake.added) {
      fake.messages[entry.id] = {
        labelIds: ["INBOX"],
        internalDate: "1755950000000",
        from: "a@b.c",
        subject: `hello ${entry.id}`,
      };
    }
    const swept = await tail(["work"], googleDir);
    // The marker is the last line, so the count survives even though the
    // sweep is bigger than the printed tail.
    expect(swept.stdout.trimEnd().endsWith(
      "[burst] 30 arrivals this sweep — read google/work/inbox-journal.log for the full list",
    )).toBe(true);
    const journal = readFileSync(join(googleDir, "work", "inbox-journal.log"), "utf8");
    const lines = journal.split("\n");
    // Every arrival is journaled: 20 detailed, 10 id-only.
    expect(lines.filter((line) => line.includes("hello ")).length).toBe(20);
    expect(lines.filter((line) => line.includes("(burst — headers not fetched)")).length).toBe(10);
    for (let index = 0; index < 30; index += 1) {
      expect(journal).toContain(`\tm${index}\t`);
    }

    // A repeat of the same history (crash before the cursor saved) must not
    // re-journal the id-only overflow either.
    const again = await tail(["work"], googleDir);
    expect(again.stdout).toBe(swept.stdout);
  });

  it("skips the [burst] marker when a sweep still fits the tail", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir);

    fake.historyId = "1010";
    fake.added = Array.from({ length: 22 }, (_, index) => ({
      id: `m${index}`,
      labelIds: ["INBOX"],
    }));
    for (const entry of fake.added) {
      fake.messages[entry.id] = {
        labelIds: ["INBOX"],
        internalDate: "1755950000000",
        from: "a@b.c",
        subject: `hello ${entry.id}`,
      };
    }
    const swept = await tail(["work"], googleDir);
    expect(swept.stdout).not.toContain("[burst]");
    expect(swept.stdout).toContain("(burst — headers not fetched)"); // the 2 id-only lines
  });

  it("exits 2 with a reconnect message on dead auth", async () => {
    const fake = newFake({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } });
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    const result = await tail(["work"], googleDir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("reconnect it in the console");
    expect(existsSync(join(googleDir, "work", "inbox-journal.log"))).toBe(false);
  });

  it("surfaces API failures as exit 1, cursor untouched", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir);

    fake.historyStatus = 500;
    const result = await tail(["work"], googleDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("list Gmail history");
    expect(state(googleDir, "work").historyId).toBe("1000");
  });

  it("walks paginated history and stores the final page's cursor", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir);

    fake.historyPages = [
      {
        historyId: "1005",
        nextPageToken: "1",
        history: [{ id: "1002", messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }],
      },
      {
        historyId: "1010",
        history: [{ id: "1008", messagesAdded: [{ message: { id: "m2", labelIds: ["INBOX"] } }] }],
      },
    ];
    for (const id of ["m1", "m2"]) {
      fake.messages[id] = {
        labelIds: ["INBOX"],
        internalDate: "1755950000000",
        from: "a@b.c",
        subject: `page ${id}`,
      };
    }
    const swept = await tail(["work"], googleDir);
    expect(swept.stdout).toContain("page m1");
    expect(swept.stdout).toContain("page m2");
    expect(state(googleDir, "work").historyId).toBe("1010");
  });

  it("journals an arrival hard-deleted before the sweep instead of dropping it", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    await tail(["work"], googleDir);

    fake.historyId = "1010";
    fake.added = [{ id: "gone1", labelIds: ["INBOX"] }]; // no metadata: GET 404s
    const swept = await tail(["work"], googleDir);
    expect(swept.code).toBe(0);
    expect(swept.stdout).toContain("\tgone1\t(deleted before the sweep)");
  });

  it("rejects unknown options and labels outside the registry", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);

    const flagged = await tail(["--tight", "work"], googleDir);
    expect(flagged.code).toBe(3);
    expect(flagged.stderr).toContain('Unknown option "--tight"');

    const traversal = await tail(["../work"], googleDir);
    expect(traversal.code).toBe(3);
    expect(traversal.stderr).toContain('No Google account "../work"');
  });

  it("ignores a configured default that names no connected account", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    const result = await tail([], googleDir, { NUDGE_GOOGLE_DEFAULT_ACCOUNT: "ghost" });
    expect(result.code).toBe(0); // falls through to the single connected account
    expect(result.stdout).toContain("# work inbox arrivals");
  });

  it("resolves the only account without an argument, refuses ambiguity", async () => {
    const fake = newFake();
    server = await fakeServer(fake);
    const googleDir = makeGoogleDir(["work"]);
    const solo = await tail([], googleDir);
    expect(solo.code).toBe(0);

    rmSync(root!, { recursive: true, force: true });
    const both = makeGoogleDir(["work", "personal"]);
    const ambiguous = await tail([], both);
    expect(ambiguous.code).toBe(3);
    expect(ambiguous.stderr).toContain("gmail-tail <label>");
  });
});
