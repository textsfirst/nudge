import { ArrowLeft, OctagonMinus, Trash2 } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Page } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import {
  deleteMessage,
  deleteThread,
  endThread,
  useInvalidate,
  useThread,
} from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";

export function ThreadDetailPage() {
  const { id } = useParams();
  const threadId = Number(id);
  const { data, isLoading } = useThread(threadId);
  const invalidate = useInvalidate();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <Page title="Thread">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Thread not found">
        <Button variant="outline" onClick={() => navigate("/threads")}>
          <ArrowLeft /> Back to threads
        </Button>
      </Page>
    );
  }

  const { session, messages } = data;
  const active = session.endedAt === null;

  return (
    <Page
      title={`Thread #${session.id}`}
      description={`${formatTime(session.startedAt)} → ${active ? "now" : formatTime(session.endedAt)}`}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => navigate("/threads")}>
            <ArrowLeft /> Back
          </Button>
          {active && (
            <Confirm
              title="End this thread?"
              description="Nudge starts a fresh thread on the next message. History is kept."
              actionLabel="End thread"
              onConfirm={() => {
                void endThread(session.id).then(() => {
                  invalidate("thread", "threads");
                  toast.success("Thread ended");
                });
              }}
            >
              <Button variant="outline" size="sm">
                <OctagonMinus /> End thread
              </Button>
            </Confirm>
          )}
          <Confirm
            title="Delete this thread?"
            description={`Permanently removes ${session.messageCount} messages from history and search.`}
            actionLabel="Delete"
            onConfirm={() => {
              void deleteThread(session.id).then(() => {
                invalidate("threads");
                toast.success("Thread deleted");
                navigate("/threads");
              });
            }}
          >
            <Button variant="destructive" size="sm">
              <Trash2 /> Delete
            </Button>
          </Confirm>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {active ? (
          <Badge variant="success">active</Badge>
        ) : (
          <Badge variant="outline">{session.endReason ?? "ended"}</Badge>
        )}
        {session.carryover && <span>carryover: “{session.carryover}”</span>}
      </div>

      {session.summary && (
        <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Compacted summary: </span>
          {session.summary}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages in this thread.</p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "group flex flex-col gap-1",
              message.role === "user" ? "items-end" : "items-start",
            )}
          >
            <div
              className={cn(
                "relative max-w-[75%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm",
                message.role === "user"
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm border border-border bg-card",
              )}
            >
              {message.content}
            </div>
            <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
              <span>{formatTime(message.createdAt)}</span>
              {message.toolCalls && message.toolCalls.length > 0 && (
                <details className="cursor-pointer">
                  <summary className="select-none">
                    {message.toolCalls.length} tool call{message.toolCalls.length > 1 ? "s" : ""}
                  </summary>
                  <pre className="mt-1 max-h-64 max-w-lg overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(message.toolCalls, null, 2)}
                  </pre>
                </details>
              )}
              <Confirm
                title="Delete this message?"
                description="Removes it from history and search. The agent will no longer see it."
                actionLabel="Delete"
                onConfirm={() => {
                  void deleteMessage(session.id, message.id).then(() => {
                    invalidate("thread", "threads", "search");
                    toast.success("Message deleted");
                  });
                }}
              >
                <button
                  type="button"
                  className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  aria-label="Delete message"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </Confirm>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
