import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp, type ConsoleApp } from "../src/server/app.js";

const CONFIG = 'owner_handle: "+15551234567"\ntimezone: UTC\n';

let root: string | undefined;

function makeWorkspace(): string {
  root = mkdtempSync(join(tmpdir(), "console-connections-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(join(root, "nudge.config.yaml"), CONFIG);
  writeFileSync(join(root, ".env"), "");
  mkdirSync(join(root, ".data"), { recursive: true });
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

/** Routes every outbound HTTP call the connection flows make. */
function fetchStub(): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const respond = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = String(init?.body);
      if (body.includes("authorization_code")) {
        return respond({
          refresh_token: "refresh-1",
          id_token: jwt({ email: "w@corp.com" }),
          scope: "openid https://www.googleapis.com/auth/gmail.modify",
        });
      }
      return respond({ access_token: "fresh" }); // probe refresh grant
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      return respond({});
    }
    if (url.endsWith("/deviceauth/usercode")) {
      return respond({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: 0 });
    }
    if (url.endsWith("/deviceauth/token")) {
      return respond({ authorization_code: "ac", code_challenge: "cc", code_verifier: "cv" });
    }
    if (url.endsWith("/oauth/token")) {
      return respond({
        access_token: "at",
        refresh_token: "rt",
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
      });
    }
    return respond({ error: `unexpected fetch ${url}` }, 500);
  }) as typeof fetch;
}

function app(): ConsoleApp {
  return createConsoleApp({ root: makeWorkspace(), fetch: fetchStub() });
}

async function json(
  application: ConsoleApp,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await application.handle(
    new Request(`http://console.local${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    }),
  );
  return { status: response.status, body: await response.json() };
}

describe("connections API", () => {
  it("reports an unconfigured state cleanly", async () => {
    const { status, body } = await json(app(), "/api/connections");
    expect(status).toBe(200);
    expect(body.chatgpt.connected).toBe(false);
    expect(body.google.clientConfigured).toBe(false);
    expect(body.google.accounts).toEqual([]);
    expect(body.google.services.map((service: any) => service.id)).toContain("gmail");
  });

  it("refuses to start Google sign-in before the OAuth client exists", async () => {
    const application = app();
    const result = await json(application, "/api/connections/google/start", {
      method: "POST",
      body: JSON.stringify({
        label: "work",
        origin: "http://console.local",
        services: [{ id: "gmail", access: "full" }],
      }),
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("OAuth client");
  });

  it("connects a Google account end to end and hides its files", async () => {
    const application = app();

    const saved = await json(application, "/api/connections/google/client", {
      method: "PUT",
      body: JSON.stringify({ json: '{"web":{"client_id":"cid","client_secret":"cs"}}' }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.clientId).toBe("cid");

    const started = await json(application, "/api/connections/google/start", {
      method: "POST",
      body: JSON.stringify({
        label: "work",
        origin: "http://console.local",
        services: [{ id: "gmail", access: "full" }, { id: "calendar", access: "readonly" }],
      }),
    });
    expect(started.status).toBe(200);
    const authUrl = new URL(started.body.authUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "http://console.local/api/connections/google/callback",
    );
    expect(authUrl.searchParams.get("scope")).toContain("gmail.modify");
    expect(authUrl.searchParams.get("scope")).toContain("calendar.readonly");

    const state = authUrl.searchParams.get("state")!;
    const callback = await application.handle(
      new Request(
        `http://console.local/api/connections/google/callback?state=${state}&code=c0de`,
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/connections?connected=work");

    const credentialsPath = join(root!, ".data", "google", "work", "credentials.json");
    expect(JSON.parse(readFileSync(credentialsPath, "utf8")).refresh_token).toBe("refresh-1");

    const overview = await json(application, "/api/connections");
    expect(overview.body.google.accounts).toHaveLength(1);
    expect(overview.body.google.accounts[0]).toMatchObject({
      label: "work",
      email: "w@corp.com",
      status: "ok",
    });

    // The seeded skill is a normal data file; the credentials are invisible.
    const files = await json(application, "/api/files");
    const paths = files.body.files.map((file: any) => file.path);
    expect(paths).toContain("skills/google-workspace/SKILL.md");
    expect(paths.some((path: string) => path.startsWith("google/"))).toBe(false);
    const hidden = await json(application, "/api/files/content?path=google/work/credentials.json");
    expect(hidden.status).toBe(403);

    const removed = await json(application, "/api/connections/google/work", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(existsSync(join(root!, ".data", "google", "work"))).toBe(false);
    const gone = await json(application, "/api/connections/google/work", { method: "DELETE" });
    expect(gone.status).toBe(404);
  });

  it("rejects bad labels, bad services, and a stale callback state", async () => {
    const application = app();
    await json(application, "/api/connections/google/client", {
      method: "PUT",
      body: JSON.stringify({ client_id: "cid", client_secret: "cs" }),
    });

    const badLabel = await json(application, "/api/connections/google/start", {
      method: "POST",
      body: JSON.stringify({
        label: "Not A Slug",
        origin: "http://console.local",
        services: [{ id: "gmail", access: "full" }],
      }),
    });
    expect(badLabel.status).toBe(422);

    const badService = await json(application, "/api/connections/google/start", {
      method: "POST",
      body: JSON.stringify({
        label: "work",
        origin: "http://console.local",
        services: [{ id: "minesweeper", access: "full" }],
      }),
    });
    expect(badService.status).toBe(422);

    const stale = await application.handle(
      new Request("http://console.local/api/connections/google/callback?state=unknown&code=c"),
    );
    expect(stale.status).toBe(302);
    expect(stale.headers.get("location")).toContain("error=");
  });

  it("runs the ChatGPT device flow and writes the auth file", async () => {
    const application = app();
    const started = await json(application, "/api/connections/chatgpt/start", { method: "POST" });
    expect(started.status).toBe(200);
    expect(started.body.userCode).toBe("ABCD-1234");
    expect(started.body.verificationUrl).toContain("device");

    let flow: any;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      flow = (await json(application, `/api/connections/chatgpt/flow/${started.body.flowId}`)).body;
      if (flow.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(flow.status).toBe("done");
    expect(flow.accountId).toBe("acct-1");

    const authFile = JSON.parse(readFileSync(join(root!, ".data", "chatgpt-auth.json"), "utf8"));
    expect(authFile.accountId).toBe("acct-1");

    const overview = await json(application, "/api/connections");
    expect(overview.body.chatgpt).toMatchObject({ connected: true, accountId: "acct-1" });
  });
});
