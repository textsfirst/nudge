import { describe, expect, it } from "vitest";
import { nextRun, parseSchedule } from "../src/parser.js";

const TZ = "America/Los_Angeles";

describe("parseSchedule", () => {
  it("parses the documented grammar", () => {
    const { entries, errors } = parseSchedule(`# Nudge schedules

## Morning briefing
when: weekdays at 7:30
Summarize anything I asked you to track.

## Hydration
when: every 2 hours
Tell me to drink water.

## Weekly review
when: every sunday at 18:00
Ask how the week went.

## Passport
when: 2026-09-01 09:00 once
Remind me to renew my passport.

## Raw cron
when: cron: 15 6 * * 3
Say happy Wednesday.
`);
    expect(errors).toEqual([]);
    expect(entries.map((entry) => entry.when.pattern)).toEqual([
      "30 7 * * 1-5",
      "0 */2 * * *",
      "0 18 * * 0",
      "2026-09-01T09:00:00",
      "15 6 * * 3",
    ]);
    expect(entries[0]?.prompt).toBe("Summarize anything I asked you to track.");
  });

  it("keeps entry ids stable when timing or prompt change", () => {
    const one = parseSchedule("## A\nwhen: every day at 9:00\nHello").entries[0];
    const same = parseSchedule("## A\nwhen: every day at 9:00\nHello").entries[0];
    const different = parseSchedule("## A\nwhen: every day at 9:05\nHello").entries[0];
    expect(one?.id).toBe(same?.id);
    expect(one?.id).toBe(different?.id);
    expect(one?.legacyId).not.toBe(different?.legacyId);
  });

  it("rejects duplicate entry names because names are persistent identities", () => {
    const { entries, errors } = parseSchedule(
      "## Morning\nwhen: every day at 9:00\nHello\n\n## morning\nwhen: every day at 10:00\nAgain",
    );
    expect(entries).toHaveLength(1);
    expect(errors).toEqual(['"morning": duplicate entry name']);
  });

  it("reports helpful errors without dropping valid entries", () => {
    const { entries, errors } = parseSchedule(`## Good
when: every day at 8:00
Do the thing.

## No when
Just a prompt.

## Bad time
when: every day at 27:00
Prompt.

## Unparseable
when: whenever you feel like it
Prompt.

## No prompt
when: every day at 9:00
`);
    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("No when");
    expect(errors[1]).toContain("hour must be 0-23");
    expect(errors[2]).toContain("cannot parse");
    expect(errors[3]).toContain("missing a prompt");
  });
});

describe("nextRun", () => {
  it("computes timezone-aware next runs for cron entries", () => {
    const entry = parseSchedule("## A\nwhen: weekdays at 7:30\nHi").entries[0]!;
    // Monday 2026-08-10 00:00 UTC → next weekday 7:30 LA is 14:30 UTC same day.
    const next = nextRun(entry, new Date("2026-08-10T00:00:00Z"), TZ);
    expect(next?.toISOString()).toBe("2026-08-10T14:30:00.000Z");
  });

  it("keeps one-shot targets even after they pass", () => {
    const entry = parseSchedule("## A\nwhen: 2026-08-15 14:00 once\nHi").entries[0]!;
    const before = nextRun(entry, new Date("2026-08-01T00:00:00Z"), TZ);
    const after = nextRun(entry, new Date("2026-09-01T00:00:00Z"), TZ);
    expect(before?.toISOString()).toBe("2026-08-15T21:00:00.000Z");
    expect(after?.toISOString()).toBe("2026-08-15T21:00:00.000Z");
  });
});
