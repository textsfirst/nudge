import { NudgeStore } from "@nudge/store";
import { describe, expect, it } from "vitest";
import { ConnectionHealthMonitor, type ProbeResult } from "../src/health.js";
import type { DeliveryService } from "../src/delivery.js";
import type { Logger } from "@nudge/agent";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeMonitor(results: () => ProbeResult[], deliverResult = true) {
  const store = new NudgeStore(":memory:");
  const sent: string[] = [];
  const delivery = {
    deliver: (_handle: string, body: string) => {
      sent.push(body);
      return Promise.resolve(deliverResult);
    },
  } as unknown as DeliveryService;
  const monitor = new ConnectionHealthMonitor({
    store,
    delivery,
    ownerHandle: "+1",
    logger: silentLogger,
    probes: () => Promise.resolve(results()),
  });
  return { monitor, sent, store };
}

const broken = (id: string): ProbeResult => ({
  id,
  healthy: false,
  brokenMessage: `${id} is broken`,
});
const healthy = (id: string): ProbeResult => ({ id, healthy: true, brokenMessage: "" });

describe("ConnectionHealthMonitor", () => {
  it("texts once per healthy→broken transition, never on repeats", async () => {
    let state: ProbeResult[] = [healthy("google:work")];
    const { monitor, sent } = makeMonitor(() => state);

    await monitor.check();
    expect(sent).toEqual([]);

    state = [broken("google:work")];
    await monitor.check();
    await monitor.check();
    expect(sent).toEqual(["google:work is broken"]);

    // Reconnected, then broken again later: one more text.
    state = [healthy("google:work")];
    await monitor.check();
    state = [broken("google:work")];
    await monitor.check();
    expect(sent).toEqual(["google:work is broken", "google:work is broken"]);
  });

  it("texts for a connection that is broken on first sight", async () => {
    const { monitor, sent } = makeMonitor(() => [broken("chatgpt")]);
    await monitor.check();
    expect(sent).toEqual(["chatgpt is broken"]);
  });

  it("leaves state untouched on uncertain probes", async () => {
    let state: ProbeResult[] = [{ id: "x", healthy: null, brokenMessage: "x is broken" }];
    const { monitor, sent, store } = makeMonitor(() => state);
    await monitor.check();
    expect(sent).toEqual([]);
    expect(store.connectionHealthy("x")).toBeUndefined();

    state = [broken("x")];
    await monitor.check();
    expect(sent).toEqual(["x is broken"]);
  });

  it("retries the notification when delivery has nowhere to send yet", async () => {
    const { monitor, sent, store } = makeMonitor(() => [broken("x")], false);
    await monitor.check();
    await monitor.check();
    // Both passes tried (no space known → not marked broken → retried).
    expect(sent).toEqual(["x is broken", "x is broken"]);
    expect(store.connectionHealthy("x")).toBeUndefined();
  });
});
