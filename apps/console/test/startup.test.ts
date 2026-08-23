import { describe, expect, it } from "vitest";
import { resolveConsoleRuntime } from "../src/server/startup.js";

describe("console startup configuration", () => {
  it("defaults to a loopback-only console", () => {
    const runtime = resolveConsoleRuntime({});
    expect(runtime).toMatchObject({
      host: "127.0.0.1",
      port: 3100,
      remote: false,
      secureCookies: false,
    });
  });

  it("refuses broad binds unless remote mode is explicit", () => {
    expect(() => resolveConsoleRuntime({ CONSOLE_HOST: "0.0.0.0" })).toThrow(/CONSOLE_REMOTE=1/);
    expect(
      resolveConsoleRuntime({
        CONSOLE_HOST: "0.0.0.0",
        CONSOLE_PORT: "8443",
        CONSOLE_REMOTE: "1",
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      port: 8443,
      remote: true,
      secureCookies: true,
    });
  });
});
