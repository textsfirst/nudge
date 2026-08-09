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
});
