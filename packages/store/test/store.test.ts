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

  it("tracks watcher check health on schedule state", () => {
    const store = new NudgeStore(":memory:");
    const blank = store.scheduleState("watch-1");
    expect(blank).toMatchObject({ lastCheckHash: null, checksRun: 0, wakes: 0 });

    // Baseline: hash recorded, nobody woken.
    store.recordScheduleCheck("watch-1", { hash: "aaa" }, 1_000);
    expect(store.scheduleState("watch-1")).toMatchObject({
      lastCheckHash: "aaa",
      lastCheckAt: 1_000,
      lastChangeAt: null,
      checksRun: 1,
      wakes: 0,
      lastCheckError: null,
    });

    // A change wakes and moves the change timestamp.
    store.recordScheduleCheck("watch-1", { hash: "bbb", changed: true, woke: true }, 2_000);
    expect(store.scheduleState("watch-1")).toMatchObject({
      lastCheckHash: "bbb",
      lastChangeAt: 2_000,
      checksRun: 2,
      wakes: 1,
    });

    // A failure keeps the last good hash and records the error…
    store.recordScheduleCheck("watch-1", { error: "exit 6: dns", woke: true }, 3_000);
    expect(store.scheduleState("watch-1")).toMatchObject({
      lastCheckHash: "bbb",
      lastCheckError: "exit 6: dns",
      checksRun: 3,
      wakes: 2,
    });

    // …and the next success clears it.
    store.recordScheduleCheck("watch-1", { hash: "bbb" }, 4_000);
    expect(store.scheduleState("watch-1")).toMatchObject({
      lastCheckError: null,
      checksRun: 4,
      wakes: 2,
    });
  });

  it("creates, finds, and archives execution agents", () => {
    const store = new NudgeStore(":memory:");
    const email = store.createAgent({
      handle: HANDLE,
      name: "email",
      kind: "standing",
      description: "owner's gmail",
      at: 1_000,
    });
    expect(store.agentById(email.id)).toMatchObject({ name: "email", status: "active" });
    expect(store.findAgentByName(HANDLE, "EMAIL")?.id).toBe(email.id);

    const temp = store.createAgent({
      handle: HANDLE,
      name: "find-receipt",
      kind: "temp",
      description: "hunting a receipt",
      at: 2_000,
    });
    expect(store.listAgents(HANDLE).map((agent) => agent.name)).toEqual([
      "find-receipt",
      "email",
    ]);

    // A done temp never matches dispatch lookup; the name is free again.
    store.setAgentStatus(temp.id, "done", 3_000);
    expect(store.findAgentByName(HANDLE, "find-receipt")).toBeUndefined();
    expect(store.listAgents(HANDLE).map((agent) => agent.name)).toEqual(["email"]);

    // Dormant standing agents leave the roster but stay dispatchable.
    const swept = store.archiveDormantAgents(HANDLE, 1_000, 10_000);
    expect(swept).toBe(1);
    expect(store.listAgents(HANDLE)).toEqual([]);
    expect(store.findAgentByName(HANDLE, "email")?.status).toBe("archived");
  });

  it("keeps execution-agent sessions out of the owner conversation", () => {
    const store = new NudgeStore(":memory:");
    const agent = store.createAgent({
      handle: HANDLE,
      name: "email",
      kind: "standing",
      description: "",
      at: 1_000,
    });
    const owner = store.startSession(HANDLE, 1_000);
    const worker = store.startSession(HANDLE, 2_000, undefined, agent.id);

    expect(worker.agentId).toBe(agent.id);
    expect(owner.agentId).toBeNull();
    expect(store.activeSession(HANDLE)?.id).toBe(owner.id);
    expect(store.activeAgentSession(agent.id)?.id).toBe(worker.id);
    expect(store.sessionById(worker.id)?.agentId).toBe(agent.id);
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

  it("round-trips per-message token usage and turn metrics", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE);
    store.appendMessage({ sessionId: session.id, handle: HANDLE, role: "user", content: "hi" });
    const reply = store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "assistant",
      content: "hello",
      inputTokens: 1_234,
      outputTokens: 56,
      metrics: '{"ttftMs":420,"modelId":"gpt-5-mini"}',
    });
    expect(reply).toMatchObject({
      inputTokens: 1_234,
      outputTokens: 56,
      metrics: '{"ttftMs":420,"modelId":"gpt-5-mini"}',
    });

    const [user, assistant] = store.sessionMessages(session.id);
    expect(user).toMatchObject({ inputTokens: null, outputTokens: null, metrics: null });
    expect(assistant).toMatchObject({
      inputTokens: 1_234,
      outputTokens: 56,
      metrics: '{"ttftMs":420,"modelId":"gpt-5-mini"}',
    });
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

  it("keeps bubble-level delivery progress across retries", () => {
    const store = new NudgeStore(":memory:");
    const id = store.enqueueOutbound(HANDLE, "one\n\ntwo\n\nthree", "reply", 1_000);
    expect(store.openOutbound(86_400_000, 3, 2_000)[0]?.sentChunks).toBe(0);

    store.markOutbound(id, "sending", 2_000);
    store.markOutboundProgress(id, 2, 2_500);
    // A new attempt does not reset what already landed.
    store.markOutbound(id, "sending", 3_000);
    expect(store.openOutbound(86_400_000, 3, 4_000)[0]?.sentChunks).toBe(2);
  });

  it("deduplicates inbound deliveries durably", () => {
    const store = new NudgeStore(":memory:");
    expect(store.isMessageProcessed("m1")).toBe(false);
    store.markMessageProcessed("m1");
    expect(store.isMessageProcessed("m1")).toBe(true);
    store.markMessageProcessed("m1");
  });

  it("bounds inbound-dedupe and outbound bookkeeping", () => {
    const store = new NudgeStore(":memory:");
    store.markMessageProcessed("old", 1_000);
    store.markMessageProcessed("recent", 9_500);
    const sent = store.enqueueOutbound(HANDLE, "sent", "reply", 1_000);
    store.markOutbound(sent, "sent", 1_500);
    store.enqueueOutbound(HANDLE, "expired", "nudge", 1_000);
    store.enqueueOutbound(HANDLE, "fresh", "nudge", 9_500);

    expect(
      store.maintain({
        now: 10_000,
        messageRetentionMs: 1_000,
        outboundRetentionMs: 1_000,
        outboundMaxAgeMs: 1_000,
      }),
    ).toEqual({ expiredOutbound: 1, prunedOutbound: 1, prunedMessages: 1 });
    expect(store.isMessageProcessed("old")).toBe(false);
    expect(store.isMessageProcessed("recent")).toBe(true);
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
      // The token-usage and metrics migrations backfill legacy rows as null.
      expect(store.sessionMessages(1)[0]).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        metrics: null,
      });
      store.close();

      const upgraded = new DatabaseSync(path);
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 10 });
      // The dedupe table exists under its post-rename name only.
      expect(
        upgraded
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('processed_webhooks', 'processed_messages')")
          .all(),
      ).toEqual([{ name: "processed_messages" }]);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores attachments unlinked, links them, and counts images per message", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE);

    const image = store.insertAttachment({
      handle: HANDLE,
      sourceMessageId: "wh-1",
      kind: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      path: "attachments/abc123.jpg",
      visionEligible: true,
      at: 1_000,
    });
    const failed = store.insertAttachment({
      handle: HANDLE,
      kind: "voice",
      name: "voice-memo.caf",
      mimeType: "audio/x-caf",
      sizeBytes: 0,
      status: "failed",
      at: 1_001,
    });
    expect(image.messageId).toBeNull();
    expect(store.attachmentById(image.id)).toMatchObject({
      kind: "image",
      path: "attachments/abc123.jpg",
      visionEligible: true,
      status: "stored",
    });
    expect(store.attachmentById(failed.id)).toMatchObject({
      kind: "voice",
      path: null,
      status: "failed",
      visionEligible: false,
    });

    const message = store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "user",
      content: '[image "photo.jpg"] [voice memo — transcription unavailable]',
    });
    store.linkAttachments([image.id, failed.id], message.id);

    expect(store.messageAttachments(message.id).map((a) => a.id)).toEqual([image.id, failed.id]);
    expect(store.attachmentById(image.id)?.messageId).toBe(message.id);

    // Only linked, vision-eligible images count toward the message aggregate.
    const rows = store.sessionMessages(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.imageCount).toBe(1);

    const grouped = store.attachmentsForSession(session.id);
    expect(grouped.get(message.id)?.map((a) => a.id)).toEqual([image.id, failed.id]);

    store.setCompaction(session.id, "Owner mentioned a vault code.", message.id);
    // Deleting a compacted message drops attachment rows and clears the fold
    // so the agent cannot still see the deleted text in the summary.
    store.deleteMessage(message.id);
    const after = store.sessionById(session.id)!;
    expect(after.summary).toBeNull();
    expect(after.compactedThrough).toBe(0);
    expect(store.attachmentById(image.id)).toBeUndefined();
    expect(store.attachmentById(failed.id)).toBeUndefined();
  });

  it("deletes a session's attachments along with its messages", () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession(HANDLE);
    const message = store.appendMessage({
      sessionId: session.id,
      handle: HANDLE,
      role: "user",
      content: '[image "photo.jpg"]',
    });
    const attachment = store.insertAttachment({
      handle: HANDLE,
      kind: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10,
      path: "attachments/deadbeef.jpg",
      visionEligible: true,
    });
    store.linkAttachments([attachment.id], message.id);

    store.deleteSession(session.id);
    expect(store.attachmentById(attachment.id)).toBeUndefined();
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
