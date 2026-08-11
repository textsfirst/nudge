import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  overridesFromSettings,
  SETTINGS_FORM,
  settingsFromOverrides,
} from "../src/settings.js";

describe("settingsFromOverrides", () => {
  it("yields pure defaults for an empty override set", () => {
    const settings = settingsFromOverrides({});
    expect(settings.owner_handle).toBe("");
    expect(settings.provider.selected).toBe("chatgpt-subscription");
    expect(settings.provider.chatgpt.auth_file).toBe(".data/chatgpt-auth.json");
    expect(settings.provider.openai.fallback_enabled).toBe(false);
    expect(settings.tools.bash_enabled).toBe(true);
    expect(settings.threads.debounce_ms).toBe(250);
    expect(settings.agent.max_tool_steps).toBe(256);
    expect(settings.agent.compaction_model).toBe("gpt-5.6-luna");
    expect(settings.agent.compaction_reasoning_effort).toBe("high");
    expect(settings.agent.compaction_fast_mode).toBe(true);
    expect(settings.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("expands dotted overrides into the nested settings shape", () => {
    const settings = settingsFromOverrides({
      owner_handle: "+15551234567",
      "provider.selected": "openai-api",
      "threads.idle_hours": 2,
      "model.reasoning_effort": "high",
    });
    expect(settings.owner_handle).toBe("+15551234567");
    expect(settings.provider.selected).toBe("openai-api");
    expect(settings.provider.chatgpt.model).toBeTruthy();
    expect(settings.threads.idle_hours).toBe(2);
    expect(settings.model.reasoning_effort).toBe("high");
  });

  it("rejects overrides that no longer fit the schema, pointing at the console", () => {
    expect(() => settingsFromOverrides({ timezone: "Mars/Olympus" })).toThrow(/timezone/);
    expect(() => settingsFromOverrides({ "threads.idle_hours": 999 })).toThrow(/Settings page/);
  });

  it("ignores overrides for settings that no longer exist", () => {
    // agent.max_history_messages predates token-based compaction; a stored
    // override must not break boot after the upgrade.
    const settings = settingsFromOverrides({ "agent.max_history_messages": 60 });
    expect(settings.agent.context_window_tokens).toBe(0);
    expect(settings.agent.compact_at_percent).toBe(80);
    expect(settings.agent.keep_recent_tokens).toBe(20_000);
  });
});

describe("overridesFromSettings", () => {
  it("stores nothing for pure defaults", () => {
    expect(overridesFromSettings(defaultSettings())).toEqual({});
  });

  it("stores exactly the leaves that differ from the defaults", () => {
    const overrides = {
      owner_handle: "+15551234567",
      "provider.selected": "openai-api",
      "model.fast_mode": true,
      "threads.idle_hours": 2,
      "google.default_account": "personal",
    };
    expect(overridesFromSettings(settingsFromOverrides(overrides))).toEqual(overrides);
  });

  it("drops a timezone matching the machine's, so it keeps tracking the machine", () => {
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(overridesFromSettings(settingsFromOverrides({ timezone: machine }))).toEqual({});
    expect(
      overridesFromSettings(settingsFromOverrides({ timezone: "Pacific/Kiritimati" })),
    ).toEqual({ timezone: "Pacific/Kiritimati" });
  });
});

describe("SETTINGS_FORM", () => {
  it("has exactly one field per schema leaf", () => {
    // Optional leaves are absent from the defaults, so set them all.
    const everyLeaf = settingsFromOverrides({
      timezone: "UTC",
      "provider.custom.base_url": "http://localhost:11434/v1",
      "provider.custom.model": "llama3.3:70b",
      "model.reasoning_effort": "medium",
      "tools.firecrawl_url": "http://localhost:3002",
      "google.default_account": "personal",
      "google.gws_path": "/opt/homebrew/bin/gws",
      "multimodal.transcription_base_url": "https://api.openai.com/v1",
      "multimodal.caption_model": "gpt-5-mini",
      "multimodal.ffmpeg_path": "/opt/homebrew/bin/ffmpeg",
    });
    const flatten = (value: unknown, prefix = "", out: string[] = []): string[] => {
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          flatten(child, prefix ? `${prefix}.${key}` : key, out);
        }
        return out;
      }
      out.push(prefix);
      return out;
    };
    const fieldPaths = SETTINGS_FORM.flatMap((section) =>
      section.fields.map((field) => field.path),
    );
    expect([...fieldPaths].sort()).toEqual(flatten(everyLeaf).sort());
    expect(new Set(fieldPaths).size).toBe(fieldPaths.length);
  });

  it("lists every enum option on select fields", () => {
    for (const field of SETTINGS_FORM.flatMap((section) => section.fields)) {
      if (field.control === "select") {
        expect(field.options?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
