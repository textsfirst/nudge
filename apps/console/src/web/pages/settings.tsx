import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import {
  ApiError,
  saveSettings,
  useInvalidate,
  useSettings,
  type SettingsField,
  type SettingsPayload,
  type SettingsSection,
} from "@/lib/api";

type FormValues = Record<string, string | boolean>;

function valueAt(settings: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      settings,
    );
}

/**
 * Optional fields start from their stored override (empty means "use the
 * default"), everything else from the effective value.
 */
function initialValues(payload: SettingsPayload): FormValues {
  const values: FormValues = {};
  for (const section of payload.form) {
    for (const field of section.fields) {
      if (field.control === "boolean") {
        values[field.path] = valueAt(payload.settings, field.path) === true;
      } else if (field.optional) {
        const override = payload.overrides[field.path];
        values[field.path] = override === undefined ? "" : String(override);
      } else {
        const value = valueAt(payload.settings, field.path);
        values[field.path] = value === undefined ? "" : String(value);
      }
    }
  }
  return values;
}

/** An empty input always means "back to the default" — the leaf is simply omitted. */
function buildSettings(form: SettingsSection[], values: FormValues): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const assign = (path: string, value: unknown) => {
    const parts = path.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Record<string, unknown>;
    }
    node[parts.at(-1) ?? path] = value;
  };
  for (const section of form) {
    for (const field of section.fields) {
      const raw = values[field.path];
      if (field.control === "boolean") {
        assign(field.path, raw === true);
        continue;
      }
      const text = String(raw ?? "").trim();
      if (text === "") continue;
      assign(field.path, field.control === "number" ? Number(text) : text);
    }
  }
  return root;
}

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const [draft, setDraft] = useState<FormValues | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidate();

  const initial = useMemo(() => (data ? initialValues(data) : null), [data]);
  const values = draft ?? initial;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(initial);

  if (isLoading || !data || !values) {
    return (
      <Page title="Settings">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }

  const setValue = (path: string, value: string | boolean) => {
    setDraft({ ...values, [path]: value });
  };

  const save = () => {
    setSaving(true);
    saveSettings(buildSettings(data.form, values))
      .then((result) => {
        setDraft(null);
        setIssues({});
        invalidate("settings", "status", "connections");
        toast.success("Settings saved", { description: result.note });
      })
      .catch((problem: unknown) => {
        if (problem instanceof ApiError && problem.issues.length > 0) {
          setIssues(Object.fromEntries(problem.issues.map((issue) => [issue.path, issue.message])));
        }
        toast.error(problem instanceof ApiError ? problem.message : String(problem));
      })
      .finally(() => setSaving(false));
  };

  return (
    <Page
      title="Settings"
      description="Stored in the database; the server reads them at boot. Secrets live on the Secrets page."
      actions={
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          <Save /> {saving ? "Saving…" : "Save"}
        </Button>
      }
    >
      {data.error && (
        <div className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {data.error}
        </div>
      )}
      {data.form.map((section) => (
        <Card key={section.title}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            {section.description && (
              <p className="text-sm text-muted-foreground">{section.description}</p>
            )}
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {section.fields.map((field) => (
              <FieldRow
                key={field.path}
                field={field}
                value={values[field.path] ?? ""}
                issue={issues[field.path]}
                onChange={(value) => setValue(field.path, value)}
              />
            ))}
          </CardContent>
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">
        Changes apply after a server restart.
      </p>
    </Page>
  );
}

function FieldRow({
  field,
  value,
  issue,
  onChange,
}: {
  field: SettingsField;
  value: string | boolean;
  issue: string | undefined;
  onChange: (value: string | boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="min-w-56 flex-1">
        <label htmlFor={field.path} className="text-sm font-medium">
          {field.label}
        </label>
        {field.help && <p className="mt-0.5 text-xs text-muted-foreground">{field.help}</p>}
        {issue && <p className="mt-0.5 text-xs text-destructive">{issue}</p>}
      </div>
      <div className="w-64 shrink-0">
        <FieldControl field={field} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: SettingsField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  if (field.control === "boolean") {
    return (
      <input
        id={field.path}
        type="checkbox"
        className="mt-1.5 size-4 accent-foreground"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (field.control === "select") {
    return (
      <Select
        id={field.path}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        {field.optional && <option value="">default</option>}
        {field.options?.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      id={field.path}
      type={field.control === "number" ? "number" : "text"}
      value={String(value)}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
