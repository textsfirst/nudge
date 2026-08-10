import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { NudgeStore } from "../src/store.js";

const HANDLE = "+15551234567";

describe("NudgeStore", () => {
  it("creates, touches, and ends sessions", () => {
    const store = new NudgeStore(":memory:");
    expect(store.activeSession(HANDLE)).toBeUndefined();

    const session = store.startSession(HANDLE, 1_000, "yesterday we planned a trip");
    expect(session.carryover).toBe("yesterday we planned a trip");
    expect(store.activeSession(HANDLE)?.id).toBe(session.id);

    store.touchSession(session.id, 2_000);
    expect(store.activeSession(HANDLE)?.lastActivityAt).toBe(2_000);

    store.endSession(session.id, "midnight", 3_000);
    expect(store.activeSession(HANDLE)).toBeUndefined();
  });

  it("stores messages and finds them with full-text search", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE);
    store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "user",
      content: "remind me about the dentist appointment",
    });
    store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "assistant",
      content: "Will do — dentist on Thursday.",
    });

    expect(store.sessionMessages(session.id)).toHaveLength(2);
    const hits = store.searchMessages("dentist");
    expect(hits.length).toBe(2);
    expect(store.searchMessages('nonexistent"term -- injection')).toEqual([]);
  });

  it("tracks live turn progress and clears it when the session settles", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE, 1_000);
    expect(store.turnProgress(session.id)).toBeUndefined();

    store.setTurnProgress(session.id, HANDLE, "[]", 1_000);
    store.setTurnProgress(session.id, HANDLE, '[{"tool":"bash"}]', 2_000);
    expect(store.turnProgress(session.id)).toEqual({
      sessionId: session.id,
      handle: HANDLE,
      startedAt: 1_000,
      updatedAt: 2_000,
      steps: '[{"tool":"bash"}]',
    });

    store.clearTurnProgress(session.id);
    expect(store.turnProgress(session.id)).toBeUndefined();

    store.setTurnProgress(session.id, HANDLE, "[]", 3_000);
    store.endSession(session.id, "idle", 4_000);
    expect(store.turnProgress(session.id)).toBeUndefined();

    const next = store.startSession(HANDLE, 5_000);
    store.setTurnProgress(next.id, HANDLE, "[]", 5_000);
    store.deleteSession(next.id);
    expect(store.turnProgress(next.id)).toBeUndefined();
  });

  it("limits session messages to those after a compaction point", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE);
    const first = store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "user",
      content: "old",
    });
    store.appendMessage({ sessionId: session.id, handle: HANDLE, role: "assistant", content: "new" });
    store.setCompaction(session.id, "summary of old turns", first.id);

    const active = store.activeSession(HANDLE);
    expect(active?.summary).toBe("summary of old turns");
    expect(store.sessionMessages(session.id, active?.compactedThrough)).toHaveLength(1);
  });

  it("remembers the latest space per handle", () => {
    const store = new NudgeStore(":memory:");
    store.rememberSpace(HANDLE, "space-1", "imessage", 1);
    store.rememberSpace(HANDLE, "space-2", "imessage", 2);
    expect(store.spaceFor(HANDLE)?.spaceId).toBe("space-2");
    expect(store.spaceFor("unknown")).toBeUndefined();
  });

  it("claims schedule runs exclusively and releases stale claims", () => {
    const store = new NudgeStore(":memory:");
    expect(store.claimScheduleRun("entry-1", 1_000)).toBe(true);
    expect(store.claimScheduleRun("entry-1", 2_000)).toBe(false);

    store.finishScheduleRun("entry-1", 2_500);
    expect(store.scheduleState("entry-1").lastRunAt).toBe(2_500);
    expect(store.claimScheduleRun("entry-1", 3_000)).toBe(true);

    // A crashed claim becomes claimable again after the stale window.
    expect(store.claimScheduleRun("entry-2", 10_000)).toBe(true);
    expect(store.claimScheduleRun("entry-2", 10_000 + 11 * 60 * 1000)).toBe(true);
  });

  it("sets a schedule baseline only once", () => {
    const store = new NudgeStore(":memory:");
    store.ensureScheduleBaseline("entry-1", 5_000);
    store.ensureScheduleBaseline("entry-1", 9_000);
    expect(store.scheduleState("entry-1").lastRunAt).toBe(5_000);
  });

  it("marks one-shot entries completed", () => {
    const store = new NudgeStore(":memory:");
    store.claimScheduleRun("once-1");
    store.finishScheduleRun("once-1", Date.now(), true);
    expect(store.scheduleState("once-1").completed).toBe(true);
    expect(store.claimScheduleRun("once-1")).toBe(false);
  });

  it("tracks outbound deliveries through the ledger", () => {
    const store = new NudgeStore(":memory:");
    const id = store.enqueueOutbound(HANDLE, "hello", "reply", 1_000);
    expect(store.openOutbound(86_400_000, 3, 2_000)).toHaveLength(1);

    store.markOutbound(id, "sending", 2_000);
    expect(store.openOutbound(86_400_000, 3, 2_000)[0]?.attempts).toBe(1);

    store.markOutbound(id, "sent", 3_000);
    expect(store.openOutbound(86_400_000, 3, 4_000)).toHaveLength(0);

    // Age and attempt limits exclude entries.
    const stale = store.enqueueOutbound(HANDLE, "old", "nudge", 1_000);
    expect(store.openOutbound(1_000, 3, 1_000_000_000)).toHaveLength(0);
    store.markOutbound(stale, "sending");
    store.markOutbound(stale, "sending");
    store.markOutbound(stale, "sending");
    expect(store.openOutbound(86_400_000 * 365, 3)).toHaveLength(0);
  });

  it("deduplicates webhook deliveries durably", () => {
    const store = new NudgeStore(":memory:");
    expect(store.isWebhookProcessed("m1")).toBe(false);
    store.markWebhookProcessed("m1");
    expect(store.isWebhookProcessed("m1")).toBe(true);
    store.markWebhookProcessed("m1");
  });

  it("bounds webhook and outbound bookkeeping", () => {
    const store = new NudgeStore(":memory:");
    store.markWebhookProcessed("old", 1_000);
    store.markWebhookProcessed("recent", 9_500);
    const sent = store.enqueueOutbound(HANDLE, "sent", "reply", 1_000);
    store.markOutbound(sent, "sent", 1_500);
    store.enqueueOutbound(HANDLE, "expired", "nudge", 1_000);
    store.enqueueOutbound(HANDLE, "fresh", "nudge", 9_500);

    expect(
      store.maintain({
        now: 10_000,
        webhookRetentionMs: 1_000,
        outboundRetentionMs: 1_000,
        outboundMaxAgeMs: 1_000,
      }),
    ).toEqual({ expiredOutbound: 1, prunedOutbound: 1, prunedWebhooks: 1 });
    expect(store.isWebhookProcessed("old")).toBe(false);
    expect(store.isWebhookProcessed("recent")).toBe(true);
    expect(store.openOutbound(1_000, 3, 10_000).map((entry) => entry.body)).toEqual(["fresh"]);
  });

  it("migrates and prunes schedule state", () => {
    const store = new NudgeStore(":memory:");
    store.ensureScheduleBaseline("legacy", 1_000);
    store.finishScheduleRun("legacy", 2_000, true);
    store.ensureScheduleBaseline("orphan", 1_000);

    store.migrateScheduleState("legacy", "stable");
    expect(store.scheduleState("stable")).toMatchObject({ lastRunAt: 2_000, completed: true });
    expect(store.scheduleState("legacy")).toMatchObject({ lastRunAt: null, completed: false });
    expect(store.pruneScheduleState(["stable"])).toBe(1);
  });

  it("adopts a pre-versioned database and rebuilds FTS for existing messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-store-migration-"));
    const path = join(dir, "legacy.db");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          handle TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          ended_at INTEGER,
          end_reason TEXT,
          summary TEXT,
          carryover TEXT,
          compacted_through INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          handle TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_payload TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO sessions (handle, started_at, last_activity_at)
          VALUES ('${HANDLE}', 1, 1);
        INSERT INTO messages (session_id, handle, role, content, created_at)
          VALUES (1, '${HANDLE}', 'user', 'legacy searchable message', 1);
      `);
      legacy.close();

      const store = new NudgeStore(path);
      expect(store.searchMessages("searchable")).toHaveLength(1);
      store.close();

      const upgraded = new DatabaseSync(path);
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces the settings override set wholesale", () => {
    const store = new NudgeStore(":memory:");
    expect(store.settingsOverrides()).toEqual({});

    store.replaceSettingsOverrides({
      owner_handle: "+15551234567",
      "threads.idle_hours": 2,
      "model.fast_mode": true,
    });
    expect(store.settingsOverrides()).toEqual({
      owner_handle: "+15551234567",
      "threads.idle_hours": 2,
      "model.fast_mode": true,
    });

    store.replaceSettingsOverrides({ owner_handle: "+15551234567" });
    expect(store.settingsOverrides()).toEqual({ owner_handle: "+15551234567" });
  });

  it("refuses a database created by a newer schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-store-future-"));
    const path = join(dir, "future.db");
    try {
      const future = new DatabaseSync(path);
      future.exec("PRAGMA user_version = 999");
      future.close();
      expect(() => new NudgeStore(path)).toThrow(/newer than this Nudge build supports/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists sessions newest-first with counts and previews", () => {
    const store = new NudgeStore(":memory:");
    const first = store.startSession(HANDLE, 1_000);
    store.appendMessage({ sessionId: first.id, handle: HANDLE, role: "user", content: "hello" });
    store.appendMessage({ sessionId: first.id, handle: HANDLE, role: "assistant", content: "hi!" });
    store.endSession(first.id, "midnight", 2_000);
    const second = store.startSession(HANDLE, 3_000);

    const { sessions, total } = store.listSessions();
    expect(total).toBe(2);
    expect(sessions.map((session) => session.id)).toEqual([second.id, first.id]);
    expect(sessions[1]?.messageCount).toBe(2);
    expect(sessions[1]?.preview).toBe("hi!");
    expect(sessions[0]?.messageCount).toBe(0);
    expect(sessions[0]?.preview).toBeNull();

    const paged = store.listSessions({ limit: 1, offset: 1 });
    expect(paged.sessions.map((session) => session.id)).toEqual([first.id]);
    expect(paged.total).toBe(2);
  });

  it("deletes messages and whole sessions, pruning the search index", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE, 1_000);
    const kept = store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "user",
      content: "keep the dentist note",
    });
    const dropped = store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "assistant",
      content: "delete this embarrassing reply",
    });

    expect(store.deleteMessage(dropped.id)).toBe(true);
    expect(store.deleteMessage(dropped.id)).toBe(false);
    expect(store.sessionMessages(session.id).map((message) => message.id)).toEqual([kept.id]);
    expect(store.searchMessages("embarrassing")).toHaveLength(0);

    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.sessionById(session.id)).toBeUndefined();
    expect(store.searchMessages("dentist")).toHaveLength(0);
    expect(store.listSessions().total).toBe(0);
  });
});
