import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConsoleApp } from "../src/server/app.js";
import { ConsoleAuth, rotateConsoleCapability } from "../src/server/auth.js";
import { TEST_CAPABILITY, TEST_ORIGIN } from "./auth-helper.js";
import { makeWorkspace } from "./workspace.js";

function workspace(): string {
  return makeWorkspace({ prefix: "console-auth-", env: "PORT=59983\n" });
}

function request(path: string, init?: RequestInit, origin = TEST_ORIGIN): Request {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: {
      ...(init?.method && init.method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

async function login(app: ReturnType<typeof createConsoleApp>, capability = TEST_CAPABILITY) {
  const response = await app.handle(
    request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ capability }),
    }),
  );
  const body = (await response.json()) as { csrfToken?: string; error?: string };
  return {
    response,
    body,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
  };
}

describe("console authentication", () => {
  it("generates and persists a mode-0600 capability", () => {
    const dataDir = join(workspace(), ".data");
    const first = new ConsoleAuth(dataDir);
    expect(first.created).toBe(true);
    expect(first.revealCapability()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(first.file).mode & 0o777).toBe(0o600);

    const second = new ConsoleAuth(dataDir);
    expect(second.created).toBe(false);
    expect(second.revealCapability()).toBe(first.revealCapability());
  });

  it("rotates the capability and invalidates sessions after reload", () => {
    const dataDir = join(workspace(), ".data");
    const before = new ConsoleAuth(dataDir);
    const session = before.issueSession();
    const rotated = rotateConsoleCapability(dataDir);
    expect(rotated).not.toBe(before.revealCapability());

    const after = new ConsoleAuth(dataDir);
    const authenticated = after.session(
      new Request(TEST_ORIGIN, { headers: { Cookie: session.cookie.split(";", 1)[0]! } }),
    );
    expect(authenticated).toBeNull();
  });

  it("requires a valid login and sets a hardened session cookie", async () => {
    const app = createConsoleApp({
      root: workspace(),
      authCapability: TEST_CAPABILITY,
    });

    const unauthenticated = await app.handle(request("/api/settings"));
    expect(unauthenticated.status).toBe(401);

    const wrong = await login(app, "B".repeat(43));
    expect(wrong.response.status).toBe(401);
    expect(wrong.body.error).not.toContain(TEST_CAPABILITY);

    const correct = await login(app);
    expect(correct.response.status).toBe(200);
    expect(correct.body.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
    const setCookie = correct.response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain(TEST_CAPABILITY);

    const status = await app.handle(
      request("/api/auth/status", { headers: { Cookie: correct.cookie } }),
    );
    expect(await status.json()).toMatchObject({ authenticated: true });
  });

  it("does not restrict request hosts or browser origins", async () => {
    const app = createConsoleApp({
      root: workspace(),
      authCapability: TEST_CAPABILITY,
    });
    const otherHost = await app.handle(new Request("http://console.example/api/auth/status"));
    expect(otherHost.status).toBe(200);

    const crossSite = await app.handle(
      request("/api/auth/status", { headers: { "Sec-Fetch-Site": "cross-site" } }),
    );
    expect(crossSite.status).toBe(200);
  });

  it("requires JSON and CSRF for mutations", async () => {
    const app = createConsoleApp({
      root: workspace(),
      authCapability: TEST_CAPABILITY,
    });
    const authenticated = await login(app);

    const missingCsrf = await app.handle(
      request("/api/settings", {
        method: "PUT",
        headers: { Cookie: authenticated.cookie },
        body: JSON.stringify({ settings: {} }),
      }),
    );
    expect(missingCsrf.status).toBe(403);

    const otherOrigin = await app.handle(
      new Request(`${TEST_ORIGIN}/api/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          Cookie: authenticated.cookie,
          "X-Nudge-CSRF": authenticated.body.csrfToken!,
        },
        body: JSON.stringify({ settings: {} }),
      }),
    );
    expect(otherOrigin.status).toBe(200);

    const form = await app.handle(
      new Request(`${TEST_ORIGIN}/api/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: TEST_ORIGIN,
          Cookie: authenticated.cookie,
          "X-Nudge-CSRF": authenticated.body.csrfToken!,
        },
        body: "settings=x",
      }),
    );
    expect(form.status).toBe(415);

    const accepted = await app.handle(
      request("/api/settings", {
        method: "PUT",
        headers: {
          Cookie: authenticated.cookie,
          "X-Nudge-CSRF": authenticated.body.csrfToken!,
        },
        body: JSON.stringify({ settings: {} }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("x-frame-options")).toBe("DENY");
    expect(accepted.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
