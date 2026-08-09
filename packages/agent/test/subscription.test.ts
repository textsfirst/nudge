import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import {
  ChatGptSubscriptionSource,
  extractAccountId,
  getJwtExpiration,
} from "../src/index.js";

describe("ChatGPT JWT parsing", () => {
  it("extracts expiration and the namespaced account id", () => {
    const payload = Buffer.from(
      JSON.stringify({
        exp: 2_000_000_000,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
      }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;
    expect(extractAccountId(token)).toBe("acct-123");
    expect(getJwtExpiration(token)).toBe(2_000_000_000_000);
  });
});

describe("ChatGptSubscriptionSource", () => {
  it("calls the subscription Responses endpoint directly with OAuth headers", async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      requestInit = init;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          delta: "hello from subscription",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        {
          type: "response.completed",
          response: {
            incomplete_details: null,
            usage: {
              input_tokens: 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
            },
            reasoning: null,
            service_tier: null,
          },
        },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const source = new ChatGptSubscriptionSource({
      auth: {
        credentials: async () => ({ accessToken: "oauth-token", accountId: "acct-123" }),
      } as never,
      model: "gpt-5.4-mini",
      fetch: fetchMock,
    });

    // Mirror the agent loop's exact call shape.
    const result = streamText({
      model: await source.languageModel(),
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      providerOptions: { openai: { store: false } },
    });
    await expect(result.text).resolves.toBe("hello from subscription");

    expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(headers.get("originator")).toBe("nudge");
    const body = JSON.parse(String(requestInit?.body)) as {
      model: string;
      input: Array<{ role: string }>;
      stream?: boolean;
      store?: boolean;
    };
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.input.at(-1)).toMatchObject({ role: "user" });
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });
});
