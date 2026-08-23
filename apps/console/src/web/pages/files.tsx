import { useEffect, useMemo, useState } from "react";
import { CalendarClock, FilePlus2, Lock, Save, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
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
import { Input } from "@/components/ui/input";
import {
  ApiError,
  createFile,
  deleteFile,
  previewSchedule,
  saveFile,
  useFileContent,
  useFiles,
  useInvalidate,
  type SchedulePreview,
} from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";

const CORE_ORDER = ["SYSTEM.md", "SCHEDULE.md", "LOOPS.md", "MEMORY.md", "USER.md", "README.md"];

const SKILL_TEMPLATE = `---
name: NAME
description: What this does and when to use it, shown in the agent's prompt.
metadata:
  version: "1"
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
    if (!dirty || !data || data.readOnly) return;
    setSaving(true);
    saveFile(path, content, data.hash)
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
        {isSchedule && <SchedulePreviewPanel content={content} />}
      </div>
    </div>
  );
}

/**
 * Read-only feedback while hand-editing SCHEDULE.md: parsed entries with
 * next-run times and per-entry errors, live against the draft. Structured
 * management (add/edit/delete) lives on the Schedule page.
 */
function SchedulePreviewPanel({ content }: { content: string }) {
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      previewSchedule(content).then(setPreview).catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [content]);

  // Parser errors carry the entry name: `"Name": message`. Broken entries do
  // not appear in `entries`, so they get their own cards.
  const broken = (preview?.errors ?? []).map((error) => {
    const match = /^"([^"]+)":\s*([\s\S]*)$/.exec(error);
    return match ? { name: match[1], message: match[2] } : { name: undefined, message: error };
  });

  return (
    <aside className="flex flex-col gap-2 text-sm">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <CalendarClock className="size-3.5" /> Parsed schedule
      </p>
      {broken.map((entry, index) => (
        <div
          key={`${entry.name ?? "?"}-${index}`}
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5"
        >
          <p className="font-medium">{entry.name ?? "Unparsable entry"}</p>
          <p className="mt-1 text-xs text-destructive">{entry.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">Inactive until fixed.</p>
        </div>
      ))}
      {preview?.entries.map((entry) => (
        <div key={entry.name} className="rounded-md border border-border p-2.5">
          <p className="font-medium">{entry.name}</p>
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
                  ...(preview.timeZone ? { timeZone: preview.timeZone } : {}),
                })
              : "never (already fired)"}
          </p>
        </div>
      ))}
      {preview && preview.entries.length === 0 && preview.errors.length === 0 && (
        <p className="text-xs text-muted-foreground">No entries.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Manage entries on the{" "}
        <Link to="/schedule" className="text-primary underline-offset-2 hover:underline">
          Schedule page
        </Link>
        .
      </p>
    </aside>
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
    createFile(path, content)
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
