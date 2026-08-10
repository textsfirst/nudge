import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Page } from "@/components/layout";
import { StatusDot } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStatus } from "@/lib/api";

export function OverviewPage() {
  const { data, isLoading } = useStatus();
  if (isLoading || !data) {
    return (
      <Page title="Overview">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }

  const rows: { label: string; ok: boolean; detail: string; to: string; hint?: string }[] = [
    {
      label: "Nudge server",
      ok: data.serverUp && data.serverHealthy,
      detail: !data.serverUp
        ? data.serverError ?? `Not responding on port ${data.serverPort} — start it with \`pnpm dev\``
        : !data.serverHealthy
          ? `Running on port ${data.serverPort}, but unhealthy: ${data.serverError ?? "check server logs"}`
          : data.serverError
            ? `Listening on port ${data.serverPort}; degraded: ${data.serverError}`
            : `Listening on port ${data.serverPort}`,
      to: "/config",
    },
    {
      label: "Configuration",
      ok: data.configValid,
      detail: data.configValid
        ? `owner_handle ${data.ownerHandle ?? "—"}`
        : data.configError ?? "Invalid",
      to: "/config",
    },
    {
      label: "Conversation history",
      ok: data.dbExists,
      detail: data.dbExists
        ? "SQLite database present"
        : "No database yet — it appears after the first message",
      to: "/threads",
    },
  ];

  return (
    <Page title="Overview" description={data.workspaceRoot}>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <Link key={row.label} to={row.to} className="group">
            <Card className="h-full transition-colors group-hover:border-ring/60">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2">
                  <StatusDot ok={row.ok} />
                  {row.label}
                </CardTitle>
                <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </CardHeader>
              <CardContent className="text-muted-foreground">{row.detail}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Data directory</CardTitle>
        </CardHeader>
        <CardContent className="font-mono text-xs text-muted-foreground">
          {data.dataDir}
        </CardContent>
      </Card>
    </Page>
  );
}
