import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSchedule } from "@nudge/schedule";
import {
  inboxWatchEntryName,
  removeGoogleAccount,
  saveGoogleAccount,
  seedInboxJobs,
} from "../src/google.js";
import type { GoogleAccount } from "../src/google.js";

const CLIENT = { clientId: "id-123.apps.googleusercontent.com", clientSecret: "s3cret" };
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";

let dataDir: string | undefined;

function makeDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), "inbox-seed-"));
  return dataDir;
}

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

function account(label: string, email: string, scopes: string[]): GoogleAccount {
  return { label, email, scopes, connectedAt: "2026-08-17T00:00:00.000Z" };
}

function schedule(dir: string): string {
  return readFileSync(join(dir, "SCHEDULE.md"), "utf8");
}

function seedsFile(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "google", "seeds.json"), "utf8"));
}

describe("seedInboxJobs", () => {
  it("seeds a watcher and the rundown on a gmail-scoped account", () => {
    const dir = makeDataDir();
    seedInboxJobs(dir, account("work", "w@corp.com", [GMAIL_MODIFY]));

    const { entries, errors } = parseSchedule(schedule(dir));
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);

    const watch = entries.find((entry) => entry.name === "Inbox watch (work)");
    expect(watch?.agent).toBe("email");
    expect(watch?.check).toContain('gws -a work gmail search "is:unread newer_than:1d"');
    expect(watch?.check).toContain("| sort");
    expect(watch?.when).toEqual({ kind: "cron", pattern: "*/5 * * * *" });
    expect(watch?.prompt).toContain("w@corp.com");
    expect(watch?.prompt).toContain("never\nsend");

    const rundown = entries.find((entry) => entry.name === "Morning rundown");
    expect(rundown?.agent).toBeNull();
    expect(rundown?.when).toEqual({ kind: "cron", pattern: "30 7 * * 1-5" });
    expect(rundown?.prompt).toContain("open loops from LOOPS.md");
    expect(rundown?.prompt).toContain("[SILENT]");

    expect(seedsFile(dir)).toEqual({ version: 1, rundown: true, inboxWatch: ["work"] });
  });

  it("seeds for read-only gmail too, but not for accounts without gmail", () => {
    const dir = makeDataDir();
    seedInboxJobs(dir, account("cal", "c@x.y", [CALENDAR]));
    expect(existsSync(join(dir, "SCHEDULE.md"))).toBe(false);
    expect(existsSync(join(dir, "google", "seeds.json"))).toBe(false);

    seedInboxJobs(dir, account("ro", "r@x.y", [GMAIL_READONLY]));
    expect(parseSchedule(schedule(dir)).entries.map((entry) => entry.name)).toEqual([
      "Inbox watch (ro)",
      "Morning rundown",
    ]);
  });

  it("appends a second watcher for a second account, rundown stays single", () => {
    const dir = makeDataDir();
    seedInboxJobs(dir, account("work", "w@corp.com", [GMAIL_MODIFY]));
    seedInboxJobs(dir, account("personal", "p@gmail.com", [GMAIL_MODIFY]));

    const { entries, errors } = parseSchedule(schedule(dir));
    expect(errors).toEqual([]);
    expect(entries.map((entry) => entry.name)).toEqual([
      "Inbox watch (work)",
      "Morning rundown",
      "Inbox watch (personal)",
    ]);
    expect(seedsFile(dir)).toEqual({
      version: 1,
      rundown: true,
      inboxWatch: ["work", "personal"],
    });
  });

  it("never re-seeds what the owner deleted", () => {
    const dir = makeDataDir();
    const work = account("work", "w@corp.com", [GMAIL_MODIFY]);
    seedInboxJobs(dir, work);
    writeFileSync(join(dir, "SCHEDULE.md"), "");
    seedInboxJobs(dir, work);
    expect(schedule(dir)).toBe("");
  });

  it("is idempotent for the same account", () => {
    const dir = makeDataDir();
    const work = account("work", "w@corp.com", [GMAIL_MODIFY]);
    seedInboxJobs(dir, work);
    const first = schedule(dir);
    seedInboxJobs(dir, work);
    expect(schedule(dir)).toBe(first);
  });

  it("skips colliding names but marks them seeded", () => {
    const dir = makeDataDir();
    writeFileSync(
      join(dir, "SCHEDULE.md"),
      "## Morning rundown\nwhen: every day at 6:00\nthe owner's own rundown\n",
    );
    seedInboxJobs(dir, account("work", "w@corp.com", [GMAIL_MODIFY]));

    const { entries, errors } = parseSchedule(schedule(dir));
    expect(errors).toEqual([]);
    const rundowns = entries.filter((entry) => entry.name === "Morning rundown");
    expect(rundowns).toHaveLength(1);
    expect(rundowns[0]?.when).toEqual({ kind: "cron", pattern: "0 6 * * *" });
    expect(entries.some((entry) => entry.name === "Inbox watch (work)")).toBe(true);
    expect(seedsFile(dir)).toEqual({ version: 1, rundown: true, inboxWatch: ["work"] });
  });

  it("still seeds around pre-existing broken sections without adding errors", () => {
    const dir = makeDataDir();
    writeFileSync(join(dir, "SCHEDULE.md"), "## Broken entry\nno when line here\n");
    const before = parseSchedule(readFileSync(join(dir, "SCHEDULE.md"), "utf8")).errors.length;
    seedInboxJobs(dir, account("work", "w@corp.com", [GMAIL_MODIFY]));

    const parsed = parseSchedule(schedule(dir));
    expect(parsed.errors).toHaveLength(before);
    expect(parsed.entries.map((entry) => entry.name)).toEqual([
      "Inbox watch (work)",
      "Morning rundown",
    ]);
  });

  it("runs as part of saveGoogleAccount", () => {
    const dir = makeDataDir();
    saveGoogleAccount(dir, {
      label: "work",
      client: CLIENT,
      tokens: {
        refreshToken: "refresh-1",
        email: "w@corp.com",
        grantedScopes: ["openid", GMAIL_MODIFY],
      },
    });
    expect(parseSchedule(schedule(dir)).entries.map((entry) => entry.name)).toEqual([
      "Inbox watch (work)",
      "Morning rundown",
    ]);
  });
});

describe("disconnect cleanup", () => {
  const okFetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch;

  it("removes the seeded watcher and unmarks the label on disconnect", async () => {
    const dir = makeDataDir();
    saveGoogleAccount(dir, {
      label: "work",
      client: CLIENT,
      tokens: { refreshToken: "r1", email: "w@corp.com", grantedScopes: [GMAIL_MODIFY] },
    });
    await removeGoogleAccount(dir, "work", okFetch);

    const { entries, errors } = parseSchedule(schedule(dir));
    expect(errors).toEqual([]);
    expect(entries.map((entry) => entry.name)).toEqual(["Morning rundown"]);
    expect(seedsFile(dir)).toEqual({ version: 1, rundown: true, inboxWatch: [] });
  });

  it("leaves an owner-renamed entry alone and still unmarks", async () => {
    const dir = makeDataDir();
    saveGoogleAccount(dir, {
      label: "work",
      client: CLIENT,
      tokens: { refreshToken: "r1", email: "w@corp.com", grantedScopes: [GMAIL_MODIFY] },
    });
    const renamed = schedule(dir).replace(
      `## ${inboxWatchEntryName("work")}`,
      "## My inbox watch",
    );
    writeFileSync(join(dir, "SCHEDULE.md"), renamed);
    await removeGoogleAccount(dir, "work", okFetch);

    expect(schedule(dir)).toContain("## My inbox watch");
    expect(seedsFile(dir)).toEqual({ version: 1, rundown: true, inboxWatch: [] });
  });
});
