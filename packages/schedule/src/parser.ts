import { createHash } from "node:crypto";
import { Cron } from "croner";

export interface ScheduleEntry {
  /** Stable id derived from the name plus timing/prompt content. */
  id: string;
  name: string;
  when: WhenSpec;
  prompt: string;
}

export type WhenSpec =
  | { kind: "cron"; pattern: string }
  | { kind: "once"; pattern: string };

export interface ParseResult {
  entries: ScheduleEntry[];
  errors: string[];
}

const WEEKDAY_NUMBERS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Parse SCHEDULE.md. Format, per entry:
 *
 *   ## Entry name
 *   when: <timing expression>
 *   The prompt to run, on one or more lines.
 *
 * Timing grammar (deterministic — never interpreted by the model at runtime):
 *   cron: 30 7 * * 1-5            raw five-field cron
 *   every day at 7:30
 *   weekdays at 7:30 / weekends at 9:00
 *   every monday at 18:00         any weekday name
 *   every 2 hours / every 30 minutes
 *   2026-09-01 09:00 once         one-shot local wall time
 */
export function parseSchedule(markdown: string): ParseResult {
  const entries: ScheduleEntry[] = [];
  const errors: string[] = [];
  const sections = splitSections(markdown);

  for (const section of sections) {
    const whenLine = section.lines.find((line) => /^when\s*:/i.test(line.trim()));
    if (!whenLine) {
      errors.push(`"${section.name}": missing a "when:" line`);
      continue;
    }
    const whenText = whenLine.trim().replace(/^when\s*:/i, "").trim();
    const prompt = section.lines
      .filter((line) => line !== whenLine)
      .join("\n")
      .trim();
    if (!prompt) {
      errors.push(`"${section.name}": missing a prompt below the "when:" line`);
      continue;
    }

    let when: WhenSpec;
    try {
      when = parseWhen(whenText);
    } catch (error) {
      errors.push(
        `"${section.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    entries.push({
      id: entryId(section.name, whenText, prompt),
      name: section.name,
      when,
      prompt,
    });
  }

  return { entries, errors };
}

/** The next instant this entry should run after `after`, or null if none. */
export function nextRun(entry: ScheduleEntry, after: Date, timeZone: string): Date | null {
  const cron = new Cron(entry.when.pattern, { timezone: timeZone });
  if (entry.when.kind === "once") {
    // A one-shot keeps its target instant even when `after` has passed it, so
    // a server that was down at the scheduled time still fires it late; the
    // caller suppresses re-runs through the completed flag.
    return cron.nextRun(new Date(0));
  }
  return cron.nextRun(after);
}

function splitSections(markdown: string): { name: string; lines: string[] }[] {
  const sections: { name: string; lines: string[] }[] = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      current = { name: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current && line.trim() !== "") {
      current.lines.push(line);
    }
  }
  return sections;
}

function parseWhen(text: string): WhenSpec {
  const normalized = text.toLowerCase().trim();

  const rawCron = /^cron\s*:\s*(.+)$/.exec(normalized);
  if (rawCron?.[1]) {
    return validatedCron(rawCron[1].trim());
  }

  const once = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+once$/.exec(normalized);
  if (once) {
    const [, date, hour, minute] = once;
    const pattern = `${date}T${String(hour).padStart(2, "0")}:${minute}:00`;
    validatedOnce(pattern);
    return { kind: "once", pattern };
  }

  const daily = /^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if (daily) {
    return validatedCron(`${clockMinute(daily)} ${clockHour(daily)} * * *`);
  }

  const weekdays = /^weekdays\s+at\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if (weekdays) {
    return validatedCron(`${clockMinute(weekdays)} ${clockHour(weekdays)} * * 1-5`);
  }

  const weekends = /^weekends\s+at\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if (weekends) {
    return validatedCron(`${clockMinute(weekends)} ${clockHour(weekends)} * * 6,0`);
  }

  const weekly = /^every\s+([a-z]+?)s?\s+at\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if (weekly?.[1] && weekly[1] in WEEKDAY_NUMBERS) {
    const day = WEEKDAY_NUMBERS[weekly[1]];
    return validatedCron(`${Number(weekly[3])} ${Number(weekly[2])} * * ${day}`);
  }

  const interval = /^every\s+(\d+)\s+(minutes?|hours?)$/.exec(normalized);
  if (interval?.[1] && interval[2]) {
    const amount = Number(interval[1]);
    if (amount < 1 || amount > 59) {
      throw new Error(`interval must be between 1 and 59, got ${amount}`);
    }
    return interval[2].startsWith("minute")
      ? validatedCron(`*/${amount} * * * *`)
      : validatedCron(`0 */${amount} * * *`);
  }

  throw new Error(
    `cannot parse "${text}". Use e.g. "every day at 7:30", "weekdays at 9:00", ` +
      `"every monday at 18:00", "every 2 hours", "2026-09-01 09:00 once", or "cron: 30 7 * * 1-5"`,
  );
}

function clockHour(match: RegExpExecArray): number {
  const hour = Number(match[1]);
  if (hour > 23) throw new Error(`hour must be 0-23, got ${hour}`);
  return hour;
}

function clockMinute(match: RegExpExecArray): number {
  const minute = Number(match[2]);
  if (minute > 59) throw new Error(`minute must be 0-59, got ${minute}`);
  return minute;
}

function validatedCron(pattern: string): WhenSpec {
  try {
    new Cron(pattern, { timezone: "UTC" });
  } catch (error) {
    throw new Error(
      `invalid cron pattern "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { kind: "cron", pattern };
}

function validatedOnce(pattern: string): void {
  try {
    new Cron(pattern, { timezone: "UTC" });
  } catch (error) {
    throw new Error(
      `invalid date "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function entryId(name: string, when: string, prompt: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(`${when}\n${prompt}`).digest("hex").slice(0, 8);
  return `${slug || "entry"}-${hash}`;
}
