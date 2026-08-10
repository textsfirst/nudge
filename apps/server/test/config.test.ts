import { describe, expect, it } from "vitest";
import { loadConfig, parseSettings } from "../src/config.js";

const SECRETS = {
  SPECTRUM_PROJECT_ID: "project-id",
  SPECTRUM_PROJECT_SECRET: "project-secret",
  SPECTRUM_WEBHOOK_SECRET: "webhook-secret",
};

describe("parseSettings", () => {
  it("applies defaults to a minimal file", () => {
    const settings = parseSettings('owner_handle: "+15551234567"');
    expect(settings.provider.selected).toBe("chatgpt-subscription");
    expect(settings.provider.chatgpt.auth_file).toBe(".data/chatgpt-auth.json");
    expect(settings.tools.bash_enabled).toBe(true);
    expect(settings.threads.debounce_ms).toBe(2_500);
    expect(settings.agent.max_tool_steps).toBe(8);
    expect(settings.server.port).toBe(3_000);
  });

  it("rejects a file without owner_handle", () => {
    expect(() => parseSettings("server:\n  port: 3000")).toThrow(/owner_handle/);
  });

  it("rejects malformed YAML with a file-specific message", () => {
    expect(() => parseSettings("owner_handle: [unclosed")).toThrow(/Invalid YAML/);
  });

  it("rejects an invalid timezone", () => {
    expect(() =>
      parseSettings('owner_handle: "+15551234567"\ntimezone: Mars/Olympus'),
    ).toThrow(/timezone/);
  });
});

describe("loadConfig", () => {
  const settings = (yaml: string) => parseSettings(yaml);

  it("combines settings with env secrets", () => {
    const config = loadConfig(SECRETS, settings('owner_handle: "+15551234567"'));
    expect(config.ownerHandle).toBe("+15551234567");
    expect(config.spectrum.projectId).toBe("project-id");
    expect(config.provider.openAiApiKey).toBeUndefined();
    expect(config.firecrawl).toBeUndefined();
    expect(config.idleRolloverMs).toBe(6 * 60 * 60 * 1000);
  });

  it("fails without spectrum secrets", () => {
    expect(() => loadConfig({}, settings('owner_handle: "+15551234567"'))).toThrow(
      /SPECTRUM_PROJECT_ID/,
    );
  });

  it("lets the PORT env var override the yaml port", () => {
    const config = loadConfig(
      { ...SECRETS, PORT: "4123" },
      settings('owner_handle: "+15551234567"\nserver:\n  port: 3000'),
    );
    expect(config.port).toBe(4123);
  });

  it("treats empty optional secrets as absent", () => {
    const config = loadConfig(
      { ...SECRETS, OPENAI_API_KEY: "", FIRECRAWL_API_KEY: "" },
      settings('owner_handle: "+15551234567"'),
    );
    expect(config.provider.openAiApiKey).toBeUndefined();
    expect(config.firecrawl).toBeUndefined();
  });

  it("enables firecrawl from either the env key or the yaml url", () => {
    const fromKey = loadConfig(
      { ...SECRETS, FIRECRAWL_API_KEY: "fc-key" },
      settings('owner_handle: "+15551234567"'),
    );
    expect(fromKey.firecrawl).toEqual({ apiKey: "fc-key" });

    const fromUrl = loadConfig(
      SECRETS,
      settings('owner_handle: "+15551234567"\ntools:\n  firecrawl_url: http://localhost:3002'),
    );
    expect(fromUrl.firecrawl).toEqual({ apiUrl: "http://localhost:3002" });
  });

  it("maps nested yaml values onto the flat config", () => {
    const config = loadConfig(
      { ...SECRETS, OPENAI_API_KEY: "sk-test" },
      settings(
        [
          'owner_handle: "+15551234567"',
          "timezone: America/New_York",
          "provider:",
          "  selected: openai-api",
          "  chatgpt:",
          "    model: gpt-5.6-sol",
          "model:",
          "  reasoning_effort: high",
          "  fast_mode: true",
          "tools:",
          "  bash_enabled: false",
          "threads:",
          "  idle_hours: 2",
          "  debounce_ms: 100",
          "agent:",
          "  max_tool_steps: 20",
          "  max_history_messages: 60",
          "server:",
          "  port: 8080",
          "  log_level: debug",
        ].join("\n"),
      ),
    );
    expect(config.provider.selected).toBe("openai-api");
    expect(config.provider.chatGptModel).toBe("gpt-5.6-sol");
    expect(config.provider.openAiApiKey).toBe("sk-test");
    expect(config.modelOptions).toEqual({ reasoningEffort: "high", serviceTier: "priority" });
    expect(config.bashEnabled).toBe(false);
    expect(config.idleRolloverMs).toBe(2 * 60 * 60 * 1000);
    expect(config.debounceMs).toBe(100);
    expect(config.maxToolSteps).toBe(20);
    expect(config.maxHistoryMessages).toBe(60);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("debug");
    expect(config.timeZone).toBe("America/New_York");
  });
});
