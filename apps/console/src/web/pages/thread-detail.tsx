import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bug,
  Check,
  ChevronDown,
  Copy,
  OctagonMinus,
  Scissors,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
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
  type ThreadMessage,
} from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";

const DEBUG_KEY = "nudge.console.thread-debug";

export function ThreadDetailPage() {
  const { id } = useParams();
  const threadId = Number(id);
  const { data, isLoading } = useThread(threadId);
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [debug, setDebug] = useState(() => localStorage.getItem(DEBUG_KEY) === "1");

  const toggleDebug = () => {
    setDebug((on) => {
      localStorage.setItem(DEBUG_KEY, on ? "0" : "1");
      return !on;
    });
  };

  // Follow-scroll: jump to the latest message when an active thread opens, then
  // stick to the bottom as new messages poll in — but only while the user is
  // already near the bottom, so scrolling up to read is never interrupted.
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const seenCountRef = useRef<number | null>(null);
  // In-flight tool steps count toward growth so the live trace also follows.
  const messageCount =
    (data?.messages.length ?? 0) + (data?.progress ? 1 + data.progress.toolCalls.length : 0);
  const isActive = data ? data.session.endedAt === null : false;

  useEffect(() => {
    seenCountRef.current = null;
  }, [threadId]);

  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement;
      if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!data) return;
    if (seenCountRef.current === null) {
      if (isActive) endRef.current?.scrollIntoView({ block: "end" });
    } else if (messageCount > seenCountRef.current && followRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    seenCountRef.current = messageCount;
  }, [data, isActive, messageCount]);

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

  const { session, messages, progress } = data;
  const active = session.endedAt === null;
  const userCount = messages.filter((m) => m.role === "user").length;
  const errorCount = messages.filter((m) => m.role === "error").length;
  const toolCallCount = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
  const compactedCount = messages.filter((m) => m.id <= session.compactedThrough).length;
  // Index of the last message the agent no longer sees; the divider renders after it.
  const compactionBoundary =
    compactedCount > 0 && compactedCount < messages.length ? compactedCount - 1 : -1;

  return (
    <Page
      title={`Thread #${session.id}`}
      description={`${formatTime(session.startedAt)} → ${active ? "now" : formatTime(session.endedAt)}`}
      actions={
        <>
          <Button
            variant={debug ? "default" : "outline"}
            size="sm"
            onClick={toggleDebug}
            aria-pressed={debug}
          >
            <Bug /> Debug
          </Button>
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
            description={`Permanently removes ${messages.length} messages from history and search.`}
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        {active ? (
          <Badge variant="success" title="Updates live every few seconds">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
            live
          </Badge>
        ) : (
          <Badge variant="outline">{session.endReason ?? "ended"}</Badge>
        )}
        <span className="font-mono">{session.handle}</span>
        <span>
          {messages.length} message{messages.length === 1 ? "" : "s"} · {userCount} user /{" "}
          {messages.length - userCount - errorCount} assistant
        </span>
        {errorCount > 0 && (
          <span className="text-destructive">
            {errorCount} error{errorCount === 1 ? "" : "s"}
          </span>
        )}
        {toolCallCount > 0 && (
          <span>
            {toolCallCount} tool call{toolCallCount === 1 ? "" : "s"}
          </span>
        )}
        {session.lastActivityAt > session.startedAt && (
          <span>{formatDelta(session.lastActivityAt - session.startedAt)} span</span>
        )}
        {session.compactedThrough > 0 && (
          <span title="The agent only sees messages after this id; earlier ones are folded into the summary.">
            compacted through #{session.compactedThrough}
          </span>
        )}
        {session.carryover && <span>carryover: “{session.carryover}”</span>}
      </div>

      {session.summary && (
        <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            Compacted summary
            {compactedCount > 0 && ` (replaces ${compactedCount} message${compactedCount === 1 ? "" : "s"})`}
            :{" "}
          </span>
          {session.summary}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages in this thread.</p>
        )}
        {messages.map((message, index) => (
          <div key={message.id} className="contents">
            <MessageItem
              message={message}
              debug={debug}
              compacted={message.id <= session.compactedThrough}
              previousAt={index > 0 ? messages[index - 1]!.createdAt : null}
              onDelete={() => {
                void deleteMessage(session.id, message.id).then(() => {
                  invalidate("thread", "threads", "search");
                  toast.success("Message deleted");
                });
              }}
            />
            {index === compactionBoundary && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <div className="h-px flex-1 border-t border-dashed border-border" />
                <Scissors className="size-3" />
                <span>compacted into summary · agent context starts below</span>
                <div className="h-px flex-1 border-t border-dashed border-border" />
              </div>
            )}
          </div>
        ))}
        {active && progress && (
          <div className="flex flex-col items-start gap-1.5">
            {progress.toolCalls.length > 0 && <ToolSteps calls={progress.toolCalls} />}
            <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              <span>
                working on a reply · {formatDelta(Date.now() - progress.startedAt)}
                {progress.toolCalls.length > 0 &&
                  ` · ${progress.toolCalls.length} tool call${progress.toolCalls.length === 1 ? "" : "s"} so far`}
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} aria-hidden />
      </div>
    </Page>
  );
}

function formatTokens(count: number): string {
  return count >= 10_000
    ? `${Math.round(count / 1000)}k`
    : count >= 1_000
      ? `${(count / 1000).toFixed(1)}k`
      : String(count);
}

/**
 * Interruption notes ("[This turn failed… Tool calls that already ran: …]")
 * repeat the tool trace as text because the model's history replay is
 * text-only. The timeline above the bubble already renders those calls, so
 * show just the lead sentence.
 */
function interruptionLead(content: string): string | null {
  const match = /^\[(.+?) Tool calls that already ran: /.exec(content);
  return match ? match[1]! : null;
}

function MessageItem({
  message,
  debug,
  compacted,
  previousAt,
  onDelete,
}: {
  message: ThreadMessage;
  debug: boolean;
  compacted: boolean;
  previousAt: number | null;
  onDelete: () => void;
}) {
  const mine = message.role === "user";
  return (
    <div
      className={cn(
        "group flex flex-col gap-1.5",
        mine ? "items-end" : "items-start",
        debug && compacted && "opacity-60",
      )}
    >
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolSteps calls={message.toolCalls} />
      )}
      {mine ? (
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      ) : message.role === "error" ? (
        <div
          className="flex max-w-[85%] items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2 text-sm text-destructive"
          title="The reply failed; the owner got an apology text instead."
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      ) : interruptionLead(message.content) ? (
        <div className="max-w-[85%] text-sm italic leading-relaxed text-muted-foreground">
          {interruptionLead(message.content)}
        </div>
      ) : (
        message.content && (
          <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </div>
        )
      )}
      <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
        <span title={new Date(message.createdAt).toISOString()}>
          {formatTime(message.createdAt)}
        </span>
        {message.inputTokens !== null && (
          <span title="Model tokens this turn: context sent in · reply and reasoning out">
            {formatTokens(message.inputTokens)} in
            {message.outputTokens !== null && ` · ${formatTokens(message.outputTokens)} out`}
          </span>
        )}
        {message.role === "error" && !debug && (
          <button
            type="button"
            className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            aria-label="Copy error text"
            onClick={() => {
              void navigator.clipboard
                .writeText(message.content)
                .then(() => toast.success("Error copied"));
            }}
          >
            <Copy className="size-3" />
          </button>
        )}
        {debug && (
          <span className="flex items-center gap-2 font-mono text-[10px]">
            <span>#{message.id}</span>
            {previousAt !== null && <span>+{formatDelta(message.createdAt - previousAt)}</span>}
            <span>{message.content.length} chars</span>
            <button
              type="button"
              className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              aria-label="Copy message as JSON"
              onClick={() => {
                void navigator.clipboard
                  .writeText(JSON.stringify(message, null, 2))
                  .then(() => toast.success("Message JSON copied"));
              }}
            >
              <Copy className="size-3" />
            </button>
          </span>
        )}
        <Confirm
          title="Delete this message?"
          description="Removes it from history and search. The agent will no longer see it."
          actionLabel="Delete"
          onConfirm={onDelete}
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
  );
}

/**
 * Tool calls rendered as a step timeline (ai-elements style): a vertical rail
 * connects one row per call, each expanding to INPUT / OUTPUT sections.
 */
function ToolSteps({ calls }: { calls: NonNullable<ThreadMessage["toolCalls"]> }) {
  return (
    <div className="relative w-full max-w-[85%]">
      <div aria-hidden className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />
      {calls.map((call, index) => (
        <details key={index} className="group/step relative">
          <summary className="flex cursor-pointer select-none list-none items-center gap-2 rounded-md py-1 pr-1.5 text-xs transition-colors hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
            <span className="relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
              <Wrench className="size-3" />
            </span>
            <span className="shrink-0 font-mono font-medium">{call.tool}</span>
            <span className="truncate font-mono text-muted-foreground/70">
              {inputHint(call.input)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
              {call.output === undefined ? (
                <span className="text-[10px] text-warning">no output</span>
              ) : (
                <Check className="size-3 text-success" />
              )}
              <ChevronDown className="size-3.5 transition-transform group-open/step:rotate-180" />
            </span>
          </summary>
          <div className="mb-1.5 ml-[30px] flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2.5">
            <ToolPart label="input" value={call.input} />
            <ToolPart label="output" value={call.output} />
          </div>
        </details>
      ))}
    </div>
  );
}

function ToolPart({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
        {formatToolValue(value)}
      </pre>
    </div>
  );
}

/** Compact single-line preview of a call's input, shown in the step row. */
function inputHint(input: unknown): string {
  if (input === undefined || input === null) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function formatToolValue(value: unknown): string {
  if (value === undefined) return "not recorded";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function formatDelta(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
