import { useState } from "react";
import { Search } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSearch, useThreads } from "@/lib/api";
import { formatTime } from "@/lib/utils";

const PAGE_SIZE = 25;

export function ThreadsPage() {
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const threads = useThreads(offset, PAGE_SIZE);
  const search = useSearch(query);
  const navigate = useNavigate();

  return (
    <Page
      title="Threads"
      description="Every conversation, newest first. Threads roll over at midnight and after idle gaps."
      wide
    >
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search all history…"
          className="pl-8"
        />
      </div>

      {query.trim().length > 1 ? (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {search.data?.hits.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No messages match “{query}”.</p>
          )}
          {search.data?.hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={() => navigate(`/threads/${hit.sessionId}`)}
              className="flex flex-col gap-1 p-3 text-left transition-colors hover:bg-accent"
            >
              <span className="text-xs text-muted-foreground">
                {hit.role} · {formatTime(hit.createdAt)} · thread #{hit.sessionId}
              </span>
              <span className="line-clamp-2 text-sm">{hit.content}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Thread</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Messages</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Last message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {threads.data?.sessions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                      No threads yet — text your Nudge number to start one.
                    </td>
                  </tr>
                )}
                {threads.data?.sessions.map((session) => (
                  <tr
                    key={session.id}
                    onClick={() => navigate(`/threads/${session.id}`)}
                    className="cursor-pointer transition-colors hover:bg-accent"
                  >
                    <td className="px-3 py-2.5 font-mono text-xs">#{session.id}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{formatTime(session.startedAt)}</td>
                    <td className="px-3 py-2.5">
                      {session.endedAt === null ? (
                        <Badge variant="success">active</Badge>
                      ) : (
                        <Badge variant="outline">{session.endReason ?? "ended"}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{session.messageCount}</td>
                    <td className="hidden max-w-md truncate px-3 py-2.5 text-muted-foreground md:table-cell">
                      {session.preview ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(threads.data?.total ?? 0) > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {offset + 1}–{Math.min(offset + PAGE_SIZE, threads.data?.total ?? 0)} of{" "}
                {threads.data?.total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= (threads.data?.total ?? 0)}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Looking for a specific thread?{" "}
        <Link to="/threads" className="underline underline-offset-2">
          Search
        </Link>{" "}
        covers every message ever exchanged.
      </p>
    </Page>
  );
}
