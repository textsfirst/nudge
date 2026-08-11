import { Link } from "react-router-dom";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useActivity, type ActivityEvent } from "@/lib/api";

/**
 * The dispatch/report feed — including everything curated to [SILENT], which
 * the texting surface deliberately hides. This is the "what did you decide
 * not to tell me" view; if something you wanted was silenced, this is where
 * you find out.
 */
export function ActivityPage() {
  const { data, error, isLoading } = useActivity();
  const events = data?.events ?? [];

  return (
    <Page
      title="Activity"
      description="Tasks handed to background agents, and their reports — with what the assistant decided you should hear."
    >
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{String(error)}</p>}
      {!isLoading && events.length === 0 && (
        <Card>
          <CardContent className="pt-3 text-muted-foreground">
            Nothing yet. Dispatches and agent reports show up here as they happen.
          </CardContent>
        </Card>
      )}
      <div className="flex flex-col gap-2">
        {events.map((event) => (
          <EventRow key={`${event.type}-${event.messageId}`} event={event} />
        ))}
      </div>
    </Page>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const time = new Date(event.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (event.type === "dispatch") {
    return (
      <Card>
        <CardContent className="flex flex-col gap-1 pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{event.scheduled ? "trigger" : "dispatch"}</Badge>
            <span className="font-medium text-foreground">{event.agentName}</span>
            <span>{time}</span>
          </div>
          <p className="line-clamp-2 whitespace-pre-wrap text-sm">{event.text}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge
            variant={
              event.outcome === "delivered"
                ? "success"
                : event.outcome === "silent"
                  ? "outline"
                  : "warning"
            }
          >
            report · {event.outcome}
          </Badge>
          {event.agentName && <span className="font-medium text-foreground">{event.agentName}</span>}
          <span>{time}</span>
          <Link
            to={`/threads/${event.sessionId}`}
            className="ml-auto text-primary underline-offset-2 hover:underline"
          >
            thread
          </Link>
        </div>
        <p className="line-clamp-3 whitespace-pre-wrap text-sm">{event.text}</p>
        {event.reply && (
          <p className="line-clamp-2 whitespace-pre-wrap border-l-2 border-border pl-2 text-sm text-muted-foreground">
            → {event.reply}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
