import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  Copy,
  OctagonMinus,
  Paperclip,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  deleteMessage,
  deleteThread,
  endThread,
  useInvalidate,
  useThread,
  type MessageAttachment,
  type MessageMetrics,
  type ThreadMessage,
} from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";

export function ThreadDetailPage() {
  const { id } = useParams();
  const threadId = Number(id);
  const { data, isLoading } = useThread(threadId);
  const invalidate = useInvalidate();
  const navigate = useNavigate();

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

      <ThreadStats messages={messages} />

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

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** Inbound media under its message: thumbnails, a voice player, file chips. */
function AttachmentItem({ attachment }: { attachment: MessageAttachment }) {
  const url = `/api/attachments/${attachment.id}/content`;
  if (attachment.status === "failed" || !attachment.hasContent) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
        <TriangleAlert className="size-3" />
        {attachment.name} — never arrived
      </div>
    );
  }
  if (attachment.kind === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer" title={attachment.caption ?? attachment.name}>
        <img
          src={url}
          alt={attachment.caption ?? attachment.name}
          loading="lazy"
          className="max-h-48 max-w-[240px] rounded-xl border object-cover"
        />
      </a>
    );
  }
  if (attachment.kind === "voice") {
    return (
      <div className="flex flex-col gap-1">
        {/* biome-ignore lint/a11y/useMediaCaption: the transcript is rendered below */}
        <audio controls preload="none" src={url} className="h-9 max-w-[240px]" />
      </div>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs hover:bg-muted"
    >
      <Paperclip className="size-3" />
      {attachment.name}
      <span className="text-muted-foreground">{formatSize(attachment.sizeBytes)}</span>
    </a>
  );
}

function MessageItem({
  message,
  compacted,
  previousAt,
  onDelete,
}: {
  message: ThreadMessage;
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
        compacted && "opacity-60",
      )}
    >
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolSteps calls={message.toolCalls} />
      )}
      {message.attachments.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", mine ? "justify-end" : "justify-start")}>
          {message.attachments.map((attachment) => (
            <AttachmentItem key={attachment.id} attachment={attachment} />
          ))}
        </div>
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
        {message.role === "error" && (
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
        <MetricsPopover message={message} previousAt={previousAt} />
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
              {call.durationMs !== undefined && (
                <span className="font-mono text-[10px]" title="Tool execution time">
                  {formatDelta(call.durationMs)}
                </span>
              )}
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

/** Sub-minute times keep a decimal (TTFT reads as "1.4s", not "1s"). */
function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return formatDelta(ms);
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatTps(tps: number): string {
  return `${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

/** Nearest-rank quantile of an unsorted sample. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

/** Sum, skipping undefined/null; undefined when nothing contributed. */
function sumDefined(values: Array<number | undefined | null>): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value !== undefined && value !== null) total = (total ?? 0) + value;
  }
  return total;
}

function cacheHitRate(metrics: {
  cacheReadTokens?: number;
  inputTokensTotal?: number;
}): number | undefined {
  return metrics.cacheReadTokens !== undefined &&
    metrics.inputTokensTotal !== undefined &&
    metrics.inputTokensTotal > 0
    ? metrics.cacheReadTokens / metrics.inputTokensTotal
    : undefined;
}

function MetricRow({
  label,
  value,
  title,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
}) {
  if (value === undefined || value === null) return null;
  return (
    <>
      <dt className="text-muted-foreground" {...(title ? { title } : {})}>
        {label}
      </dt>
      <dd className="text-right font-mono">{value}</dd>
    </>
  );
}

function MetricHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="col-span-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground first:pt-0">
      {children}
    </div>
  );
}

function StepTimingList({ timings }: { timings: NonNullable<MessageMetrics["stepTimings"]> }) {
  return (
    <div className="col-span-2 flex flex-col gap-1.5">
      {timings.map((timing) => (
        <div key={timing.step} className="rounded-md border border-border bg-muted/30 p-2">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px]">
            <span className="font-medium text-foreground">step {timing.step}</span>
            <span className="text-muted-foreground">{timing.finishReason}</span>
            {timing.toolCalls && timing.toolCalls.length > 0 && (
              <span
                className="ml-auto truncate text-muted-foreground"
                title={timing.toolCalls.join(", ")}
              >
                {timing.toolCalls.join(", ")}
              </span>
            )}
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] sm:grid-cols-3">
            <span title="Time to this step's first output">
              TTFT {timing.ttftMs !== undefined ? formatMs(timing.ttftMs) : "–"}
            </span>
            <span title="Time waiting for this model response">
              model {formatMs(timing.modelMs)}
            </span>
            <span title="Whole step including client-side tools">
              total {formatMs(timing.durationMs)}
            </span>
            {timing.toolMs !== undefined && <span>tools {formatMs(timing.toolMs)}</span>}
            {timing.outputTps !== undefined && <span>{formatTps(timing.outputTps)}</span>}
            {(timing.inputTokens !== undefined || timing.outputTokens !== undefined) && (
              <span title="Input and output tokens for this model call">
                {timing.inputTokens !== undefined ? formatTokens(timing.inputTokens) : "–"} →{" "}
                {timing.outputTokens !== undefined ? formatTokens(timing.outputTokens) : "–"}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The on-demand home for everything that used to bloat the meta row: a small
 * chart icon (visible on hover) opens the turn's full metrics.
 */
function MetricsPopover({
  message,
  previousAt,
}: {
  message: ThreadMessage;
  previousAt: number | null;
}) {
  const m = message.metrics;
  const hitRate = m ? cacheHitRate(m) : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 data-[state=open]:text-foreground data-[state=open]:opacity-100"
          aria-label="Message details"
        >
          <ChartNoAxesColumn className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[calc(100vh-2rem)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto text-[11px]">
        {m && (
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1">
            <MetricHeading>Model</MetricHeading>
            <MetricRow label="model" value={m.modelId} />
            <MetricRow label="source" value={m.provider} />
            <MetricRow label="finish" value={m.finishReason} />
            <MetricHeading>Latency</MetricHeading>
            <MetricRow
              label="first TTFT"
              title="Time to the first output chunk of the turn's first step"
              value={m.ttftMs !== undefined ? formatMs(m.ttftMs) : undefined}
            />
            <MetricRow
              label="speed"
              title="Output tokens per second, weighted across steps"
              value={m.outputTps !== undefined ? formatTps(m.outputTps) : undefined}
            />
            <MetricRow
              label="total time"
              value={m.durationMs !== undefined ? formatMs(m.durationMs) : undefined}
            />
            <MetricRow
              label="model time"
              title="Time waiting for model responses across all steps"
              value={m.modelMs !== undefined ? formatMs(m.modelMs) : undefined}
            />
            <MetricRow
              label="tool time"
              value={m.toolMs !== undefined ? formatMs(m.toolMs) : undefined}
            />
            <MetricRow label="steps" value={m.steps} />
            <MetricRow label="retries" value={m.retries} />
            {m.stepTimings && m.stepTimings.length > 0 && (
              <>
                <MetricHeading>Model steps</MetricHeading>
                <StepTimingList timings={m.stepTimings} />
              </>
            )}
            <MetricHeading>Tokens</MetricHeading>
            <MetricRow
              label="in (context)"
              title="Prompt tokens of the final step — the turn's context watermark"
              value={message.inputTokens !== null ? formatTokens(message.inputTokens) : undefined}
            />
            <MetricRow
              label="in (billed)"
              title="Prompt tokens summed across all steps of the turn"
              value={
                m.inputTokensTotal !== undefined ? formatTokens(m.inputTokensTotal) : undefined
              }
            />
            <MetricRow
              label="out"
              value={message.outputTokens !== null ? formatTokens(message.outputTokens) : undefined}
            />
            <MetricRow
              label="reasoning"
              value={
                m.reasoningTokens !== undefined ? formatTokens(m.reasoningTokens) : undefined
              }
            />
            <MetricRow
              label="cache read"
              value={
                m.cacheReadTokens !== undefined ? formatTokens(m.cacheReadTokens) : undefined
              }
            />
            <MetricRow
              label="cache write"
              value={
                m.cacheWriteTokens !== undefined ? formatTokens(m.cacheWriteTokens) : undefined
              }
            />
            <MetricRow
              label="cache hit"
              title="Cache-read share of billed prompt tokens"
              value={hitRate !== undefined ? formatPercent(hitRate) : undefined}
            />
          </dl>
        )}
        <div
          className={cn(
            "flex items-center gap-2 font-mono text-[10px] text-muted-foreground",
            m && "mt-2.5 border-t border-border pt-2",
          )}
        >
          <span>#{message.id}</span>
          {previousAt !== null && <span>+{formatDelta(message.createdAt - previousAt)}</span>}
          <span>{message.content.length} chars</span>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 transition-colors hover:text-foreground"
            aria-label="Copy message as JSON"
            onClick={() => {
              void navigator.clipboard
                .writeText(JSON.stringify(message, null, 2))
                .then(() => toast.success("Message JSON copied"));
            }}
          >
            <Copy className="size-3" /> JSON
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Thread-wide rollup of the per-turn metrics: the collapsed summary is itself
 * a one-line KPI row, so expanding is only for the breakdown.
 */
function ThreadStats({ messages }: { messages: ThreadMessage[] }) {
  const turns = messages.filter(
    (message): message is ThreadMessage & { metrics: MessageMetrics } => message.metrics !== null,
  );
  if (turns.length === 0) return null;

  const inputTotal = sumDefined(turns.map((turn) => turn.metrics.inputTokensTotal));
  const outputTotal = sumDefined(turns.map((turn) => turn.outputTokens));
  const reasoningTotal = sumDefined(turns.map((turn) => turn.metrics.reasoningTokens));
  const cacheRead = sumDefined(turns.map((turn) => turn.metrics.cacheReadTokens));
  const cacheWrite = sumDefined(turns.map((turn) => turn.metrics.cacheWriteTokens));
  const hitRate =
    cacheRead !== undefined && inputTotal !== undefined && inputTotal > 0
      ? cacheRead / inputTotal
      : undefined;
  const ttfts = turns.flatMap((turn) => {
    const perStep = turn.metrics.stepTimings
      ?.map((step) => step.ttftMs)
      .filter((value): value is number => value !== undefined);
    // Pre-upgrade rows only have the first-step aggregate.
    return perStep && perStep.length > 0
      ? perStep
      : turn.metrics.ttftMs !== undefined
        ? [turn.metrics.ttftMs]
        : [];
  });
  const totalTime = sumDefined(turns.map((turn) => turn.metrics.durationMs));
  const modelTime = sumDefined(turns.map((turn) => turn.metrics.modelMs));
  const toolTime = sumDefined(turns.map((turn) => turn.metrics.toolMs));
  const retries = sumDefined(turns.map((turn) => turn.metrics.retries));

  // Same output-weighted rate as the per-turn metric, extended across turns.
  let weightedOut = 0;
  let weightedSeconds = 0;
  for (const turn of turns) {
    const tps = turn.metrics.outputTps;
    if (turn.outputTokens !== null && turn.outputTokens > 0 && tps !== undefined && tps > 0) {
      weightedOut += turn.outputTokens;
      weightedSeconds += turn.outputTokens / tps;
    }
  }
  const outputTps = weightedSeconds > 0 ? weightedOut / weightedSeconds : undefined;

  const modelCounts = new Map<string, number>();
  for (const turn of turns) {
    if (turn.metrics.modelId) {
      modelCounts.set(turn.metrics.modelId, (modelCounts.get(turn.metrics.modelId) ?? 0) + 1);
    }
  }

  const kpis = [
    inputTotal !== undefined &&
      outputTotal !== undefined &&
      `${formatTokens(inputTotal)} in · ${formatTokens(outputTotal)} out`,
    hitRate !== undefined && `${formatPercent(hitRate)} cached`,
    ttfts.length > 0 && `${formatMs(quantile(ttfts, 0.5))} step TTFT`,
    outputTps !== undefined && formatTps(outputTps),
  ].filter((part): part is string => Boolean(part));

  return (
    <details className="group/stats rounded-lg border border-border bg-muted/30">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChartNoAxesColumn className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">Model stats</span>
        <span className="truncate font-mono">{kpis.join(" · ")}</span>
        <ChevronDown className="ml-auto size-3.5 shrink-0 transition-transform group-open/stats:rotate-180" />
      </summary>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-1 border-t border-border px-3 py-2.5 text-[11px] sm:grid-cols-[auto_1fr_auto_1fr]">
        <MetricRow
          label="tokens in (billed)"
          value={inputTotal !== undefined ? formatTokens(inputTotal) : undefined}
        />
        <MetricRow
          label="tokens out"
          value={outputTotal !== undefined ? formatTokens(outputTotal) : undefined}
        />
        <MetricRow
          label="reasoning"
          value={reasoningTotal !== undefined ? formatTokens(reasoningTotal) : undefined}
        />
        <MetricRow
          label="cache read / write"
          value={
            cacheRead !== undefined || cacheWrite !== undefined
              ? `${cacheRead !== undefined ? formatTokens(cacheRead) : "–"} / ${
                  cacheWrite !== undefined ? formatTokens(cacheWrite) : "–"
                }`
              : undefined
          }
        />
        <MetricRow
          label="cache hit rate"
          value={hitRate !== undefined ? formatPercent(hitRate) : undefined}
        />
        <MetricRow
          label="step TTFT p50 / p90"
          value={
            ttfts.length > 0
              ? `${formatMs(quantile(ttfts, 0.5))} / ${formatMs(quantile(ttfts, 0.9))}`
              : undefined
          }
        />
        <MetricRow
          label="output speed"
          value={outputTps !== undefined ? formatTps(outputTps) : undefined}
        />
        <MetricRow
          label="turn / model / tool time"
          value={
            totalTime !== undefined || modelTime !== undefined || toolTime !== undefined
              ? `${totalTime !== undefined ? formatMs(totalTime) : "–"} / ${
                  modelTime !== undefined ? formatMs(modelTime) : "–"
                } / ${toolTime !== undefined ? formatMs(toolTime) : "–"}`
              : undefined
          }
        />
        <MetricRow label="retries" value={retries} />
        <MetricRow
          label="models"
          value={
            modelCounts.size > 0
              ? [...modelCounts.entries()]
                  .map(([model, count]) => `${model} ×${count}`)
                  .join(", ")
              : undefined
          }
        />
      </dl>
    </details>
  );
}
