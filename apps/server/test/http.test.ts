import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(resolve)),
    ),
  );
});

describe("HTTP app", () => {
  it("serves the health probe", async () => {
    const server = createHttpApp().listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await health.json()).toEqual({
      ok: true,
      provider: { ok: true, degraded: false, error: null },
    });
  });

  it("reports provider startup failures through health", async () => {
    const server = createHttpApp({
      ok: false,
      degraded: false,
      error: "ChatGPT auth is invalid. Reconnect it in the console (Connections page).",
    }).listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      ok: false,
      provider: { error: expect.stringContaining("Connections page") },
    });
  });
});
