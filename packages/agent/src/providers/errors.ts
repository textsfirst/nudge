export class SubscriptionAuthError extends Error {
  override readonly name = "SubscriptionAuthError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * OpenAI reports a too-large prompt as a 400 whose message (or error code)
 * names the context window — "context_length_exceeded", "Your input exceeds
 * the context window of this model", "maximum context length is N tokens".
 * These arrive as Error instances, APICallError response bodies, or raw wire
 * events, so match every string the error object carries.
 */
const OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /exceeds? the context window/i,
  /maximum context length/i,
  /input is too long/i,
  /too many (?:input )?tokens/i,
];

export function isContextOverflowError(error: unknown): boolean {
  return collectErrorStrings(error, 4).some((text) =>
    OVERFLOW_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

function collectErrorStrings(value: unknown, depth: number): string[] {
  if (depth <= 0 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  const out: string[] = [];
  const record = value as Record<string, unknown>;
  for (const key of ["message", "code", "responseBody", "error", "cause", "data"]) {
    out.push(...collectErrorStrings(record[key], depth - 1));
  }
  return out;
}
