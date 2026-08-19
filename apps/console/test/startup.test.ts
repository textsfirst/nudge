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
      browserUrl: "http://localhost:3100",
    });
    expect(runtime.allowedOrigins).toContain("http://127.0.0.1:3100");
  });

  it("uses the development UI origin for browser guidance and validation", () => {
    const runtime = resolveConsoleRuntime({ CONSOLE_UI_ORIGIN: "http://localhost:5174" });
    expect(runtime.browserUrl).toBe("http://localhost:5174");
    expect(runtime.apiUrl).toBe("http://localhost:3100");
    expect(runtime.allowedOrigins).toContain("http://localhost:5174");
  });

  it("refuses broad binds unless secure remote mode is explicit", () => {
    expect(() => resolveConsoleRuntime({ CONSOLE_HOST: "0.0.0.0" })).toThrow(/CONSOLE_REMOTE=1/);
    expect(() =>
      resolveConsoleRuntime({ CONSOLE_HOST: "0.0.0.0", CONSOLE_REMOTE: "1" }),
    ).toThrow(/HTTPS CONSOLE_PUBLIC_ORIGIN/);
    expect(() =>
      resolveConsoleRuntime({
        CONSOLE_HOST: "0.0.0.0",
        CONSOLE_REMOTE: "1",
        CONSOLE_PUBLIC_ORIGIN: "http://console.example",
      }),
    ).toThrow(/HTTPS/);
  });

  it("accepts an exact HTTPS public origin in remote mode", () => {
    expect(
      resolveConsoleRuntime({
        CONSOLE_HOST: "0.0.0.0",
        CONSOLE_PORT: "8443",
        CONSOLE_REMOTE: "1",
        CONSOLE_PUBLIC_ORIGIN: "https://console.example",
      }),
    ).toMatchObject({
      remote: true,
      secureCookies: true,
      browserUrl: "https://console.example",
      allowedOrigins: ["https://console.example"],
    });
  });
});
