import { useState } from "react";
import { FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import {
  ApiError,
  deleteMcpServer,
  saveMcpServer,
  testMcpServer,
  useInvalidate,
  useMcp,
  type McpServerConfig,
  type McpServerView,
  type McpTestResult,
} from "@/lib/api";

/**
 * Typed editor over DATA_DIR/mcp/servers.json. The file stays the source of
 * truth (the agent edits it too) — this section is a lens: entry-scoped saves
 * carry the loaded entry's hash so a concurrent agent edit surfaces as a
 * conflict instead of being overwritten.
 */

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function McpSection() {
  const { data } = useMcp();
  const [editor, setEditor] = useState<{ existing: McpServerView | null } | null>(null);

  if (!data) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">MCP servers</h2>
        <Button size="sm" onClick={() => setEditor({ existing: null })}>
          <Plus /> Add server
        </Button>
      </div>

      {data.error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-3 text-muted-foreground">
            <span className="font-mono text-xs">{data.path}</span> is invalid — {data.error}. Fix
            it on the{" "}
            <Link to="/files" className="text-primary underline-offset-2 hover:underline">
              Files page
            </Link>{" "}
            to manage servers here.
          </CardContent>
        </Card>
      )}

      {!data.error && data.servers.length === 0 && (
        <Card>
          <CardContent className="pt-3 text-muted-foreground">
            No MCP servers yet. “Add server” connects the agent to an MCP server — a hosted one
            over HTTP, or a local command. The agent reaches them through the{" "}
            <span className="font-mono text-xs">mcp</span> CLI in bash.
          </CardContent>
        </Card>
      )}

      {data.servers.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.servers.map((server) => (
            <McpServerCard
              key={server.name}
              server={server}
              onEdit={() => setEditor({ existing: server })}
            />
          ))}
        </div>
      )}

      {editor && <McpServerDialog existing={editor.existing} onClose={() => setEditor(null)} />}
    </section>
  );
}

function McpServerCard({ server, onEdit }: { server: McpServerView; onEdit: () => void }) {
  const invalidate = useInvalidate();
  const [test, setTest] = useState<{ running: boolean; result: McpTestResult | null }>({
    running: false,
    result: null,
  });
  const { config } = server;
  const summary =
    config.transport === "http" ? config.url : [config.command, ...config.args].join(" ");

  const runTest = () => {
    setTest({ running: true, result: null });
    testMcpServer(server.name)
      .then((result) => setTest({ running: false, result }))
      .catch((problem: unknown) =>
        setTest({
          running: false,
          result: {
            ok: false,
            error: problem instanceof ApiError ? problem.message : String(problem),
          },
        }),
      );
  };

  const toggle = () => {
    saveMcpServer(server.name, { ...config, enabled: !config.enabled }, server.hash)
      .then(() => {
        invalidate("mcp");
        toast.success(`${server.name} ${config.enabled ? "disabled" : "enabled"}`);
      })
      .catch((problem: unknown) =>
        toast.error(problem instanceof ApiError ? problem.message : String(problem)),
      );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          {server.name}
          <Badge variant="outline">{config.transport}</Badge>
          {!config.enabled && <Badge variant="warning">disabled</Badge>}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Test connection"
            title="Test connection"
            disabled={test.running}
            onClick={runTest}
          >
            <FlaskConical />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Edit" title="Edit" onClick={onEdit}>
            <Pencil />
          </Button>
          <Confirm
            title={`Delete ${server.name}?`}
            description="Removes the entry from mcp/servers.json. Secrets in .env are untouched."
            actionLabel="Delete"
            onConfirm={() => {
              void deleteMcpServer(server.name)
                .then(() => {
                  invalidate("mcp");
                  toast.success(`${server.name} deleted`);
                })
                .catch((problem: unknown) =>
                  toast.error(problem instanceof ApiError ? problem.message : String(problem)),
                );
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
      <CardContent className="flex flex-col gap-2">
        <p className="truncate font-mono text-xs text-muted-foreground" title={summary}>
          {summary}
        </p>
        {server.envRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {server.envRefs.map((ref) =>
              ref.set ? (
                <Badge key={ref.name} variant="outline" className="font-mono">
                  ${ref.name}
                </Badge>
              ) : (
                <Link key={ref.name} to="/secrets" title={`Set ${ref.name} on the Secrets page`}>
                  <Badge variant="destructive" className="font-mono">
                    ${ref.name} not set
                  </Badge>
                </Link>
              ),
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggle}
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {config.enabled ? "Disable" : "Enable"}
          </button>
          {test.running && <span className="text-xs text-muted-foreground">Connecting…</span>}
        </div>
        {test.result && (
          <div
            className={
              test.result.ok
                ? "rounded-md border border-success/40 bg-success/5 p-2 text-xs"
                : "whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
            }
          >
            {test.result.ok ? (
              <>
                Connected — {test.result.tools?.length ?? 0} tools
                {test.result.truncated && "+"}
                {(test.result.tools?.length ?? 0) > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({test.result.tools
                      ?.slice(0, 6)
                      .map((tool) => tool.name)
                      .join(", ")}
                    {(test.result.tools?.length ?? 0) > 6 && ", …"})
                  </span>
                )}
              </>
            ) : (
              test.result.error
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// -- add / edit dialog ------------------------------------------------------

type KeyValueRow = { key: string; value: string };

function rowsFromRecord(record: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

function recordFromRows(rows: KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value] as const)
    .filter(([key]) => key !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function McpServerDialog({
  existing,
  onClose,
}: {
  existing: McpServerView | null;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const config = existing?.config ?? null;
  const [name, setName] = useState(existing?.name ?? "");
  const [transport, setTransport] = useState<"http" | "stdio">(config?.transport ?? "http");
  const [url, setUrl] = useState(config?.transport === "http" ? config.url : "");
  const [headers, setHeaders] = useState<KeyValueRow[]>(
    rowsFromRecord(config?.transport === "http" ? config.headers : undefined),
  );
  const [command, setCommand] = useState(config?.transport === "stdio" ? config.command : "");
  const [argsText, setArgsText] = useState(
    config?.transport === "stdio" ? config.args.join("\n") : "",
  );
  const [env, setEnv] = useState<KeyValueRow[]>(
    rowsFromRecord(config?.transport === "stdio" ? config.env : undefined),
  );
  const [cwd, setCwd] = useState((config?.transport === "stdio" && config.cwd) || "");
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const compose = (): McpServerConfig => {
    if (transport === "http") {
      const headerRecord = recordFromRows(headers);
      return {
        transport,
        url: url.trim(),
        ...(headerRecord ? { headers: headerRecord } : {}),
        enabled,
      };
    }
    const envRecord = recordFromRows(env);
    return {
      transport,
      command: command.trim(),
      args: argsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      ...(envRecord ? { env: envRecord } : {}),
      ...(cwd.trim() !== "" ? { cwd: cwd.trim() } : {}),
      enabled,
    };
  };

  const valid =
    NAME_PATTERN.test(name.trim()) &&
    (transport === "http" ? url.trim() !== "" : command.trim() !== "");

  const save = () => {
    setBusy(true);
    saveMcpServer(name.trim(), compose(), existing?.hash ?? null)
      .then(() => {
        invalidate("mcp");
        toast.success(`${existing ? "Saved" : "Added"} ${name.trim()}`);
        onClose();
      })
      .catch((problem: unknown) => {
        setBusy(false);
        setError(problem instanceof ApiError ? problem.message : String(problem));
      });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{existing ? `Edit ${existing.name}` : "Add an MCP server"}</DialogTitle>
        <DialogDescription>
          Secrets never go in this form — reference them as{" "}
          <span className="font-mono text-xs">{"${MY_TOKEN}"}</span> and set the value on the{" "}
          <Link to="/secrets" className="text-primary underline-offset-2 hover:underline">
            Secrets page
          </Link>
          .
        </DialogDescription>

        <div className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value.toLowerCase())}
                placeholder="github"
                className="font-mono"
                disabled={existing !== null}
                autoFocus={existing === null}
              />
            </Field>
            <Field label="Transport">
              <Select
                value={transport}
                onChange={(event) => setTransport(event.target.value as "http" | "stdio")}
              >
                <option value="http">http</option>
                <option value="stdio">stdio</option>
              </Select>
            </Field>
          </div>
          {!NAME_PATTERN.test(name.trim()) && name.trim() !== "" && (
            <p className="text-xs text-destructive">
              Names are short lowercase slugs like “github”.
            </p>
          )}

          {transport === "http" ? (
            <>
              <Field label="URL">
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://api.githubcopilot.com/mcp/"
                  className="font-mono"
                  spellCheck={false}
                />
              </Field>
              <KeyValueEditor
                label="Headers"
                rows={headers}
                onChange={setHeaders}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer ${GITHUB_MCP_TOKEN}"
              />
            </>
          ) : (
            <>
              <Field label="Command">
                <Input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="npx"
                  className="font-mono"
                  spellCheck={false}
                />
              </Field>
              <Field label="Arguments (one per line)">
                <Textarea
                  value={argsText}
                  onChange={(event) => setArgsText(event.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-memory"}
                  className="min-h-20 font-mono text-xs"
                  spellCheck={false}
                />
              </Field>
              <KeyValueEditor
                label="Environment"
                rows={env}
                onChange={setEnv}
                keyPlaceholder="API_TOKEN"
                valuePlaceholder="${MY_TOKEN}"
              />
              <Field label="Working directory (optional)">
                <Input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  className="font-mono"
                  spellCheck={false}
                />
              </Field>
            </>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled — the agent may use this server
          </label>

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
          <Button onClick={save} disabled={!valid || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function KeyValueEditor({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_1.4fr_32px] items-center gap-1">
          <Input
            value={row.key}
            onChange={(event) => {
              const next = [...rows];
              next[index] = { ...row, key: event.target.value };
              onChange(next);
            }}
            placeholder={keyPlaceholder}
            className="font-mono text-xs"
            spellCheck={false}
          />
          <Input
            value={row.value}
            onChange={(event) => {
              const next = [...rows];
              next[index] = { ...row, value: event.target.value };
              onChange(next);
            }}
            placeholder={valuePlaceholder}
            className="font-mono text-xs"
            spellCheck={false}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove ${label.toLowerCase()} row`}
            onClick={() => onChange(rows.filter((_, other) => other !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus /> Add {label === "Headers" ? "header" : "variable"}
      </Button>
    </div>
  );
}
