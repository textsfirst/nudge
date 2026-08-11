import { Link } from "react-router-dom";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgents, type AgentStats } from "@/lib/api";

/**
 * Read-only roster of execution agents — including the archived and retired
 * ones the texting surface never mentions. Each row links into the agent's
 * full session transcript on the Threads detail page.
 */
export function AgentsPage() {
  const { data, error, isLoading } = useAgents();
  const agents = data?.agents ?? [];
  const active = agents.filter((agent) => agent.status === "active");
  const past = agents.filter((agent) => agent.status !== "active");

  return (
    <Page
      title="Agents"
      description="Background workers the assistant dispatches tasks to. Standing agents keep their memory; temps retire after one report."
    >
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{String(error)}</p>}
      {!isLoading && agents.length === 0 && (
        <Card>
          <CardContent className="pt-3 text-muted-foreground">
            No agents yet. They appear when the assistant hands off its first background task.
          </CardContent>
        </Card>
      )}
      {active.length > 0 && <AgentList title="Active" agents={active} />}
      {past.length > 0 && <AgentList title="Archived & retired" agents={past} muted />}
    </Page>
  );
}

function AgentList({
  title,
  agents,
  muted,
}: {
  title: string;
  agents: AgentStats[];
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {agents.map((agent) => (
        <Card key={agent.id} className={muted ? "opacity-70" : undefined}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              {agent.name}
              <Badge variant={agent.kind === "standing" ? "default" : "outline"}>
                {agent.kind}
              </Badge>
              {agent.status !== "active" && <Badge variant="outline">{agent.status}</Badge>}
            </CardTitle>
            {agent.sessionId !== null && (
              <Link
                to={`/threads/${agent.sessionId}`}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                transcript
              </Link>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            {agent.description && <p className="text-sm">{agent.description}</p>}
            <p className="text-xs text-muted-foreground">
              last active {new Date(agent.lastActiveAt).toLocaleString()} · {agent.messageCount}{" "}
              messages · {formatTokens(agent.inputTokens)} in / {formatTokens(agent.outputTokens)}{" "}
              out
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
