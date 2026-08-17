import type { MessageRow } from "@nudge/store";

/**
 * Context-window budgeting for thread compaction. Everything here is a pure
 * function over estimates: token counts are approximated (never a tokenizer)
 * and always err high, so the only failure mode is compacting a little early.
 */

/**
 * Headroom kept below the context window: the model's output (including
 * reasoning tokens), tool JSON schemas, and tool results accumulated within a
 * single turn — none of which appear in persisted history.
 */
export const RESERVE_TOKENS = 32_000;

/** Recent-conversation tokens kept verbatim when older turns are folded. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** Share of the usable window that triggers a fold. */
export const DEFAULT_COMPACT_AT_FRACTION = 0.8;

/** Window assumed for models the registry does not recognize. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Fixed per-message serialization overhead (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Known context windows by model-id prefix, first match wins. These are
 * *input* caps where a model's total window is larger — the gpt-5 family
 * advertises 400k but rejects inputs above 272k.
 */
const MODEL_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-5/, 272_000],
  [/^o[34]/, 200_000],
  [/^gpt-4o/, 128_000],
  // Grok windows as the CLI proxy advertises them; the catch-all covers
  // grok-4.5 / grok-4.6 / grok-build (all 500k).
  [/^grok-4\.20/, 2_000_000],
  [/^grok-4\.3/, 1_000_000],
  [/^grok-composer/, 200_000],
  [/^grok-/, 500_000],
];

export function contextWindowFor(modelId: string): number {
  for (const [pattern, window] of MODEL_WINDOWS) {
    if (pattern.test(modelId)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Flat token charge per image in the prompt. OpenAI's high-detail cost for a
 * ~1024² photo is ~765 tokens; estimates here must err high.
 */
export const IMAGE_TOKENS = 1_000;

/**
 * Models known to accept image input, by model-id prefix. Unknown ids are
 * assumed text-only — sending image parts to a model that rejects them fails
 * the whole turn, while the reverse merely loses vision (captions still
 * carry the content). The `vision: "on"` setting overrides for custom
 * endpoints serving models this registry does not know.
 */
const VISION_MODELS: ReadonlyArray<RegExp> = [/^gpt-4\.1/, /^gpt-5/, /^o[134]/, /^gpt-4o/, /^grok-/];

export function supportsVision(modelId: string): boolean {
  return VISION_MODELS.some((pattern) => pattern.test(modelId));
}

/**
 * Approximate token count: ~4 ASCII characters per token, and a full token
 * per non-ASCII character — CJK really is ~1 token per character, and
 * overcounting accented text is the safe direction.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

export function estimateMessageTokens(row: MessageRow): number {
  // Media never inflates row.content (projections are short text); images the
  // model may be shown are charged flat, per the linked-attachment aggregate.
  return estimateTokens(row.content) + MESSAGE_OVERHEAD_TOKENS + IMAGE_TOKENS * row.imageCount;
}

export interface CompactionBudget {
  contextWindow: number;
  /** Share of the usable window that triggers a fold. */
  compactAtFraction: number;
  /** Recent-conversation tokens kept verbatim after a fold. */
  keepRecentTokens: number;
}

export interface CompactionPlan {
  /** Older rows to fold into the summary; always non-empty, oldest first. */
  fold: MessageRow[];
  /** Recent rows kept verbatim. */
  keep: MessageRow[];
  /** Estimated prompt tokens (system + history) that forced the fold. */
  totalTokens: number;
}

/** The window minus reserve, floored at half the window so tiny (test) windows stay sane. */
export function usableWindow(contextWindow: number): number {
  return Math.max(contextWindow - RESERVE_TOKENS, Math.ceil(contextWindow / 2));
}

/**
 * Decide whether — and where — to fold. Returns null when the estimated
 * prompt fits, or when nothing would actually fold. The cut walks back from
 * the newest row until `keepRecentTokens` is spent (a quarter of that in
 * aggressive mode, used after a real provider overflow), then moves forward
 * to the next user row so the kept window opens with the owner speaking. The
 * kept tail is far below the trigger threshold, so a fold can never cascade
 * into another fold. At least the final two rows always stay.
 */
export function planCompaction(input: {
  messages: MessageRow[];
  systemTokens: number;
  budget: CompactionBudget;
  aggressive?: boolean;
}): CompactionPlan | null {
  const { messages, systemTokens, budget } = input;
  if (messages.length === 0) return null;

  const totalTokens =
    systemTokens + messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0);
  const threshold = usableWindow(budget.contextWindow) * budget.compactAtFraction;
  if (!input.aggressive && totalTokens <= threshold) return null;

  const keepBudget = input.aggressive
    ? Math.max(1_000, Math.floor(budget.keepRecentTokens / 4))
    : budget.keepRecentTokens;
  const minKeep = Math.min(2, messages.length);

  let cut = messages.length;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tokens = estimateMessageTokens(messages[i]!);
    if (messages.length - i > minKeep && kept + tokens > keepBudget) break;
    cut = i;
    kept += tokens;
  }

  // Aggressive mode answers a real provider overflow the estimates missed, so
  // it must always make progress: when the walk kept everything, fold down to
  // the minimum tail anyway.
  if (input.aggressive && cut === 0) {
    cut = messages.length - minKeep;
  }

  // Open the kept window on a user row when one exists before the min-keep tail.
  const limit = messages.length - minKeep;
  for (let scan = cut; scan <= limit; scan += 1) {
    if (messages[scan]!.role === "user") {
      cut = scan;
      break;
    }
  }

  if (cut === 0) return null;
  return {
    fold: messages.slice(0, cut),
    keep: messages.slice(cut),
    totalTokens,
  };
}
