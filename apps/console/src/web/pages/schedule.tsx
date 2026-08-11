import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import {
  ApiError,
  getFileContent,
  previewSchedule,
  saveFile,
  useFileContent,
  useInvalidate,
  useScheduleState,
  type ScheduleEntryState,
  type SchedulePreview,
} from "@/lib/api";

/**
 * Structured management of SCHEDULE.md. The markdown stays the source of
 * truth — the agent and the Files page edit it too — so every action here is
 * an entry-scoped read-modify-write against a fresh copy of the file, and a
 * same-entry change underneath surfaces as a conflict instead of being
 * overwritten. Untouched sections are preserved byte-for-byte.
 */

const SCHEDULE_PATH = "SCHEDULE.md";

interface RawEntry {
  name: string;
  when: string | null;
  agent: string | null;
  check: string | null;
  prompt: string;
  /** The exact section text, heading included — the conflict-check baseline. */
  section: string;
}

export function SchedulePage() {
  const { data, error, isLoading } = useFileContent(SCHEDULE_PATH);
  const { data: stateData } = useScheduleState();
  const invalidate = useInvalidate();
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [dialog, setDialog] = useState<{ editing: RawEntry | null } | null>(null);

  // A missing file just means no schedule yet — the first add creates it.
  const missing = error instanceof ApiError && error.status === 404;
  const content = data?.content ?? "";

  useEffect(() => {
    if (isLoading || (error && !missing)) return;
    previewSchedule(content).then(setPreview).catch(() => setPreview(null));
  }, [content, isLoading, error, missing]);

  const entries = useMemo(() => parseSections(content), [content]);
  const byName = (name: string) =>
    preview?.entries.find((entry) => sameName(entry.name, name));
  const errorFor = (name: string) => {
    const prefix = `"${name}":`;
    const message = preview?.errors.find((problem) => problem.startsWith(prefix));
    return message ? message.slice(prefix.length).trim() : null;
  };

  const refresh = () => invalidate("file", "files");

  /** Fetch fresh, apply, save — the mutator returns an error string to abort. */
  const mutate = async (change: (fresh: string) => string | { conflict: string }) => {
    let fresh = "";
    try {
      fresh = (await getFileContent(SCHEDULE_PATH)).content;
    } catch (problem: unknown) {
      if (!(problem instanceof ApiError && problem.status === 404)) throw problem;
    }
    const next = change(fresh);
    if (typeof next !== "string") {
      refresh();
      throw new Error(next.conflict);
    }
    await saveFile(SCHEDULE_PATH, next);
    refresh();
  };

  const remove = (name: string) => {
    mutate((fresh) =>
      sectionFor(fresh, name) === null
        ? { conflict: `“${name}” is already gone — the schedule was edited underneath.` }
        : withoutEntry(fresh, name),
    )
      .then(() => toast.success(`Removed “${name}”`))
      .catch((problem: unknown) => toast.error(messageOf(problem)));
  };

  if (isLoading) {
    return (
      <Page title="Schedule">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }
  if (error && !missing) {
    return (
      <Page title="Schedule">
        <p className="text-sm text-destructive">{messageOf(error)}</p>
      </Page>
    );
  }

  return (
    <Page
      title="Schedule"
      description={`What the agent does on its own, and when${
        preview ? ` — times in ${preview.timeZone}` : ""
      }.`}
      actions={
        <Button size="sm" onClick={() => setDialog({ editing: null })}>
          <Plus /> Add entry
        </Button>
      }
    >
      {entries.length === 0 && (
        <Card>
          <CardContent className="pt-3 text-muted-foreground">
            Nothing scheduled yet. “Add entry” sets up a recurring or one-shot prompt — a morning
            briefing, a weekly review, a reminder. Entries live in{" "}
            <span className="font-mono text-xs">SCHEDULE.md</span>, which the agent can edit too.
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {entries.map((entry) => {
          const parsed = byName(entry.name);
          const problem = errorFor(entry.name);
          const state = parsed
            ? stateData?.states.find((candidate) => candidate.entryId === parsed.id)
            : undefined;
          return (
            <Card key={entry.name} className={problem ? "border-destructive/40" : undefined}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2">
                  {entry.name}
                  {entry.check && <Badge>watcher</Badge>}
                  {entry.agent && <Badge variant="outline">agent: {entry.agent}</Badge>}
                  {problem && <Badge variant="destructive">inactive</Badge>}
                </CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${entry.name}`}
                    title="Edit"
                    onClick={() => setDialog({ editing: entry })}
                  >
                    <Pencil />
                  </Button>
                  <Confirm
                    title={`Remove “${entry.name}”?`}
                    description="Deletes the entry from SCHEDULE.md. It will no longer fire."
                    actionLabel="Remove"
                    onConfirm={() => remove(entry.name)}
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${entry.name}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </Confirm>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                <p className="font-mono text-xs text-muted-foreground">
                  {entry.when ?? "(no when: line)"}
                  {parsed && parsed.pattern !== entry.when && ` · ${parsed.pattern}`}
                </p>
                {problem ? (
                  <p className="text-xs text-destructive">{problem} — inactive until fixed.</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    next:{" "}
                    {parsed?.nextRun
                      ? new Date(parsed.nextRun).toLocaleString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "never (already fired)"}
                  </p>
                )}
                {entry.check && (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    check: {entry.check}
                  </p>
                )}
                {state && <EntryHealth entry={entry} state={state} />}
                <p className="line-clamp-3 whitespace-pre-wrap text-sm">{entry.prompt}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Prefer raw markdown? Edit{" "}
        <Link to="/files" className="text-primary underline-offset-2 hover:underline">
          SCHEDULE.md on the Files page
        </Link>
        .
      </p>

      {dialog && (
        <EntryDialog
          editing={dialog.editing}
          otherNames={entries
            .filter((entry) => !dialog.editing || !sameName(entry.name, dialog.editing.name))
            .map((entry) => entry.name)}
          onSubmit={async (name, section) => {
            const editing = dialog.editing;
            await mutate((fresh) => {
              if (editing) {
                const current = sectionFor(fresh, editing.name);
                if (current === null) {
                  return {
                    conflict: `“${editing.name}” was removed while you were editing — reloaded.`,
                  };
                }
                if (current !== editing.section) {
                  return {
                    conflict: `“${editing.name}” changed while you were editing (likely the agent) — reloaded, try again.`,
                  };
                }
                return replaceEntry(fresh, editing.name, section);
              }
              if (sectionFor(fresh, name) !== null) {
                return { conflict: `An entry named “${name}” already exists.` };
              }
              const base = fresh.trimEnd();
              return base === "" ? section : `${base}\n\n${section}`;
            });
            toast.success(editing ? `Saved “${name}”` : `Added “${name}”`);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </Page>
  );
}

function messageOf(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}

/**
 * Run/check health for one entry. For watchers this is the dead-or-flapping
 * view: a persistent error means the check is broken; a wake ratio near 1
 * means its output isn't normalized and every poll looks like a change.
 */
function EntryHealth({ entry, state }: { entry: RawEntry; state: ScheduleEntryState }) {
  const time = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <p>
        {state.lastRunAt ? `last ran ${time(state.lastRunAt)}` : "never ran"}
        {entry.check && state.checksRun > 0 && (
          <>
            {" "}
            · {state.checksRun} checks, {state.wakes} woke the agent
            {state.wakes > 0 && state.checksRun >= 10 && state.wakes / state.checksRun > 0.5 && (
              <span className="text-destructive"> (flapping? normalize the check output)</span>
            )}
          </>
        )}
        {entry.check && state.lastChangeAt && ` · last change ${time(state.lastChangeAt)}`}
      </p>
      {state.lastCheckError && (
        <p className="text-destructive">check failing: {state.lastCheckError}</p>
      )}
    </div>
  );
}

// -- section surgery on the markdown ----------------------------------------

const HEADING = /^##\s+(.+?)\s*$/;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Sections in file order, with their exact text for conflict baselines. */
function parseSections(content: string): RawEntry[] {
  const entries: RawEntry[] = [];
  for (const range of sectionRanges(content)) {
    const lines = range.lines;
    const whenLine = lines.find((line) => /^when\s*:/i.test(line.trim()));
    const agentLine = lines.find((line) => /^agent\s*:/i.test(line.trim()));
    const checkLine = lines.find((line) => /^check\s*:/i.test(line.trim()));
    entries.push({
      name: range.name,
      when: whenLine ? whenLine.trim().replace(/^when\s*:/i, "").trim() : null,
      agent: agentLine ? agentLine.trim().replace(/^agent\s*:/i, "").trim() || null : null,
      check: checkLine ? checkLine.trim().replace(/^check\s*:/i, "").trim() || null : null,
      prompt: lines
        .filter(
          (line) =>
            line !== whenLine &&
            line !== agentLine &&
            line !== checkLine &&
            line.trim() !== "" &&
            !HEADING.test(line),
        )
        .join("\n")
        .trim(),
      section: range.text,
    });
  }
  return entries;
}

function sectionRanges(
  content: string,
): { name: string; start: number; end: number; lines: string[]; text: string }[] {
  const lines = content.split("\n");
  const ranges: { name: string; start: number; end: number; lines: string[]; text: string }[] = [];
  let current: { name: string; start: number } | null = null;
  const close = (end: number) => {
    if (!current) return;
    const slice = lines.slice(current.start, end);
    ranges.push({
      name: current.name,
      start: current.start,
      end,
      lines: slice,
      text: slice.join("\n").trimEnd(),
    });
  };
  lines.forEach((line, index) => {
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      close(index);
      current = { name: heading[1], start: index };
    }
  });
  close(lines.length);
  return ranges;
}

function sectionFor(content: string, name: string): string | null {
  return sectionRanges(content).find((range) => sameName(range.name, name))?.text ?? null;
}

/** Cut one section, preserving everything else byte-for-byte. */
function withoutEntry(content: string, name: string): string {
  const range = sectionRanges(content).find((candidate) => sameName(candidate.name, name));
  if (!range) return content;
  const lines = content.split("\n");
  lines.splice(range.start, range.end - range.start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Swap one section in place, keeping the file's entry order. */
function replaceEntry(content: string, name: string, section: string): string {
  const range = sectionRanges(content).find((candidate) => sameName(candidate.name, name));
  if (!range) return content;
  const lines = content.split("\n");
  lines.splice(range.start, range.end - range.start, ...`${section.trimEnd()}\n`.split("\n"));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// -- guided entry builder ---------------------------------------------------

type WhenKind =
  | "daily"
  | "weekdays"
  | "weekends"
  | "weekly"
  | "interval"
  | "once"
  | "cron"
  | "custom";

const WHEN_KINDS: { value: WhenKind; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekends", label: "Weekends" },
  { value: "weekly", label: "Weekly (pick a day)" },
  { value: "interval", label: "Every N minutes/hours" },
  { value: "once", label: "Once, at a date and time" },
  { value: "cron", label: "Raw cron pattern" },
  { value: "custom", label: "Custom expression" },
];

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function EntryDialog({
  editing,
  otherNames,
  onSubmit,
  onClose,
}: {
  editing: RawEntry | null;
  otherNames: string[];
  onSubmit: (name: string, section: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<WhenKind>(editing ? "custom" : "daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("monday");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<"minutes" | "hours">("minutes");
  const [date, setDate] = useState("");
  const [cron, setCron] = useState("");
  const [custom, setCustom] = useState(editing?.when ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [agentName, setAgentName] = useState(editing?.agent ?? "");
  const [checkCmd, setCheckCmd] = useState(editing?.check ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const whenText = (): string => {
    switch (kind) {
      case "daily":
        return `every day at ${time}`;
      case "weekdays":
        return `weekdays at ${time}`;
      case "weekends":
        return `weekends at ${time}`;
      case "weekly":
        return `every ${weekday} at ${time}`;
      case "interval":
        return `every ${amount} ${unit}`;
      case "once":
        return `${date} ${time} once`;
      case "cron":
        return `cron: ${cron}`;
      case "custom":
        return custom.trim();
    }
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (otherNames.some((other) => sameName(other, trimmedName))) {
      setError(`An entry named “${trimmedName}” already exists.`);
      return;
    }
    const control = [`## ${trimmedName}`, `when: ${whenText()}`];
    if (agentName.trim()) control.push(`agent: ${agentName.trim()}`);
    if (checkCmd.trim()) control.push(`check: ${checkCmd.trim()}`);
    const section = `${control.join("\n")}\n${prompt.trim()}\n`;
    setBusy(true);
    // The section is validated by the real parser before anything is written.
    previewSchedule(section)
      .then(async (result) => {
        if (result.errors.length > 0) {
          setError(result.errors.join("\n"));
          return;
        }
        await onSubmit(trimmedName, section);
      })
      .catch((problem: unknown) => setError(messageOf(problem)))
      .finally(() => setBusy(false));
  };

  const complete =
    name.trim() !== "" &&
    prompt.trim() !== "" &&
    (kind === "once" ? date !== "" : true) &&
    (kind === "cron" ? cron.trim() !== "" : true) &&
    (kind === "custom" ? custom.trim() !== "" : true) &&
    (kind === "interval" ? /^\d+$/.test(amount.trim()) : true);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{editing ? `Edit “${editing.name}”` : "Add a schedule entry"}</DialogTitle>
        <DialogDescription>
          Saved straight to SCHEDULE.md. Times use the configured timezone.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Morning briefing"
              autoFocus={editing === null}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">When</span>
              <Select value={kind} onChange={(event) => setKind(event.target.value as WhenKind)}>
                {WHEN_KINDS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            {kind === "weekly" && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Day</span>
                <Select value={weekday} onChange={(event) => setWeekday(event.target.value)}>
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {kind === "interval" && (
              <div className="grid grid-cols-[1fr_1.2fr] gap-1">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Every</span>
                  <Input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Unit</span>
                  <Select
                    value={unit}
                    onChange={(event) => setUnit(event.target.value as "minutes" | "hours")}
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                  </Select>
                </div>
              </div>
            )}
            {kind === "once" && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Date</span>
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </div>
            )}
            {kind === "cron" && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Pattern</span>
                <Input
                  value={cron}
                  onChange={(event) => setCron(event.target.value)}
                  placeholder="30 7 * * 1-5"
                  className="font-mono"
                  spellCheck={false}
                />
              </div>
            )}
            {kind === "custom" && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Expression</span>
                <Input
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                  placeholder="every day at 7:30"
                  className="font-mono"
                  spellCheck={false}
                />
              </div>
            )}
            {(kind === "daily" ||
              kind === "weekdays" ||
              kind === "weekends" ||
              kind === "weekly" ||
              kind === "once") && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Time</span>
                <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Background agent (optional) — a standing agent runs this with its memory
              </span>
              <Input
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
                placeholder="email"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Check command (optional) — wakes the agent only when output changes
              </span>
              <Input
                value={checkCmd}
                onChange={(event) => setCheckCmd(event.target.value)}
                placeholder="curl -sf … | jq -r '.[].id' | sort"
                className="font-mono"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Prompt — what the agent should do</span>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Summarize my inbox and calendar for today."
              className="min-h-20"
            />
          </div>
          {error && (
            <p className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!complete || busy}>
            {busy ? "Saving…" : editing ? "Save" : "Add"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
