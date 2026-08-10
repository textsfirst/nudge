import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Editor } from "@/components/editor";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, saveConfig, useConfig, useInvalidate, validateConfig } from "@/lib/api";

export function ConfigPage() {
  const { data, isLoading } = useConfig();
  const [draft, setDraft] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; error: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidate();

  const content = draft ?? data?.content ?? "";
  const dirty = draft !== null && draft !== data?.content;

  // Live validation, debounced against the same schema the server boots with.
  useEffect(() => {
    if (draft === null) return;
    const timer = setTimeout(() => {
      validateConfig(draft).then(setValidation).catch(() => setValidation(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft]);

  const save = () => {
    setSaving(true);
    saveConfig(content)
      .then((result) => {
        setDraft(null);
        invalidate("config", "status");
        toast.success("Saved nudge.config.yaml", { description: result.note });
      })
      .catch((problem: unknown) => {
        toast.error(problem instanceof ApiError ? problem.message : String(problem));
      })
      .finally(() => setSaving(false));
  };

  if (isLoading) {
    return (
      <Page title="Config">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }

  const problem = dirty ? validation?.error : data?.error ?? null;
  const valid = dirty ? validation?.valid !== false : data?.valid !== false;

  return (
    <Page
      title="Config"
      description="nudge.config.yaml — settings, not secrets. The server reads it at boot."
      wide
      actions={
        <>
          {valid ? (
            <Badge variant="success">valid</Badge>
          ) : (
            <Badge variant="destructive">invalid</Badge>
          )}
          <Button size="sm" onClick={save} disabled={!dirty || saving || !valid}>
            <Save /> {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {!data?.exists && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
          nudge.config.yaml does not exist yet — saving here creates it.
        </div>
      )}
      {problem && (
        <div className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs text-destructive">
          {problem}
        </div>
      )}
      <div className="min-h-[60vh] overflow-hidden rounded-lg border border-border">
        <Editor value={content} onChange={(value) => setDraft(value)} language="yaml" />
      </div>
      <p className="text-xs text-muted-foreground">
        Changes apply after a server restart. Key reference lives in the project README.
      </p>
    </Page>
  );
}
