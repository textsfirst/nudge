import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, NudgeAgent } from "@nudge/agent";
import type { SendOptions } from "@nudge/photon";
import { parseSchedule } from "@nudge/schedule";
import { NudgeStore } from "@nudge/store";
import { describe, expect, it, vi } from "vitest";
import { DeliveryService } from "../src/delivery.js";
import { buildCheckRunner, Scheduler } from "../src/scheduler.js";

const OWNER = "+15551234567";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function harness(
  scheduleContent: string,
  runTaskResult: string | null = "nudge text",
  checks: { ok: boolean; output: string }[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "nudge-scheduler-"));
  const schedulePath = join(dir, "SCHEDULE.md");
  writeFileSync(schedulePath, scheduleContent);

  const store = new NudgeStore(":memory:");
  store.rememberSpace(OWNER, "space-1", "imessage");

  const sent: { spaceId: string; text: string }[] = [];
  const sender = {
    sendToSpace: async (spaceId: string, text: string) => {
      sent.push({ spaceId, text });
    },
  };
  const runTask = vi.fn(async () => runTaskResult);
  const runAgentTask = vi.fn(async () => undefined);
  const agent = { runTask, runAgentTask } as unknown as NudgeAgent;

  let now = Date.UTC(2026, 7, 10, 12, 0, 0); // noon UTC
  const remainingChecks = [...checks];
  const runCheck = vi.fn(async () => {
    const next = remainingChecks.shift();
    if (!next) throw new Error("The harness ran out of scripted check results");
    return next;
  });
  const scheduler = new Scheduler({
    schedulePath,
    ownerHandle: OWNER,
    timeZone: "UTC",
    store,
    agent,
    delivery: new DeliveryService(store, sender, logger),
    logger,
    runCheck,
    now: () => now,
  });

  return {
    schedulePath,
    store,
    sent,
    runTask,
    runAgentTask,
    runCheck,
    scheduler,
    setNow: (at: number) => {
      now = at;
    },
  };
}

describe("buildCheckRunner", () => {
  it("runs bash with the given cwd and env, reporting exit status", async () => {
    // realpath: on macOS the temp dir is behind a /var → /private/var symlink,
    // and the spawned shell reports the resolved cwd.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nudge-check-")));
    const run = buildCheckRunner({ cwd: dir, env: { NUDGE_TEST_TOKEN: "sesame" } });

    await expect(run("pwd && echo $NUDGE_TEST_TOKEN")).resolves.toEqual({
      ok: true,
      output: `${dir}\nsesame\n`,
    });

    const failed = await run("echo broken >&2; exit 6");
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("exit 6");
    expect(failed.output).toContain("broken");
  });
});

describe("Scheduler", () => {
  it("fires a due entry once and delivers through the ledger", async () => {
    const { scheduler, sent, runTask, setNow, store } = harness(
      "## Afternoon check\nwhen: every day at 13:00\nCheck in with the owner.",
    );

    await scheduler.tick(); // baseline set at noon; 13:00 not due yet
    expect(runTask).not.toHaveBeenCalled();

    setNow(Date.UTC(2026, 7, 10, 13, 0, 30));
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(
      OWNER,
      "Afternoon check",
      "Check in with the owner.",
    );
    expect(sent).toEqual([{ spaceId: "space-1", text: "nudge text" }]);
    expect(store.openOutbound()).toHaveLength(0);

    await scheduler.tick(); // same occurrence must not refire
    expect(runTask).toHaveBeenCalledOnce();

    setNow(Date.UTC(2026, 7, 11, 13, 0, 30)); // next day fires again
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it("gates a watcher entry on its check: baseline and unchanged stay silent, change wakes", async () => {
    const WATCHER = "## Slots\nwhen: every day at 13:00\nagent: visa\ncheck: probe slots\nSlots changed.";
    const { scheduler, store, runAgentTask, runCheck, setNow } = harness(WATCHER, null, [
      { ok: true, output: "none open\n" },
      { ok: true, output: "none open\n" },
      { ok: true, output: "2 slots open\n" },
    ]);

    await scheduler.tick(); // noon: baseline not due yet
    setNow(Date.UTC(2026, 7, 10, 13, 0, 30));
    await scheduler.tick(); // first firing: baseline, silent
    expect(runCheck).toHaveBeenCalledExactlyOnceWith("probe slots");
    expect(runAgentTask).not.toHaveBeenCalled();

    setNow(Date.UTC(2026, 7, 11, 13, 0, 30));
    await scheduler.tick(); // unchanged output: silent
    expect(runAgentTask).not.toHaveBeenCalled();

    setNow(Date.UTC(2026, 7, 12, 13, 0, 30));
    await scheduler.tick(); // changed output: wake with the output in the brief
    expect(runAgentTask).toHaveBeenCalledOnce();
    const [, name, prompt, agentName] = runAgentTask.mock.calls[0]! as unknown as string[];
    expect(name).toBe("Slots");
    expect(agentName).toBe("visa");
    expect(prompt).toContain("Slots changed.");
    expect(prompt).toContain("check output changed");
    expect(prompt).toContain("2 slots open");

    const entryId = parseSchedule(WATCHER).entries[0]!.id;
    const health = store.scheduleState(entryId);
    expect(health).toMatchObject({ checksRun: 3, wakes: 1 });
    expect(health.lastChangeAt).not.toBeNull();
  });

  it("wakes the watcher's agent when the check command fails", async () => {
    const WATCHER = "## Slots\nwhen: every day at 13:00\nagent: visa\ncheck: probe\nSlots changed.";
    const { scheduler, runAgentTask, setNow } = harness(WATCHER, null, [
      { ok: false, output: "exit 6: could not resolve host" },
    ]);

    await scheduler.tick();
    setNow(Date.UTC(2026, 7, 10, 13, 0, 30));
    await scheduler.tick();

    expect(runAgentTask).toHaveBeenCalledOnce();
    const [, , prompt] = runAgentTask.mock.calls[0]! as unknown as string[];
    expect(prompt).toContain("check command failed");
    expect(prompt).toContain("could not resolve host");
  });

  it("routes an agent-scoped entry through its standing agent, not direct delivery", async () => {
    const { scheduler, sent, runTask, runAgentTask, setNow } = harness(
      "## Inbox sweep\nwhen: every day at 13:00\nagent: email\nCheck for urgent mail.",
    );

    await scheduler.tick(); // baseline set at noon; 13:00 not due yet
    setNow(Date.UTC(2026, 7, 10, 13, 0, 30));
    await scheduler.tick();

    expect(runAgentTask).toHaveBeenCalledExactlyOnceWith(
      OWNER,
      "Inbox sweep",
      "Check for urgent mail.",
      "email",
    );
    // The report channel owns delivery; the scheduler must send nothing itself.
    expect(runTask).not.toHaveBeenCalled();
    expect(sent).toEqual([]);

    await scheduler.tick(); // same occurrence must not refire
    expect(runAgentTask).toHaveBeenCalledOnce();
  });

  it("does not back-fill occurrences from before the entry existed", async () => {
    const { scheduler, runTask, setNow } = harness(
      "## Early bird\nwhen: every day at 6:00\nGood morning.",
    );
    await scheduler.tick(); // first seen at noon — 6:00 already passed today
    setNow(Date.UTC(2026, 7, 10, 18, 0, 0));
    await scheduler.tick();
    expect(runTask).not.toHaveBeenCalled();

    setNow(Date.UTC(2026, 7, 11, 6, 0, 30));
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledOnce();
  });

  it("does not run or complete a one-shot before a space is known", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-scheduler-"));
    const schedulePath = join(dir, "SCHEDULE.md");
    writeFileSync(schedulePath, "## Passport\nwhen: 2026-08-10 09:00 once\nRenew the passport.\n");
    const store = new NudgeStore(":memory:");
    const runTask = vi.fn(async () => "remind you");
    const scheduler = new Scheduler({
      schedulePath,
      ownerHandle: OWNER,
      timeZone: "UTC",
      store,
      agent: { runTask, runAgentTask: async () => undefined } as unknown as NudgeAgent,
      delivery: new DeliveryService(store, { sendToSpace: async () => undefined }, logger),
      logger,
      now: () => Date.UTC(2026, 7, 10, 12, 0, 0),
    });
    await scheduler.tick();
    const id = parseSchedule(readFileSync(schedulePath, "utf8")).entries[0]!.id;
    expect(runTask).not.toHaveBeenCalled();
    expect(store.scheduleState(id).completed).toBe(false);

    store.rememberSpace(OWNER, "space-1", "imessage");
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledOnce();
    expect(store.scheduleState(id).completed).toBe(true);
  });

  it("completes one-shot entries after firing, even late", async () => {
    const { scheduler, runTask, setNow } = harness(
      "## Passport\nwhen: 2026-08-10 09:00 once\nRenew the passport.",
    );
    // Noon: the 09:00 target already passed → fire late, then complete.
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledOnce();

    setNow(Date.UTC(2026, 7, 10, 14, 0, 0));
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledOnce();
  });

  it("does not re-arm a completed one-shot when its prompt is edited", async () => {
    const { scheduler, schedulePath, runTask, setNow } = harness(
      "## Passport\nwhen: 2026-08-10 09:00 once\nRenew the passport.",
    );
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledOnce();

    writeFileSync(
      schedulePath,
      "## Passport\nwhen: 2026-08-10 09:00 once\nRenew the passport and take a photo.",
    );
    setNow(Date.UTC(2026, 7, 10, 14, 0, 0));
    await scheduler.tick();
    expect(runTask).toHaveBeenCalledOnce();
  });

  it("stays quiet when the task returns [SILENT]", async () => {
    const { scheduler, sent, setNow } = harness(
      "## Check\nwhen: every day at 13:00\nAnything?",
      null,
    );
    setNow(Date.UTC(2026, 7, 10, 13, 1, 0));
    await scheduler.tick();
    expect(sent).toEqual([]);
  });

  it("texts the owner when a hand-edited schedule fails to parse", async () => {
    const { scheduler, schedulePath, sent, setNow } = harness(
      "## Fine\nwhen: every day at 13:00\nOk.",
    );
    await scheduler.tick();
    writeFileSync(schedulePath, "## Broken\nwhen: whenever vibes\nDo it.");
    setNow(Date.UTC(2026, 7, 10, 12, 5, 0));
    await scheduler.tick();
    expect(sent.some((message) => message.text.includes("couldn't read part of SCHEDULE.md"))).toBe(
      true,
    );
    // Only notified once for the same broken content.
    await scheduler.tick();
    expect(sent.filter((message) => message.text.includes("SCHEDULE.md"))).toHaveLength(1);
  });
});

describe("DeliveryService", () => {
  it("recovers interrupted sends behind a conversational notice", async () => {
    const store = new NudgeStore(":memory:");
    store.rememberSpace(OWNER, "space-1", "imessage");
    const sent: { text: string; options?: SendOptions }[] = [];
    const delivery = new DeliveryService(
      store,
      { sendToSpace: async (_space, text, options) => void sent.push({ text, options }) },
      logger,
    );

    // A send the previous process died holding.
    const interrupted = store.enqueueOutbound(OWNER, "did you make it?", "nudge");
    store.markOutbound(interrupted, "sending");
    // A send that never started.
    store.enqueueOutbound(OWNER, "fresh reminder", "nudge");

    await delivery.recover();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toBe("did you make it?");
    expect(sent[0]?.options?.preamble).toBe("not sure that went through, so again:");
    expect(sent[0]?.options?.skipChunks).toBe(0);
    expect(sent[1]?.text).toBe("fresh reminder");
    expect(sent[1]?.options?.preamble).toBeUndefined();
    expect(store.openOutbound()).toHaveLength(0);
  });

  it("resumes a partially delivered send after its confirmed bubbles", async () => {
    const store = new NudgeStore(":memory:");
    store.rememberSpace(OWNER, "space-1", "imessage");
    const sent: { text: string; options?: SendOptions }[] = [];
    const delivery = new DeliveryService(
      store,
      { sendToSpace: async (_space, text, options) => void sent.push({ text, options }) },
      logger,
    );

    // Two of three bubbles landed before the previous process died.
    const partial = store.enqueueOutbound(OWNER, "one\n\ntwo\n\nthree", "reply");
    store.markOutbound(partial, "sending");
    store.markOutboundProgress(partial, 2);

    await delivery.recover();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options?.skipChunks).toBe(2);
    expect(sent[0]?.options?.preamble).toBe("got cut off mid-text - here's the rest:");
    expect(store.openOutbound()).toHaveLength(0);
  });

  it("does not recover a send that is still in flight in this process", async () => {
    const store = new NudgeStore(":memory:");
    store.rememberSpace(OWNER, "space-1", "imessage");
    let release!: () => void;
    const calls: string[] = [];
    const delivery = new DeliveryService(
      store,
      {
        sendToSpace: async (_space, text) => {
          calls.push(text);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
      logger,
    );
    const first = delivery.deliver(OWNER, "live", "reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await delivery.recover();
    expect(calls).toEqual(["live"]);
    release();
    await first;
    expect(calls).toEqual(["live"]);
  });

  it("returns false when no space is known for the handle", async () => {
    const store = new NudgeStore(":memory:");
    const delivery = new DeliveryService(
      store,
      { sendToSpace: async () => undefined },
      logger,
    );
    await expect(delivery.deliver("+19990000000", "hello", "nudge")).resolves.toBe(false);
  });

  it("marks repeatedly failing sends terminal after three attempts", async () => {
    const store = new NudgeStore(":memory:");
    store.rememberSpace(OWNER, "space-1", "imessage");
    const failingLogger = { ...logger, error: vi.fn() };
    const delivery = new DeliveryService(
      store,
      {
        sendToSpace: async () => {
          throw new Error("transport down");
        },
      },
      failingLogger,
    );

    await expect(delivery.deliver(OWNER, "hello", "nudge")).resolves.toBe(false);
    await delivery.recover();
    await delivery.recover();

    expect(store.openOutbound()).toEqual([]);
    expect(failingLogger.error).toHaveBeenLastCalledWith(
      "Outbound send failed and exhausted its retry limit",
      expect.objectContaining({ attempt: 3 }),
    );
  });
});
