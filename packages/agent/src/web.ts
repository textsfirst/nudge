import { z } from "zod";

/** Options for the Firecrawl-backed web client. */
export interface FirecrawlOptions {
  /** Cloud API key. Optional: a self-hosted instance needs none. */
  apiKey?: string;
  /** Override for self-hosted instances. Defaults to the Firecrawl cloud API. */
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Client-side abort for one request. The scrape body timeout sits below it. */
  timeoutMs?: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  description: string;
}

export interface WebPage {
  markdown: string;
  title: string;
}

const DEFAULT_API_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 35_000;
/** Sent in the scrape request body, below the client abort so Firecrawl's own error wins. */
const SCRAPE_BODY_TIMEOUT_MS = 30_000;

const searchResponseSchema = z.object({
  data: z.object({
    web: z
      .array(
        z.object({
          url: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

const scrapeResponseSchema = z.object({
  data: z.object({
    markdown: z.string().optional(),
    metadata: z
      .object({ title: z.union([z.string(), z.array(z.string())]).optional() })
      .optional(),
  }),
});

/** Thin client for the two Firecrawl v2 endpoints the web tools need. */
export class FirecrawlClient {
  readonly #apiKey: string | undefined;
  readonly #apiUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: FirecrawlOptions) {
    this.#apiKey = options.apiKey;
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, limit: number, abortSignal?: AbortSignal): Promise<WebSearchHit[]> {
    const payload = await this.#post("/v2/search", { query, limit }, abortSignal);
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Unexpected response shape from Firecrawl search.");
    }
    return (parsed.data.data.web ?? []).map((hit) => ({
      url: hit.url,
      title: hit.title ?? "",
      description: hit.description ?? "",
    }));
  }

  async scrape(url: string, abortSignal?: AbortSignal): Promise<WebPage> {
    const payload = await this.#post(
      "/v2/scrape",
      {
        url,
        formats: ["markdown"],
        timeout: SCRAPE_BODY_TIMEOUT_MS,
      },
      abortSignal,
    );
    const parsed = scrapeResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Unexpected response shape from Firecrawl scrape.");
    }
    const title = parsed.data.data.metadata?.title;
    return {
      markdown: parsed.data.data.markdown ?? "",
      title: (Array.isArray(title) ? title[0] : title) ?? "",
    };
  }

  async #post(path: string, body: unknown, abortSignal?: AbortSignal): Promise<unknown> {
    abortSignal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      // A steered turn must stay an abort all the way to streamText; turning it
      // into a tool-result string would keep the abandoned loop alive.
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new DOMException("The turn was aborted during a web request", "AbortError");
      }
      if (
        timeoutSignal.aborted ||
        (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      ) {
        throw new Error(`Firecrawl request timed out after ${Math.round(this.#timeoutMs / 1000)}s.`);
      }
      throw new Error(
        `Firecrawl request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const detail = await bodyErrorMessage(response);
      if (response.status === 429) {
        throw new Error("Firecrawl rate limit hit — wait a moment and retry.");
      }
      if (response.status === 402) {
        throw new Error("Firecrawl payment required — the account is out of credits.");
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Firecrawl auth failed (HTTP ${response.status})${detail} — check FIRECRAWL_API_KEY.`,
        );
      }
      throw new Error(`Firecrawl request failed (HTTP ${response.status})${detail}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Unexpected response shape from Firecrawl.");
    }
    if (typeof payload === "object" && payload !== null && "success" in payload) {
      const { success, error } = payload as { success: unknown; error?: unknown };
      if (success === false) {
        throw new Error(typeof error === "string" ? error : "Firecrawl reported a failure.");
      }
    }
    return payload;
  }
}

async function bodyErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? `: ${parsed.error}` : "";
  } catch {
    return "";
  }
}

/**
 * Head+tail truncation with an explicit footer (Hermes-style): pages within
 * the budget return whole; larger pages keep ~75% head and ~25% tail, cut on
 * line boundaries, so the model sees both the opening and any trailing
 * summary/footer content instead of a blind head-only slice.
 */
export function truncateHeadTail(content: string, charLimit: number): string {
  if (content.length <= charLimit) return content;

  const headBudget = Math.floor(charLimit * 0.75);
  const tailBudget = charLimit - headBudget;
  let head = content.slice(0, headBudget);
  const headCut = head.lastIndexOf("\n");
  if (headCut > headBudget * 0.5) head = head.slice(0, headCut);
  let tail = content.slice(-tailBudget);
  const tailCut = tail.indexOf("\n");
  if (tailCut >= 0 && tailCut < tailBudget * 0.5) tail = tail.slice(tailCut + 1);

  return (
    `${head}\n\n[... middle omitted ...]\n\n${tail}\n\n` +
    `[Truncated: showing ${head.length} chars (head) + ${tail.length} chars (tail) of ` +
    `${content.length} total. Re-call web_extract with a higher char_limit or a more ` +
    `specific URL for more.]`
  );
}

/**
 * Inline base64 images are token bombs (one PNG can be tens of thousands of
 * characters). Replace them with labeled placeholders; real image URLs are
 * left as links the agent can extract later.
 */
export function stripBase64Images(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(\s*data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+\)/g, (_, alt: string) =>
      alt.trim() ? `[IMAGE: ${alt.trim()}]` : "[IMAGE]",
    )
    .replace(/\(\s*data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+\)/g, "[IMAGE]")
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[IMAGE]");
}

const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{8,}|fc-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]{8,})/;
const SENSITIVE_PARAM =
  /^(token|key|secret|password|passwd|auth|api_key|apikey|access_token|refresh_token|client_secret|session|sig|signature|credential|credentials)$/i;

/**
 * Extraction backends are third-party readers — sending a URL with embedded
 * credentials would exfiltrate them. Returns a description of the problem, or
 * null when the URL looks safe.
 */
export function findUrlSecret(url: string): string | null {
  for (const candidate of [url, safeDecode(url)]) {
    if (SECRET_PATTERN.test(candidate)) return "an embedded API key or token";
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "a non-HTTP URL";
    }
    if (parsed.username || parsed.password) {
      return "embedded URL credentials";
    }
    for (const name of parsed.searchParams.keys()) {
      if (SENSITIVE_PARAM.test(name) || /^(x-amz-|amz-)/i.test(name) || /credential|signature|token|secret/i.test(name)) {
        return `a credential-like query parameter (${name})`;
      }
    }
  } catch {
    // Unparseable URLs fall through; the scrape itself will report the problem.
  }
  return null;
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}
