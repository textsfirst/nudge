import { useState } from "react";
import { Page } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { useCosts, type CostsPayload } from "@/lib/api";

const KINDS = ["conversation", "execution", "report"] as const;
const KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  conversation: "Conversation",
  execution: "Agent work",
  report: "Report curation",
};

/**
 * Token spend by day and turn kind, plus what the watcher check gate saved.
 * Read-only; token counts are the model-reported columns already stored per
 * assistant turn.
 */
export function CostsPage() {
  const [days, setDays] = useState(14);
  const { data, error, isLoading } = useCosts(days);

  return (
    <Page
      title="Costs"
      description="Model-reported token usage per day, split by what kind of turn spent it."
      actions={
        <Select value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </Select>
      }
    >
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{String(error)}</p>}
      {data && <Totals data={data} />}
      {data && <DailyTable data={data} />}
      {data && data.watcher.checksRun > 0 && (
        <p className="text-xs text-muted-foreground">
          Watchers: {data.watcher.checksRun.toLocaleString()} checks run,{" "}
          {data.watcher.wakes.toLocaleString()} woke an agent —{" "}
          {data.watcher.avoided.toLocaleString()} model turns avoided by the check gate (all-time).
        </p>
      )}
    </Page>
  );
}

function Totals({ data }: { data: CostsPayload }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {KINDS.map((kind) => {
        const rows = data.usage.filter((row) => row.kind === kind);
        const input = rows.reduce((total, row) => total + row.inputTokens, 0);
        const output = rows.reduce((total, row) => total + row.outputTokens, 0);
        const turns = rows.reduce((total, row) => total + row.turns, 0);
        return (
          <Card key={kind}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm">{KIND_LABEL[kind]}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <p className="text-lg font-medium text-foreground">
                {formatTokens(input + output)} tokens
              </p>
              <p>
                {turns.toLocaleString()} turns · {formatTokens(input)} in /{" "}
                {formatTokens(output)} out
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function DailyTable({ data }: { data: CostsPayload }) {
  const byDay = new Map<string, Partial<Record<(typeof KINDS)[number], number>>>();
  for (const row of data.usage) {
    const day = byDay.get(row.day) ?? {};
    day[row.kind] = (day[row.kind] ?? 0) + row.inputTokens + row.outputTokens;
    byDay.set(row.day, day);
  }
  const days = [...byDay.keys()].sort().reverse();
  if (days.length === 0) {
    return (
      <Card>
        <CardContent className="pt-3 text-muted-foreground">
          No token usage recorded in this window.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="pt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1 font-medium">Day</th>
              {KINDS.map((kind) => (
                <th key={kind} className="py-1 text-right font-medium">
                  {KIND_LABEL[kind]}
                </th>
              ))}
              <th className="py-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const row = byDay.get(day)!;
              const total = KINDS.reduce((sum, kind) => sum + (row[kind] ?? 0), 0);
              return (
                <tr key={day} className="border-t border-border">
                  <td className="py-1.5">{day}</td>
                  {KINDS.map((kind) => (
                    <td key={kind} className="py-1.5 text-right tabular-nums">
                      {row[kind] ? formatTokens(row[kind]) : "—"}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-medium tabular-nums">
                    {formatTokens(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
