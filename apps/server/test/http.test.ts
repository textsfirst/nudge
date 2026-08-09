import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@nudge/agent";
import type { PhotonTransport } from "@nudge/photon";
import { createHttpApp } from "../src/http.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(resolve)),
    ),
  );
});

describe("HTTP app", () => {
  it("serves health and forwards exact webhook bytes", async () => {
    const webhook = vi.fn(async () => ({
      status: 202,
      headers: { "content-type": "text/plain" },
      body: new TextEncoder().encode("accepted"),
    }));
    const transport: PhotonTransport = {
      webhook,
      sendToSpace: async () => undefined,
      flushInbound: async () => undefined,
      stop: async () => undefined,
    };
    const server = createHttpApp(transport, logger).listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await health.json()).toEqual({ ok: true });

    const payload = '{"event":"messages"}\n';
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/photon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
    expect(webhook.mock.calls[0]?.[0].body.equals(Buffer.from(payload))).toBe(true);
  });
});
