import { useState } from "react";
import { ArchiveRestore, Download, RefreshCw, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  checkSkillUpdates,
  deleteSkill,
  installSkill,
  restoreSkill,
  updateSkill,
  useInvalidate,
  useSkills,
  type SkillEntry,
  type SkillUpdateStatus,
} from "@/lib/api";

/**
 * Skill management in the Agent Skills format (agentskills.io). Editing stays
 * on the Files page — this page owns lifecycle and provenance: what the agent
 * sees, where each skill came from, whether the shipped original or a
 * registry upstream has moved on.
 */

export function SkillsPage() {
  const { data, isLoading } = useSkills();
  const invalidate = useInvalidate();
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updates, setUpdates] = useState<Map<string, SkillUpdateStatus> | null>(null);

  const hasRegistrySkills = (data?.skills ?? []).some(
    (skill) => skill.provenance === "registry" || skill.provenance === "registry-customized",
  );

  const check = () => {
    setChecking(true);
    checkSkillUpdates()
      .then((statuses) => {
        setUpdates(new Map(statuses.map((status) => [status.name, status])));
        const available = statuses.filter((status) => status.updateAvailable).length;
        toast.success(
          available === 0 ? "All registry skills are up to date" : `${available} update(s) available`,
        );
      })
      .catch((problem: unknown) => toast.error(messageOf(problem)))
      .finally(() => setChecking(false));
  };

  if (isLoading || !data) {
    return (
      <Page title="Skills">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }

  return (
    <Page
      title="Skills"
      description="What the agent knows how to do — shipped with Nudge, installed from skills.sh, or written here."
      actions={
        <>
          {hasRegistrySkills && (
            <Button size="sm" variant="outline" onClick={check} disabled={checking}>
              <RefreshCw /> {checking ? "Checking…" : "Check updates"}
            </Button>
          )}
          <Button size="sm" onClick={() => setInstalling(true)}>
            <Download /> Install
          </Button>
        </>
      }
    >
      {data.skills.length === 0 && (
        <Card>
          <CardContent className="pt-3 text-muted-foreground">
            No skills yet. Install one from skills.sh, restore a shipped skill below, or create
            one on the Files page.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {data.skills.map((skill) => (
          <SkillCard
            key={skill.name}
            skill={skill}
            update={updates?.get(skill.name)}
            onChanged={() => {
              invalidate("skills", "files");
              setUpdates(null);
            }}
          />
        ))}
      </div>

      {data.restorable.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Shipped with Nudge, not installed
          </h2>
          <div className="flex flex-col gap-2">
            {data.restorable.map((gone) => (
              <div
                key={gone.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium">{gone.name}</span>{" "}
                  <span className="text-muted-foreground">— {gone.description}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    restoreSkill(gone.name)
                      .then(() => {
                        invalidate("skills", "files");
                        toast.success(`Restored ${gone.name}`);
                      })
                      .catch((problem: unknown) => toast.error(messageOf(problem)));
                  }}
                >
                  <ArchiveRestore /> Restore
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Skill contents are edited as markdown on the{" "}
        <Link to="/files" className="text-primary underline-offset-2 hover:underline">
          Files page
        </Link>
        . The agent can also install skills itself with the <span className="font-mono">skills</span>{" "}
        CLI — it will ask first.
      </p>

      {installing && (
        <InstallDialog
          onDone={() => {
            invalidate("skills", "files");
            setInstalling(false);
          }}
          onClose={() => setInstalling(false)}
        />
      )}
    </Page>
  );
}

function messageOf(problem: unknown): string {
  return problem instanceof ApiError || problem instanceof Error ? problem.message : String(problem);
}

const PROVENANCE_BADGE: Record<
  SkillEntry["provenance"],
  { label: string; variant: "outline" | "warning" }
> = {
  bundled: { label: "bundled", variant: "outline" },
  "bundled-customized": { label: "customized — detached from updates", variant: "warning" },
  registry: { label: "registry", variant: "outline" },
  "registry-customized": { label: "registry, customized", variant: "warning" },
  local: { label: "yours", variant: "outline" },
};

function SkillCard({
  skill,
  update,
  onChanged,
}: {
  skill: SkillEntry;
  update: SkillUpdateStatus | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const badge = PROVENANCE_BADGE[skill.provenance];
  const isRegistry = skill.provenance === "registry" || skill.provenance === "registry-customized";

  const runUpdate = (force: boolean) => {
    setBusy(true);
    updateSkill(skill.name, force)
      .then(() => {
        toast.success(`Updated ${skill.name}`);
        onChanged();
      })
      .catch((problem: unknown) => toast.error(messageOf(problem)))
      .finally(() => setBusy(false));
  };

  return (
    <Card className={skill.problem ? "border-destructive/40" : undefined}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {skill.name}
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {update?.updateAvailable && <Badge variant="success">update available</Badge>}
        </CardTitle>
        <div className="flex items-center gap-1">
          {isRegistry &&
            (skill.provenance === "registry-customized" ? (
              <Confirm
                title={`Overwrite local edits to ${skill.name}?`}
                description="Updating replaces the skill with the upstream version; your local changes are lost."
                actionLabel="Overwrite & update"
                onConfirm={() => runUpdate(true)}
              >
                <Button size="icon" variant="ghost" aria-label="Update" title="Update (overwrites local edits)" disabled={busy}>
                  <RefreshCw />
                </Button>
              </Confirm>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Update"
                title="Update from source"
                disabled={busy}
                onClick={() => runUpdate(false)}
              >
                <RefreshCw />
              </Button>
            ))}
          {skill.restorable && skill.provenance !== "bundled" && (
            <Confirm
              title={`Restore ${skill.name} to the shipped version?`}
              description="Replaces the current copy with the original that ships with Nudge; it resumes receiving updates."
              actionLabel="Restore"
              onConfirm={() => {
                restoreSkill(skill.name)
                  .then(() => {
                    toast.success(`Restored ${skill.name}`);
                    onChanged();
                  })
                  .catch((problem: unknown) => toast.error(messageOf(problem)));
              }}
            >
              <Button size="icon" variant="ghost" aria-label="Restore shipped version" title="Restore shipped version">
                <ArchiveRestore />
              </Button>
            </Confirm>
          )}
          <Confirm
            title={`Delete ${skill.name}?`}
            description={
              skill.restorable
                ? "The agent loses this skill. It stays deleted on upgrades; you can restore it here later."
                : "The agent loses this skill. This cannot be undone."
            }
            actionLabel="Delete"
            onConfirm={() => {
              deleteSkill(skill.name)
                .then(() => {
                  toast.success(`Deleted ${skill.name}`);
                  onChanged();
                })
                .catch((problem: unknown) => toast.error(messageOf(problem)));
            }}
          >
            <Button
              size="icon"
              variant="ghost"
              aria-label="Delete"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </Confirm>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">{skill.description}</p>
        <p className="font-mono text-xs text-muted-foreground">
          v{skill.version}
          {skill.source && ` · ${skill.source}`}
          {` · ${skill.files.length} file${skill.files.length === 1 ? "" : "s"}`}
        </p>
        {skill.problem && <p className="text-xs text-destructive">{skill.problem}</p>}
        {update?.error && <p className="text-xs text-warning">{update.error}</p>}
      </CardContent>
    </Card>
  );
}

function InstallDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const install = () => {
    setBusy(true);
    setError(null);
    installSkill(source.trim())
      .then((installed) => {
        toast.success(`Installed ${installed.name}`);
        onDone();
      })
      .catch((problem: unknown) => {
        setBusy(false);
        setError(messageOf(problem));
      });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogTitle>Install a skill</DialogTitle>
        <DialogDescription>
          Paste a skills.sh identifier — owner/repo or owner/repo/skill-name — from a public GitHub
          repo. A skill's instructions become part of the agent's behavior, so install only sources
          you trust.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-2">
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="vercel-labs/agent-skills/frontend-design"
            className="font-mono"
            spellCheck={false}
            autoFocus
          />
          {error && (
            <p className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={install} disabled={busy || source.trim() === ""}>
              {busy ? "Installing…" : "Install"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
