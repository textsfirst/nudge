import { useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { ApiError, deleteSecret, setSecret, useInvalidate, useSecrets, type Secret } from "@/lib/api";

export function SecretsPage() {
  const { data, isLoading } = useSecrets();

  return (
    <Page
      title="Secrets"
      description=".env — write-only from here; values are never sent back to the browser. Restart the server to apply changes."
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {data?.secrets.map((secret) => <SecretRow key={secret.key} secret={secret} />)}
        </div>
      )}
      <AddCustomSecret />
    </Page>
  );
}

function SecretRow({ secret }: { secret: Secret }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();

  const submit = () => {
    if (!value) return;
    setBusy(true);
    setSecret(secret.key, value)
      .then(() => {
        setValue("");
        invalidate("secrets", "status", "connections");
        toast.success(`${secret.key} saved`, { description: "Restart the server to apply." });
      })
      .catch((problem: unknown) =>
        toast.error(problem instanceof ApiError ? problem.message : String(problem)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-52 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{secret.key}</span>
          {secret.set ? (
            <Badge variant="success">set</Badge>
          ) : secret.required ? (
            <Badge variant="destructive">required</Badge>
          ) : (
            <Badge variant="outline">unset</Badge>
          )}
        </div>
        {secret.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{secret.description}</p>
        )}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={secret.set ? "Replace value…" : "Set value…"}
          className="w-56 font-mono"
          autoComplete="off"
        />
        <Button type="submit" size="icon" variant="outline" disabled={!value || busy} aria-label="Save">
          <Check />
        </Button>
        {secret.set && (
          <Confirm
            title={`Remove ${secret.key}?`}
            description="Deletes the line from .env. Anything depending on it stops working after the next restart."
            actionLabel="Remove"
            onConfirm={() => {
              void deleteSecret(secret.key).then(() => {
                invalidate("secrets", "status", "connections");
                toast.success(`${secret.key} removed`);
              });
            }}
          >
            <Button size="icon" variant="ghost" aria-label="Delete" className="text-muted-foreground hover:text-destructive">
              <Trash2 />
            </Button>
          </Confirm>
        )}
      </form>
    </div>
  );
}

function AddCustomSecret() {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const invalidate = useInvalidate();

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setSecret(key.trim().toUpperCase(), value)
          .then(() => {
            setKey("");
            setValue("");
            invalidate("secrets");
            toast.success("Secret added");
          })
          .catch((problem: unknown) =>
            toast.error(problem instanceof ApiError ? problem.message : String(problem)),
          );
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="custom-key">
          Custom key
        </label>
        <Input
          id="custom-key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="MY_API_KEY"
          className="w-48 font-mono"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="custom-value">
          Value
        </label>
        <Input
          id="custom-value"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="w-56 font-mono"
          autoComplete="off"
        />
      </div>
      <Button type="submit" variant="outline" disabled={!key.trim() || !value}>
        <Plus /> Add
      </Button>
    </form>
  );
}
