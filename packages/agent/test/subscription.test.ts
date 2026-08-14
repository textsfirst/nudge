import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatGptSubscriptionSource,
  extractAccountId,
  getJwtExpiration,
  GROK_CLIENT_VERSION,
  GrokAuthManager,
  GrokSubscriptionSource,
  runGrokDeviceLogin,
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

function responsesStream(text: string): Response {
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
      delta: text,
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
}

describe("GrokSubscriptionSource", () => {
  it("calls the CLI proxy's Responses endpoint with the Grok Build headers", async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      requestInit = init;
      return responsesStream("hello from grok");
    };

    const source = new GrokSubscriptionSource({
      auth: {
        credentials: async () => ({ accessToken: "grok-token" }),
      } as never,
      model: "grok-4.6",
      fetch: fetchMock,
    });

    const result = streamText({
      model: await source.languageModel(),
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(result.text).resolves.toBe("hello from grok");

    expect(requestUrl).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer grok-token");
    expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
    expect(headers.get("x-grok-client-version")).toBe(GROK_CLIENT_VERSION);
    expect(headers.get("x-grok-client-mode")).toBe("interactive");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-authenticateresponse")).toBe("authenticate-response");
    const body = JSON.parse(String(requestInit?.body)) as { model: string };
    expect(body.model).toBe("grok-4.6");
  });

  it("honors the client version override", async () => {
    let version: string | null = null;
    const fetchMock: typeof fetch = async (input, init) => {
      version = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      ).get("x-grok-client-version");
      return responsesStream("ok");
    };
    const source = new GrokSubscriptionSource({
      auth: { credentials: async () => ({ accessToken: "t" }) } as never,
      model: "grok-4.6",
      clientVersion: "9.9.9",
      fetch: fetchMock,
    });
    const result = streamText({
      model: await source.languageModel(),
      messages: [{ role: "user", content: "hi" }],
    });
    await result.consumeStream();
    expect(version).toBe("9.9.9");
  });
});

describe("Grok device login and token refresh", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const authFile = () => {
    dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
    return join(dir, "grok-auth.json");
  };

  const idToken = (payload: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("polls the device flow to completion and stores the tokens", async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    let polls = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, body: new URLSearchParams(String(init?.body)) });
      if (url.endsWith("/oauth2/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "dev-1",
            user_code: "GROK-1234",
            verification_uri: "https://accounts.x.ai/activate",
            interval: 0,
          }),
          { status: 200 },
        );
      }
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          id_token: idToken({ email: "owner@x.ai" }),
          expires_in: 3600,
        }),
        { status: 200 },
      );
    };

    const path = authFile();
    let prompt: { verificationUrl: string; userCode: string } | undefined;
    const stored = await runGrokDeviceLogin({
      authFile: path,
      fetch: fetchMock,
      onPrompt: (details) => {
        prompt = details;
      },
    });

    expect(prompt).toEqual({
      verificationUrl: "https://accounts.x.ai/activate",
      userCode: "GROK-1234",
    });
    expect(stored.email).toBe("owner@x.ai");
    const startCall = calls[0]!;
    expect(startCall.body.get("referrer")).toBe("grok-build");
    expect(startCall.body.get("scope")).toContain("grok-cli:access");
    const pollCall = calls[1]!;
    expect(pollCall.url).toContain("/oauth2/token");
    expect(pollCall.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(pollCall.body.get("device_code")).toBe("dev-1");

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toMatchObject({ accessToken: "at", refreshToken: "rt", email: "owner@x.ai" });
    expect(typeof onDisk.expiresAt).toBe("number");
  });

  it("refreshes an expired access token through the refresh grant", async () => {
    const path = authFile();
    writeFileSync(
      path,
      JSON.stringify({
        accessToken: "old",
        refreshToken: "rt-old",
        expiresAt: Date.now() - 1_000,
        updatedAt: new Date().toISOString(),
      }),
    );
    let refreshBody: URLSearchParams | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe("https://auth.x.ai/oauth2/token");
      refreshBody = new URLSearchParams(String(init?.body));
      return new Response(
        JSON.stringify({ access_token: "new", refresh_token: "rt-new", expires_in: 3600 }),
        { status: 200 },
      );
    };

    const credentials = await new GrokAuthManager({ authFile: path, fetch: fetchMock }).credentials();
    expect(credentials.accessToken).toBe("new");
    expect(refreshBody?.get("grant_type")).toBe("refresh_token");
    expect(refreshBody?.get("refresh_token")).toBe("rt-old");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.accessToken).toBe("new");
    expect(onDisk.refreshToken).toBe("rt-new");
  });

  it("leaves a fresh token alone", async () => {
    const path = authFile();
    writeFileSync(
      path,
      JSON.stringify({
        accessToken: "current",
        refreshToken: "rt",
        expiresAt: Date.now() + 60 * 60 * 1_000,
        updatedAt: new Date().toISOString(),
      }),
    );
    const fetchMock: typeof fetch = async () => {
      throw new Error("no request expected");
    };
    const credentials = await new GrokAuthManager({ authFile: path, fetch: fetchMock }).credentials();
    expect(credentials.accessToken).toBe("current");
  });
});
