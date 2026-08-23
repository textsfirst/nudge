import type { ConsoleApp } from "../src/server/app.js";

export const TEST_ORIGIN = "http://console.local";
export const TEST_CAPABILITY = "A".repeat(43);

interface TestSession {
  cookie: string;
  csrfToken: string;
}

const sessions = new WeakMap<object, TestSession>();

export const secureTestOptions = {
  authCapability: TEST_CAPABILITY,
} as const;

export async function testSession(app: ConsoleApp): Promise<TestSession> {
  const existing = sessions.get(app);
  if (existing) return existing;
  const response = await app.handle(
    new Request(`${TEST_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ capability: TEST_CAPABILITY }),
    }),
  );
  if (!response.ok) throw new Error(`Test login failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Test login did not set a session cookie.");
  const session = { cookie, csrfToken: body.csrfToken };
  sessions.set(app, session);
  return session;
}

export async function authenticatedRequest(
  app: ConsoleApp,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const session = await testSession(app);
  const method = (init?.method ?? "GET").toUpperCase();
  const unsafe = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  return app.handle(
    new Request(`${TEST_ORIGIN}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookie,
        ...(unsafe ? { "X-Nudge-CSRF": session.csrfToken } : {}),
        ...init?.headers,
      },
    }),
  );
}

export async function json(
  app: ConsoleApp,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await authenticatedRequest(app, path, init);
  return { status: response.status, body: await response.json() };
}
