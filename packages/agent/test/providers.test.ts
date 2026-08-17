import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createModelSources, CustomEndpointSource } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

const BASE: ProviderConfig = {
  selected: "chatgpt-subscription",
  chatGptModel: "gpt-5.4-mini",
  chatGptAuthFile: "/tmp/chatgpt-auth.json",
  grokModel: "grok-4.6",
  grokAuthFile: "/tmp/grok-auth.json",
  openAiModel: "gpt-5-mini",
};

describe("createModelSources", () => {
  it("returns only the selected subscription source — never an API-key fallback", () => {
    const sources = createModelSources({ ...BASE, openAiApiKey: "sk-test" });
    expect(sources.map((source) => source.id)).toEqual(["chatgpt-subscription"]);
  });

  it("returns the Grok subscription source when selected", () => {
    const sources = createModelSources({
      ...BASE,
      selected: "grok-subscription",
      openAiApiKey: "sk-test",
    });
    expect(sources.map((source) => source.id)).toEqual(["grok-subscription"]);
    expect(sources[0]?.modelId).toBe("grok-4.6");
  });
});

describe("createModelSources with the custom provider", () => {
  it("returns only the custom source, with no fallback", () => {
    const sources = createModelSources({
      ...BASE,
      selected: "custom",
      customBaseUrl: "http://localhost:11434/v1",
      customModel: "llama3.3:70b",
      openAiApiKey: "sk-test",
    });
    expect(sources.map((source) => source.id)).toEqual(["custom"]);
    expect(sources[0]?.modelId).toBe("llama3.3:70b");
  });

  it("requires both a base URL and a model id", () => {
    expect(() =>
      createModelSources({ ...BASE, selected: "custom", customModel: "llama3.3:70b" }),
    ).toThrow(/base URL/);
    expect(() =>
      createModelSources({ ...BASE, selected: "custom", customBaseUrl: "http://localhost:11434/v1" }),
    ).toThrow(/model id/);
  });
});

describe("CustomEndpointSource", () => {
  const chatResponse = () =>
    new Response(
      [
        `data: ${JSON.stringify({
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "llama3.3:70b",
          choices: [{ index: 0, delta: { role: "assistant", content: "hello from custom" } }],
        })}`,
        `data: ${JSON.stringify({
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "llama3.3:70b",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  it("calls the configured endpoint's Chat Completions API with the key", async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      requestInit = init;
      return chatResponse();
    };

    const source = new CustomEndpointSource({
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.3:70b",
      api: "chat-completions",
      apiKey: "ck-test",
      fetch: fetchMock,
    });

    const result = streamText({
      model: await source.languageModel(),
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(result.text).resolves.toBe("hello from custom");

    expect(requestUrl).toBe("http://localhost:11434/v1/chat/completions");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer ck-test");
    const body = JSON.parse(String(requestInit?.body)) as { model: string };
    expect(body.model).toBe("llama3.3:70b");
  });

  it("sends a placeholder key for keyless endpoints and never treats errors as auth fallback", async () => {
    let authHeader: string | null = null;
    const fetchMock: typeof fetch = async (input, init) => {
      authHeader = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      ).get("authorization");
      return chatResponse();
    };

    const source = new CustomEndpointSource({
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.3:70b",
      api: "chat-completions",
      fetch: fetchMock,
    });
    const result = streamText({
      model: await source.languageModel(),
      messages: [{ role: "user", content: "hi" }],
    });
    await result.consumeStream();

    expect(authHeader).toBe("Bearer none");
    expect(source.isAuthError()).toBe(false);
  });
});

describe("GrokSubscriptionSource", () => {
  it("treats HTTP 426 as an auth/config failure", async () => {
    const { APICallError } = await import("@ai-sdk/provider");
    const { GrokSubscriptionSource } = await import("../src/index.js");
    const source = new GrokSubscriptionSource({
      auth: { credentials: async () => ({ accessToken: "t" }) } as never,
      model: "grok-4.6",
    });
    expect(
      source.isAuthError(new APICallError({ message: "upgrade", statusCode: 426, url: "x" })),
    ).toBe(true);
    expect(
      source.isAuthError(new APICallError({ message: "busy", statusCode: 503, url: "x" })),
    ).toBe(false);
  });
});
