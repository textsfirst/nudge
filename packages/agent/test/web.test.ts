import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeStore } from "@nudge/store";
import { describe, expect, it } from "vitest";
import { FileWorkspace } from "../src/files.js";
import { buildTools } from "../src/tools.js";
import {
  FirecrawlClient,
  findUrlSecret,
  stripBase64Images,
  truncateHeadTail,
} from "../src/web.js";

type RecordedCall = { url: string; init: RequestInit };
type Execute = (
  input: unknown,
  options?: { abortSignal?: AbortSignal },
) => Promise<string>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch stub that records calls and replays queued responses in order. */
function recordingFetch(responses: Array<Response | Error>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("fetch stub exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function requestBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function toolset(client?: FirecrawlClient) {
  return buildTools({
    workspace: new FileWorkspace(join(tmpdir(), "nudge-web-test")),
    store: new NudgeStore(":memory:"),
    ...(client ? { web: client } : {}),
  });
}

function client(fetch: typeof globalThis.fetch, timeoutMs?: number): FirecrawlClient {
  return new FirecrawlClient({
    apiKey: "fc-test-key",
    fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

const SEARCH_OK = {
  success: true,
  data: {
    web: [
      { url: "https://a.dev", title: "Alpha", description: "First result" },
      { url: "https://b.dev", title: "", description: "" },
    ],
  },
};

function scrapeOk(markdown: string, title: unknown = "Page Title"): unknown {
  return { success: true, data: { markdown, metadata: { title } } };
}

describe("tool surface gating", () => {
  it("omits the web tools without a client and includes them with one", () => {
    const without = Object.keys(toolset()).sort();
    expect(without).not.toContain("web_search");
    expect(without).not.toContain("web_extract");

    const withWeb = Object.keys(toolset(client(recordingFetch([]).fetch))).sort();
    expect(withWeb).toContain("web_search");
    expect(withWeb).toContain("web_extract");
  });
});

describe("web_search", () => {
  it("hits /v2/search with auth and defaults, and formats results", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(SEARCH_OK)]);
    const search = toolset(client(fetch)).web_search!.execute as Execute;

    const output = await search({ query: "nudge agent" });
    expect(calls[0]!.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer fc-test-key");
    expect(requestBody(calls[0]!)).toEqual({ query: "nudge agent", limit: 5 });
    expect(output).toContain("1. Alpha");
    expect(output).toContain("https://a.dev");
    expect(output).toContain("First result");
    // A hit with no title falls back to its URL as the label.
    expect(output).toContain("2. https://b.dev");
  });

  it("passes an explicit limit through", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(SEARCH_OK)]);
    const search = toolset(client(fetch)).web_search!.execute as Execute;
    await search({ query: "q", limit: 3 });
    expect(requestBody(calls[0]!)["limit"]).toBe(3);
  });

  it("sends no Authorization header when only apiUrl is configured", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(SEARCH_OK)]);
    const selfHosted = new FirecrawlClient({ apiUrl: "http://localhost:3002/", fetch });
    await selfHosted.search("q", 5);
    expect(calls[0]!.url).toBe("http://localhost:3002/v2/search");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
  });

  it("reports empty results", async () => {
    const { fetch } = recordingFetch([jsonResponse({ success: true, data: { web: [] } })]);
    const search = toolset(client(fetch)).web_search!.execute as Execute;
    expect(await search({ query: "nothing" })).toBe('No results for "nothing".');
  });

  it("returns error strings instead of throwing", async () => {
    const cases: Array<[Response | Error, string]> = [
      [jsonResponse({ error: "slow down" }, 429), "rate limit"],
      [jsonResponse({ error: "Unauthorized" }, 401), "FIRECRAWL_API_KEY"],
      [jsonResponse({ error: "Payment required" }, 402), "out of credits"],
      [new TypeError("fetch failed"), "fetch failed"],
      [jsonResponse({ success: false, error: "backend exploded" }), "backend exploded"],
      [jsonResponse({ success: true }), "Unexpected response shape"],
    ];
    for (const [response, expected] of cases) {
      const { fetch } = recordingFetch([response]);
      const search = toolset(client(fetch)).web_search!.execute as Execute;
      const output = await search({ query: "q" });
      expect(output).toMatch(/^Error: /);
      expect(output).toContain(expected);
    }
  });

  it("times out via the client abort signal", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
    const search = toolset(client(hanging, 20)).web_search!.execute as Execute;
    expect(await search({ query: "q" })).toContain("timed out");
  });

  it("propagates a turn abort instead of converting it to an error result", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hanging = ((_url: unknown, init?: RequestInit) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    const search = toolset(client(hanging)).web_search!.execute as Execute;
    const controller = new AbortController();

    const pending = search({ query: "q" }, { abortSignal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("web_extract", () => {
  it("scrapes markdown with the body-level timeout and renders a titled section", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(scrapeOk("Hello **world**."))]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;

    const output = await extract({ urls: ["https://a.dev/post"] });
    expect(calls[0]!.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(requestBody(calls[0]!)).toEqual({
      url: "https://a.dev/post",
      formats: ["markdown"],
      timeout: 30_000,
    });
    expect(output).toBe("## Page Title — https://a.dev/post\n\nHello **world**.");
  });

  it("normalizes an array-valued metadata title", async () => {
    const { fetch } = recordingFetch([jsonResponse(scrapeOk("body", ["First", "Second"]))]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;
    expect(await extract({ urls: ["https://a.dev"] })).toContain("## First — https://a.dev");
  });

  it("reports pages with no readable content", async () => {
    const { fetch } = recordingFetch([jsonResponse(scrapeOk("   \n  "))]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;
    expect(await extract({ urls: ["https://a.dev"] })).toContain("No readable content");
  });

  it("truncates long pages head+tail with a footer", async () => {
    const line = "content line filling space across the page\n";
    const page = "START\n" + line.repeat(200) + "END";
    const { fetch } = recordingFetch([jsonResponse(scrapeOk(page))]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;

    const output = await extract({ urls: ["https://a.dev"], char_limit: 2000 });
    expect(output).toContain("START");
    expect(output).toContain("END");
    expect(output).toContain("[... middle omitted ...]");
    expect(output).toContain(`of ${page.length} total`);
    expect(output.length).toBeLessThan(page.length);
  });

  it("strips base64 images but keeps real image links", async () => {
    const page =
      "Before ![diagram](data:image/png;base64,AAAABBBBCCCC) after " +
      "![logo](https://a.dev/logo.png)";
    const { fetch } = recordingFetch([jsonResponse(scrapeOk(page))]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;

    const output = await extract({ urls: ["https://a.dev"] });
    expect(output).toContain("[IMAGE: diagram]");
    expect(output).not.toContain("base64");
    expect(output).toContain("![logo](https://a.dev/logo.png)");
  });

  it("blocks credential-bearing URLs without calling fetch", async () => {
    const { fetch, calls } = recordingFetch([]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;

    for (const url of [
      "https://x.com/?api_key=abc",
      "https://x.com/sk-abcdefgh12345678/page",
      "https://x.com/?q=sk%2Dabcdefgh12345678",
    ]) {
      const output = await extract({ urls: [url] });
      expect(output).toContain("Error: blocked");
    }
    expect(calls).toHaveLength(0);
  });

  it("isolates per-URL failures", async () => {
    const { fetch } = recordingFetch([
      jsonResponse({ error: "boom" }, 500),
      jsonResponse(scrapeOk("Second page content")),
    ]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;

    const output = await extract({ urls: ["https://bad.dev", "https://good.dev"] });
    const sections = output.split("\n\n---\n\n");
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("Error: Firecrawl request failed (HTTP 500)");
    expect(sections[1]).toContain("Second page content");
  });

  it("rejects malformed scrape responses per URL", async () => {
    const { fetch } = recordingFetch([jsonResponse({ success: true, nope: 1 })]);
    const extract = toolset(client(fetch)).web_extract!.execute as Execute;
    expect(await extract({ urls: ["https://a.dev"] })).toContain("Unexpected response shape");
  });

  it("propagates a turn abort instead of isolating it as a page failure", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hanging = ((_url: unknown, init?: RequestInit) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    const extract = toolset(client(hanging)).web_extract!.execute as Execute;
    const controller = new AbortController();

    const pending = extract(
      { urls: ["https://a.dev"] },
      { abortSignal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("helpers", () => {
  it("truncateHeadTail returns short content whole", () => {
    expect(truncateHeadTail("short", 2000)).toBe("short");
  });

  it("stripBase64Images handles bare and parenthesized data URIs", () => {
    expect(stripBase64Images("(data:image/png;base64,AAAA)")).toBe("[IMAGE]");
    expect(stripBase64Images("x data:image/jpeg;base64,QUJD y")).toBe("x [IMAGE] y");
  });

  it("findUrlSecret passes clean URLs and flags secrets", () => {
    expect(findUrlSecret("https://example.com/docs?page=2")).toBeNull();
    expect(findUrlSecret("https://example.com/?access_token=zzz")).toContain("access_token");
    expect(findUrlSecret("https://example.com/ghp_0123456789abcdef")).toContain("API key");
  });
});
