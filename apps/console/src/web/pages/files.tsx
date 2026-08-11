import { useEffect, useMemo, useState } from "react";
import { CalendarClock, FilePlus2, Lock, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Editor } from "@/components/editor";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import {
  ApiError,
  deleteFile,
  previewSchedule,
  saveFile,
  useFileContent,
  useFiles,
  useInvalidate,
  type SchedulePreview,
} from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";

const CORE_ORDER = ["SYSTEM.md", "SCHEDULE.md", "MEMORY.md", "USER.md", "README.md"];

const SKILL_TEMPLATE = `---
name: NAME
description: One line shown in the agent's prompt.
version: 1
---

When to use, steps, pitfalls, verification.
`;

export function FilesPage() {
  const files = useFiles();
  const [selected, setSelected] = useState<string | null>(null);
  const invalidate = useInvalidate();

  // Follow the list: pick SYSTEM.md (or the first file) once loaded, and
  // recover when the selected file disappears underneath us.
  useEffect(() => {
    const paths = (files.data?.files ?? []).map((file) => file.path);
    if (selected && paths.includes(selected)) return;
    setSelected(paths.includes("SYSTEM.md") ? "SYSTEM.md" : (paths[0] ?? null));
  }, [files.data, selected]);

  const groups = useMemo(() => {
    const all = files.data?.files ?? [];
    const core = CORE_ORDER.flatMap((name) => all.filter((file) => file.path === name));
    const skills = all.filter((file) => file.path.startsWith("skills/"));
    const other = all.filter((file) => !core.includes(file) && !skills.includes(file));
    return { core, skills, other };
  }, [files.data]);

  return (
    <Page
      title="Files"
      description="The markdown that defines your Nudge: prompt, schedule, memory, and skills."
      wide
      actions={<NewFileDialog onCreated={(path) => { invalidate("files"); setSelected(path); }} />}
    >
      <div className="grid min-h-[70vh] grid-cols-[220px_1fr] gap-5">
        <nav className="flex flex-col gap-4 text-sm">
          {(
            [
              ["Core", groups.core],
              ["Skills", groups.skills],
              ["Other", groups.other],
            ] as const
          ).map(
            ([label, list]) =>
              list.length > 0 && (
                <div key={label}>
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <div className="flex flex-col">
                    {list.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setSelected(file.path)}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                          selected === file.path && "bg-accent font-medium",
                        )}
                      >
                        <span className="truncate">{file.path.replace(/^skills\//, "")}</span>
                        {file.readOnly && <Lock className="size-3 shrink-0 text-muted-foreground" />}
                      </button>
                    ))}
                  </div>
                </div>
              ),
          )}
          {files.data?.files.length === 0 && (
            <p className="px-2 text-muted-foreground">
              No files yet — they appear once the server boots.
            </p>
          )}
        </nav>
        {selected ? (
          <FileEditor key={selected} path={selected} onDeleted={() => { invalidate("files"); setSelected(null); }} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing to edit yet. Create a file, or start the server once to seed the data
            directory.
          </p>
        )}
      </div>
    </Page>
  );
}

function FileEditor({ path, onDeleted }: { path: string; onDeleted: () => void }) {
  const { data, isLoading } = useFileContent(path);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidate();

  const content = draft ?? data?.content ?? "";
  const dirty = draft !== null && draft !== data?.content;
  const isSchedule = path === "SCHEDULE.md";
  const isCore = CORE_ORDER.includes(path);

  const save = () => {
    if (!dirty || data?.readOnly) return;
    setSaving(true);
    saveFile(path, content)
      .then(() => {
        setError(null);
        setDraft(null);
        invalidate("files", "file");
        toast.success(`Saved ${path}`);
      })
      .catch((problem: unknown) => {
        setError(problem instanceof ApiError ? problem.message : String(problem));
      })
      .finally(() => setSaving(false));
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Could not load {path}.</p>;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs">{path}</span>
          {data.readOnly && <Badge variant="outline">system-written</Badge>}
          {data.budget !== null && (
            <Badge variant={content.length > data.budget ? "destructive" : "outline"}>
              {content.length.toLocaleString()} / {data.budget.toLocaleString()} chars
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!data.readOnly && !isCore && (
            <Confirm
              title={`Delete ${path}?`}
              description="The agent will no longer see this file."
              actionLabel="Delete"
              onConfirm={() => {
                void deleteFile(path).then(() => {
                  toast.success(`Deleted ${path}`);
                  onDeleted();
                });
              }}
            >
              <Button variant="destructive" size="sm">
                <Trash2 /> Delete
              </Button>
            </Confirm>
          )}
          {!data.readOnly && (
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              <Save /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      <div className={cn("grid min-h-0 flex-1 gap-4", isSchedule && "lg:grid-cols-[1fr_280px]")}>
        <div className="overflow-hidden rounded-lg border border-border">
          <Editor
            value={content}
            onChange={(value) => setDraft(value)}
            language="markdown"
            readOnly={data.readOnly}
          />
        </div>
        {isSchedule && !data.readOnly && (
          <ScheduleLens content={content} onChange={(next) => setDraft(next)} />
        )}
      </div>
    </div>
  );
}

/**
 * Structured lens over the SCHEDULE.md draft: parsed entries with next-run
 * times and per-entry errors, whole-entry delete, and a guided "add entry"
 * builder. Edits modify the draft — the Save button persists, so a slip is
 * recoverable before it lands. The markdown stays the source of truth; the
 * lens never regenerates untouched sections.
 */
function ScheduleLens({ content, onChange }: { content: string; onChange: (next: string) => void }) {
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      previewSchedule(content).then(setPreview).catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [content]);

  // Parser errors carry the entry name: `"Name": message`. Broken entries do
  // not appear in `entries`, so they get their own cards — with a delete
  // button, because a broken entry is inactive and the owner may want it gone.
  const broken = (preview?.errors ?? []).map((error) => {
    const match = /^"([^"]+)":\s*([\s\S]*)$/.exec(error);
    return match ? { name: match[1]!, message: match[2]! } : { name: null, message: error };
  });
  const names = [
    ...(preview?.entries.map((entry) => entry.name) ?? []),
    ...broken.flatMap((entry) => (entry.name === null ? [] : [entry.name])),
  ];

  const removeEntry = (name: string) => onChange(withoutEntry(content, name));

  return (
    <aside className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <CalendarClock className="size-3.5" /> Schedule
        </p>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add entry
        </Button>
      </div>
      {broken.map((entry, index) => (
        <div
          key={`${entry.name ?? "?"}-${index}`}
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{entry.name ?? "Unparsable entry"}</p>
            {entry.name !== null && (
              <EntryDeleteButton name={entry.name} onDelete={() => removeEntry(entry.name!)} />
            )}
          </div>
          <p className="mt-1 text-xs text-destructive">{entry.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">Inactive until fixed.</p>
        </div>
      ))}
      {preview?.entries.map((entry) => (
        <div key={entry.name} className="rounded-md border border-border p-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{entry.name}</p>
            <EntryDeleteButton name={entry.name} onDelete={() => removeEntry(entry.name)} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">{entry.pattern}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            next:{" "}
            {entry.nextRun
              ? new Date(entry.nextRun).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "never (already fired)"}
          </p>
        </div>
      ))}
      {preview && preview.entries.length === 0 && preview.errors.length === 0 && (
        <p className="text-xs text-muted-foreground">No entries.</p>
      )}
      {adding && (
        <AddEntryDialog
          existingNames={names}
          onAdd={(section) => {
            const base = content.trimEnd();
            onChange(base === "" ? section : `${base}\n\n${section}`);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </aside>
  );
}

function EntryDeleteButton({ name, onDelete }: { name: string; onDelete: () => void }) {
  return (
    <Confirm
      title={`Remove “${name}”?`}
      description="Removes the entry from the draft — nothing is saved until you press Save."
      actionLabel="Remove"
      onConfirm={onDelete}
    >
      <Button
        size="icon"
        variant="ghost"
        className="-mr-1 -mt-1 size-6 text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${name}`}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </Confirm>
  );
}

/** Cut one `## name` section, preserving everything else byte-for-byte. */
function withoutEntry(content: string, name: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      skipping = heading[1].trim().toLowerCase() === name.trim().toLowerCase();
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

// -- guided add-entry builder ----------------------------------------------

type WhenKind = "daily" | "weekdays" | "weekends" | "weekly" | "interval" | "once" | "cron";

const WHEN_KINDS: { value: WhenKind; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekends", label: "Weekends" },
  { value: "weekly", label: "Weekly (pick a day)" },
  { value: "interval", label: "Every N minutes/hours" },
  { value: "once", label: "Once, at a date and time" },
  { value: "cron", label: "Raw cron pattern" },
];

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function AddEntryDialog({
  existingNames,
  onAdd,
  onClose,
}: {
  existingNames: string[];
  onAdd: (section: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<WhenKind>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("monday");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<"minutes" | "hours">("minutes");
  const [date, setDate] = useState("");
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

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
    }
  };

  const add = () => {
    const trimmedName = name.trim();
    if (existingNames.some((other) => other.trim().toLowerCase() === trimmedName.toLowerCase())) {
      setError(`An entry named “${trimmedName}” already exists.`);
      return;
    }
    const section = `## ${trimmedName}\nwhen: ${whenText()}\n${prompt.trim()}\n`;
    setChecking(true);
    // The section is validated by the real parser before it touches the draft.
    previewSchedule(section)
      .then((result) => {
        if (result.errors.length > 0) {
          setError(result.errors.join("\n"));
          return;
        }
        onAdd(section);
      })
      .catch((problem: unknown) => {
        setError(problem instanceof ApiError ? problem.message : String(problem));
      })
      .finally(() => setChecking(false));
  };

  const complete =
    name.trim() !== "" &&
    prompt.trim() !== "" &&
    (kind === "once" ? date !== "" : true) &&
    (kind === "cron" ? cron.trim() !== "" : true) &&
    (kind === "interval" ? /^\d+$/.test(amount.trim()) : true);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Add a schedule entry</DialogTitle>
        <DialogDescription>
          Appends an entry to the draft — press Save afterwards to make it live. Times use the
          configured timezone.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Morning briefing"
              autoFocus
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
          <Button onClick={add} disabled={!complete || checking}>
            {checking ? "Checking…" : "Add to draft"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewFileDialog({ onCreated }: { onCreated: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("skills/my-skill/SKILL.md");
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    const path = name.trim();
    const content = path.endsWith("SKILL.md")
      ? SKILL_TEMPLATE.replace("NAME", path.split("/")[1] ?? "my-skill")
      : "";
    saveFile(path, content)
      .then(() => {
        setOpen(false);
        setError(null);
        onCreated(path);
        toast.success(`Created ${path}`);
      })
      .catch((problem: unknown) => {
        setError(problem instanceof ApiError ? problem.message : String(problem));
      });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FilePlus2 /> New file
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>New file</DialogTitle>
        <DialogDescription>
          Path inside the data directory. Skills follow skills/&lt;name&gt;/SKILL.md and get a
          frontmatter template.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={create}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
