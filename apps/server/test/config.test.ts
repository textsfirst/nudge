import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBootstrap, loadConfig, SECRET_SPECS, settingsFromOverrides } from "../src/config.js";

const SECRETS = {
  SPECTRUM_PROJECT_ID: "project-id",
  SPECTRUM_PROJECT_SECRET: "project-secret",
};

const ROOT = "/workspace";

describe("loadBootstrap", () => {
  it("applies defaults when the environment is empty", () => {
    const boot = loadBootstrap({}, ROOT);
    expect(boot.dataDir).toBe("/workspace/.data");
    expect(boot.dbPath).toBe("/workspace/.data/nudge.db");
    expect(boot.port).toBe(3_000);
    expect(boot.logLevel).toBe("info");
  });

  it("reads NUDGE_DATA_DIR, PORT, and LOG_LEVEL from the environment", () => {
    const boot = loadBootstrap(
      { NUDGE_DATA_DIR: "var/nudge", PORT: "4123", LOG_LEVEL: "debug" },
      ROOT,
    );
    expect(boot.dataDir).toBe("/workspace/var/nudge");
    expect(boot.dbPath).toBe("/workspace/var/nudge/nudge.db");
    expect(boot.port).toBe(4_123);
    expect(boot.logLevel).toBe("debug");
  });

  it("treats empty values as unset", () => {
    expect(loadBootstrap({ PORT: "", LOG_LEVEL: "" }, ROOT).port).toBe(3_000);
  });

  it("rejects an invalid port", () => {
    expect(() => loadBootstrap({ PORT: "99999" }, ROOT)).toThrow(/PORT/);
  });
});

describe("loadConfig", () => {
  const boot = loadBootstrap({}, ROOT);
  const settings = (overrides: Record<string, unknown> = {}) =>
    settingsFromOverrides({ owner_handle: "+15551234567", ...overrides });

  it("combines settings with env secrets and bootstrap values", () => {
    const config = loadConfig(SECRETS, settings(), boot);
    expect(config.ownerHandle).toBe("+15551234567");
    expect(config.spectrum.projectId).toBe("project-id");
    expect(config.provider.openAiApiKey).toBeUndefined();
    expect(config.firecrawl).toBeUndefined();
    expect(config.idleRolloverMs).toBe(6 * 60 * 60 * 1000);
    expect(config.dataDir).toBe("/workspace/.data");
    expect(config.dbPath).toBe("/workspace/.data/nudge.db");
    expect(config.systemFilePath).toBe("/workspace/.data/SYSTEM.md");
    expect(config.port).toBe(3_000);
    expect(config.logLevel).toBe("info");
  });

  it("fails without spectrum secrets", () => {
    expect(() => loadConfig({}, settings(), boot)).toThrow(/SPECTRUM_PROJECT_ID/);
  });

  it("treats empty optional secrets as absent", () => {
    const config = loadConfig(
      { ...SECRETS, OPENAI_API_KEY: "", FIRECRAWL_API_KEY: "" },
      settings(),
      boot,
    );
    expect(config.provider.openAiApiKey).toBeUndefined();
    expect(config.firecrawl).toBeUndefined();
  });

  it("enables firecrawl from either the env key or the settings url", () => {
    const fromKey = loadConfig({ ...SECRETS, FIRECRAWL_API_KEY: "fc-key" }, settings(), boot);
    expect(fromKey.firecrawl).toEqual({ apiKey: "fc-key" });

    const fromUrl = loadConfig(
      SECRETS,
      settings({ "tools.firecrawl_url": "http://localhost:3002" }),
      boot,
    );
    expect(fromUrl.firecrawl).toEqual({ apiUrl: "http://localhost:3002" });
  });

  it("maps nested settings onto the flat config", () => {
    const config = loadConfig(
      { ...SECRETS, OPENAI_API_KEY: "sk-test" },
      settings({
        timezone: "America/New_York",
        "provider.selected": "openai-api",
        "provider.chatgpt.model": "gpt-5.6-sol",
        "model.reasoning_effort": "high",
        "model.fast_mode": true,
        "tools.bash_enabled": false,
        "threads.idle_hours": 2,
        "threads.debounce_ms": 100,
        "agent.max_tool_steps": 20,
        "agent.context_window_tokens": 64_000,
        "agent.compact_at_percent": 70,
        "agent.keep_recent_tokens": 10_000,
        "agent.compaction_model": "gpt-5.6-sol",
        "agent.compaction_reasoning_effort": "low",
        "agent.compaction_fast_mode": false,
      }),
      boot,
    );
    expect(config.provider.selected).toBe("openai-api");
    expect(config.provider.chatGptModel).toBe("gpt-5.6-sol");
    expect(config.provider.openAiApiKey).toBe("sk-test");
    expect(config.modelOptions).toEqual({ reasoningEffort: "high", serviceTier: "priority" });
    expect(config.bashEnabled).toBe(false);
    expect(config.idleRolloverMs).toBe(2 * 60 * 60 * 1000);
    expect(config.debounceMs).toBe(100);
    expect(config.maxToolSteps).toBe(20);
    expect(config.contextWindowTokens).toBe(64_000);
    expect(config.compactAtPercent).toBe(70);
    expect(config.keepRecentTokens).toBe(10_000);
    expect(config.compactionModel).toBe("gpt-5.6-sol");
    // Fast mode off leaves the priority tier out of the summarizer options.
    expect(config.compactionModelOptions).toEqual({ reasoningEffort: "low" });
    expect(config.timeZone).toBe("America/New_York");
  });

  it("maps custom provider settings and the CUSTOM_API_KEY secret", () => {
    const config = loadConfig(
      { ...SECRETS, CUSTOM_API_KEY: "ck-test" },
      settings({
        "provider.selected": "custom",
        "provider.custom.base_url": "http://localhost:11434/v1",
        "provider.custom.model": "llama3.3:70b",
        "provider.custom.api": "responses",
      }),
      boot,
    );
    expect(config.provider.selected).toBe("custom");
    expect(config.provider.customBaseUrl).toBe("http://localhost:11434/v1");
    expect(config.provider.customModel).toBe("llama3.3:70b");
    expect(config.provider.customApi).toBe("responses");
    expect(config.provider.customApiKey).toBe("ck-test");
  });

  it("leaves the custom provider fields unset by default", () => {
    const config = loadConfig(SECRETS, settings(), boot);
    expect(config.provider.customBaseUrl).toBeUndefined();
    expect(config.provider.customModel).toBeUndefined();
    expect(config.provider.customApi).toBe("chat-completions");
    expect(config.provider.customApiKey).toBeUndefined();
  });

  it("maps grok provider settings, resolving the auth file from the workspace", () => {
    const config = loadConfig(
      SECRETS,
      settings({
        "provider.selected": "grok-subscription",
        "provider.grok.model": "grok-build",
        "provider.grok.client_version": "0.2.103",
      }),
      boot,
    );
    expect(config.provider.selected).toBe("grok-subscription");
    expect(config.provider.grokModel).toBe("grok-build");
    expect(config.provider.grokAuthFile.endsWith("grok-auth.json")).toBe(true);
    expect(config.provider.grokClientVersion).toBe("0.2.103");

    const defaults = loadConfig(SECRETS, settings(), boot);
    expect(defaults.provider.grokModel).toBe("grok-4.6");
    expect(defaults.provider.grokClientVersion).toBeUndefined();
  });
});

describe("secret metadata", () => {
  it("keeps .env.example aligned with the validated secret list", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const documentedKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
      (match) => match[1],
    );
    expect(documentedKeys).toEqual(SECRET_SPECS.map((secret) => secret.key));
  });
});
