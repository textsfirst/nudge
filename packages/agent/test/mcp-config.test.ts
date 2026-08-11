import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  interpolateEnvRefs,
  listEnabledMcpServers,
  parseMcpConfig,
  readMcpConfig,
  validateDataFile,
} from "../src/index.js";

const VALID = JSON.stringify({
  version: 1,
  servers: {
    github: {
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" },
    },
    memory: { transport: "stdio", command: "npx", args: ["-y", "server-memory"] },
    parked: { transport: "http", url: "https://example.com/other", enabled: false },
  },
});

function registryDir(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nudge-mcp-"));
  mkdirSync(join(dir, "mcp"));
  writeFileSync(join(dir, "mcp", "servers.json"), content);
  return dir;
}

describe("parseMcpConfig", () => {
  it("accepts the documented shape and defaults enabled to true", () => {
    const parsed = parseMcpConfig(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.servers.github?.enabled).toBe(true);
    expect(parsed.config.servers.parked?.enabled).toBe(false);
    const memory = parsed.config.servers.memory;
    expect(memory?.transport === "stdio" && memory.args).toEqual(["-y", "server-memory"]);
  });

  it("rejects broken JSON with a diagnostic", () => {
    const parsed = parseMcpConfig("{ nope");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("not valid JSON");
  });

  it("rejects bad names, unknown transports, and missing fields, naming the path", () => {
    for (const [config, fragment] of [
      [{ version: 1, servers: { "Bad Name": { transport: "http", url: "x" } } }, "slug"],
      [{ version: 1, servers: { a: { transport: "grpc", url: "x" } } }, "a.transport"],
      [{ version: 1, servers: { a: { transport: "http" } } }, "a.url"],
      [{ version: 1, servers: { a: { transport: "stdio" } } }, "a.command"],
      [{ version: 2, servers: {} }, "version"],
    ] as const) {
      const parsed = parseMcpConfig(JSON.stringify(config));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.toLowerCase()).toContain(fragment.toLowerCase());
    }
  });
});

describe("registry reads", () => {
  it("readMcpConfig returns undefined for absent or invalid files", () => {
    expect(readMcpConfig(mkdtempSync(join(tmpdir(), "nudge-mcp-")))).toBeUndefined();
    expect(readMcpConfig(registryDir("{ nope"))).toBeUndefined();
  });

  it("listEnabledMcpServers filters disabled entries", () => {
    expect(listEnabledMcpServers(registryDir(VALID))).toEqual([
      { name: "github", transport: "http" },
      { name: "memory", transport: "stdio" },
    ]);
  });
});

describe("interpolateEnvRefs", () => {
  it("resolves references and reports the first miss by name", () => {
    expect(interpolateEnvRefs("Bearer ${TOKEN}", { TOKEN: "t" })).toEqual({
      ok: true,
      value: "Bearer t",
    });
    expect(interpolateEnvRefs("${A}:${B}", { A: "a", B: "b" })).toEqual({ ok: true, value: "a:b" });
    expect(interpolateEnvRefs("plain", {})).toEqual({ ok: true, value: "plain" });
    expect(interpolateEnvRefs("${MISSING_ONE}${MISSING_TWO}", {})).toEqual({
      ok: false,
      missing: "MISSING_ONE",
    });
  });
});

describe("validateDataFile on mcp/servers.json", () => {
  it("accepts a valid registry and rejects an invalid one with diagnostics", () => {
    expect(validateDataFile(join("mcp", "servers.json"), VALID)).toBeUndefined();
    const problem = validateDataFile(join("mcp", "servers.json"), '{"version":1}');
    expect(problem).toContain("mcp/servers.json rejected");
    expect(problem).toContain("README.md");
  });
});

describe("mcp prompt guidance", () => {
  const base = {
    systemFile: "x",
    memory: "",
    skills: [],
    carryover: null,
    compactionSummary: null,
    now: new Date(Date.UTC(2026, 7, 10, 15, 0, 0)),
    timeZone: "UTC",
  };
  const servers = [{ name: "github", transport: "http" as const }];

  it("names connected servers only when bash carries the mcp CLI", () => {
    const withMcp = buildSystemPrompt({ ...base, bashEnabled: true, mcpServers: servers });
    expect(withMcp).toContain("MCP servers connected: github");
    expect(withMcp).toContain("mcp call <server> <tool>");

    const noBash = buildSystemPrompt({ ...base, bashEnabled: false, mcpServers: servers });
    expect(noBash).not.toContain("MCP");
    const noServers = buildSystemPrompt({ ...base, bashEnabled: true, mcpServers: [] });
    expect(noServers).not.toContain("MCP");
  });
});
