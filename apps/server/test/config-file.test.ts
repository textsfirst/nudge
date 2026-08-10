import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureSettingsFile,
  loadSettings,
  parseSettings,
  seedText,
} from "../src/config-file.js";

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nudge-config-")), "nudge.config.yaml");
}

describe("seedText", () => {
  it("yields exactly the schema defaults once owner_handle is set", () => {
    const seeded = seedText().replace('owner_handle: ""', 'owner_handle: "+15551234567"');
    expect(parseSettings(seeded)).toEqual(parseSettings('owner_handle: "+15551234567"'));
  });

  it("documents the commented-out optional settings", () => {
    const text = seedText();
    expect(text).toContain("# timezone: America/Los_Angeles");
    expect(text).toContain("# reasoning_effort: medium");
    expect(text).toContain("# firecrawl_url: http://localhost:3002");
    expect(text).toContain('owner_handle: ""');
  });
});

describe("ensureSettingsFile", () => {
  it("seeds a missing file", () => {
    const path = tempConfigPath();
    expect(ensureSettingsFile(path)).toEqual({ created: true, added: [] });
    expect(readFileSync(path, "utf8")).toBe(seedText());
  });

  it("appends missing sections and keys without touching user content", () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      ["# my header note", 'owner_handle: "+15550001111"', "server:", "  port: 4123", ""].join("\n"),
    );
    const result = ensureSettingsFile(path);
    expect(result.created).toBe(false);
    expect(result.added).toContain("provider");
    expect(result.added).toContain("agent");
    expect(result.added).toContain("server.log_level");
    expect(result.added).not.toContain("owner_handle");

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("# my header note");
    expect(raw).toContain("# timezone: America/Los_Angeles");
    const settings = parseSettings(raw);
    expect(settings.owner_handle).toBe("+15550001111");
    expect(settings.server.port).toBe(4123);
    expect(settings.server.log_level).toBe("info");
    expect(settings.agent.max_tool_steps).toBe(64);
  });

  it("inserts a nested key after its known siblings", () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      ['owner_handle: "+15550001111"', "agent:", "  max_tool_steps: 10 # tuned down", ""].join("\n"),
    );
    const result = ensureSettingsFile(path);
    expect(result.added).toContain("agent.max_history_messages");

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("max_tool_steps: 10 # tuned down");
    expect(raw.indexOf("max_tool_steps")).toBeLessThan(raw.indexOf("max_history_messages"));
    expect(parseSettings(raw).agent.max_history_messages).toBe(40);
  });

  it("leaves an up-to-date file unchanged", () => {
    const path = tempConfigPath();
    const content = seedText().replace('owner_handle: ""', 'owner_handle: "+15551234567"');
    writeFileSync(path, content);
    expect(ensureSettingsFile(path)).toEqual({ created: false, added: [] });
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("leaves invalid YAML alone for parseSettings to report", () => {
    const path = tempConfigPath();
    writeFileSync(path, "owner_handle: [unclosed");
    expect(ensureSettingsFile(path)).toEqual({ created: false, added: [] });
    expect(readFileSync(path, "utf8")).toBe("owner_handle: [unclosed");
  });

  it("fills in a comment-only file while keeping the comments", () => {
    const path = tempConfigPath();
    writeFileSync(path, "# just my notes\n");
    const result = ensureSettingsFile(path);
    expect(result.created).toBe(false);
    expect(result.added).toContain("owner_handle");
    expect(readFileSync(path, "utf8")).toContain("# just my notes");
  });
});

describe("loadSettings", () => {
  it("seeds a missing file and asks for owner_handle", () => {
    const path = tempConfigPath();
    expect(() => loadSettings(path)).toThrow(/Created nudge\.config\.yaml/);
    expect(readFileSync(path, "utf8")).toContain('owner_handle: ""');
  });

  it("rejects the still-empty owner_handle with a pointer", () => {
    const path = tempConfigPath();
    ensureSettingsFile(path);
    expect(() => loadSettings(path)).toThrow(/owner_handle: set it to your handle/);
  });

  it("loads once owner_handle is filled in", () => {
    const path = tempConfigPath();
    ensureSettingsFile(path);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('owner_handle: ""', 'owner_handle: "+15551234567"'),
    );
    expect(loadSettings(path).owner_handle).toBe("+15551234567");
  });
});
