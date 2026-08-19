import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp, type ConsoleApp } from "../src/server/app.js";
import { json, secureTestOptions } from "./auth-helper.js";

const FIXTURE = fileURLToPath(
  new URL("../../server/test/fixtures/mcp-fixture-server.mjs", import.meta.url),
);
/** Spawning the stdio fixture includes an SDK handshake — give it room. */
const SLOW = 30_000;

let root: string | undefined;

function makeWorkspace(): string {
  root = mkdtempSync(join(tmpdir(), "console-mcp-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(join(root, ".env"), "PORT=59983\n");
  mkdirSync(join(root, ".data"), { recursive: true });
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function app(): ConsoleApp {
  return createConsoleApp({ root: makeWorkspace(), ...secureTestOptions });
}

const registryPath = () => join(root!, ".data", "mcp", "servers.json");

describe("console MCP API", () => {
  it("reports an empty registry before the file exists", async () => {
    const overview = await json(app(), "/api/mcp");
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ exists: false, error: null, servers: [] });
  });

  it("creates a server, tracking its ${VAR} refs against .env", async () => {
    const application = app();
    const created = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({
        server: {
          transport: "http",
          url: "https://example.test/mcp/",
          headers: { Authorization: "Bearer ${NUDGE_TEST_MCP_TOKEN}" },
          enabled: true,
        },
        baseHash: null,
      }),
    });
    expect(created.status).toBe(200);
    expect(created.body.name).toBe("github");
    expect(created.body.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(created.body.envRefs).toEqual([{ name: "NUDGE_TEST_MCP_TOKEN", set: false }]);

    // The file is the store: what landed on disk parses and holds the entry.
    const stored = JSON.parse(readFileSync(registryPath(), "utf8"));
    expect(stored.servers.github.url).toBe("https://example.test/mcp/");

    await json(application, "/api/mcp/servers/memory", {
      method: "PUT",
      body: JSON.stringify({
        server: { transport: "stdio", command: "npx", args: ["-y", "x"], enabled: false },
        baseHash: null,
      }),
    });

    // Setting the secret flips the ref badge without touching the registry.
    await json(application, "/api/secrets/NUDGE_TEST_MCP_TOKEN", {
      method: "PUT",
      body: JSON.stringify({ value: "tok-123" }),
    });
    const overview = await json(application, "/api/mcp");
    expect(overview.body.servers).toHaveLength(2);
    const github = overview.body.servers.find((server: any) => server.name === "github");
    expect(github.envRefs).toEqual([{ name: "NUDGE_TEST_MCP_TOKEN", set: true }]);
    // Values never ride along — only the raw ${VAR} reference the owner wrote.
    expect(JSON.stringify(overview.body)).not.toContain("tok-123");
  });

  it("rejects invalid entries and names with diagnostics", async () => {
    const application = app();
    const badEntry = await json(application, "/api/mcp/servers/broken", {
      method: "PUT",
      body: JSON.stringify({ server: { transport: "http" }, baseHash: null }),
    });
    expect(badEntry.status).toBe(422);
    expect(badEntry.body.error).toContain("url");
    expect(existsSync(registryPath())).toBe(false);

    const badName = await json(application, "/api/mcp/servers/Bad_Name", {
      method: "PUT",
      body: JSON.stringify({
        server: { transport: "http", url: "https://example.test/", enabled: true },
        baseHash: null,
      }),
    });
    expect(badName.status).toBe(422);
    expect(badName.body.error).toContain("slug");
  });

  it("detects concurrent edits through the entry hash", async () => {
    const application = app();
    const entry = {
      transport: "http",
      url: "https://example.test/mcp/",
      enabled: true,
    };
    const created = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({ server: entry, baseHash: null }),
    });

    // Creating over an existing entry is a conflict, not an overwrite.
    const duplicate = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({ server: entry, baseHash: null }),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain("already exists");

    // The agent rewrites the entry between load and save → stale hash → 409.
    writeFileSync(
      registryPath(),
      JSON.stringify({
        version: 1,
        servers: { github: { ...entry, url: "https://changed.test/" } },
      }),
    );
    const stale = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({ server: { ...entry, enabled: false }, baseHash: created.body.hash }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("changed while you were editing");

    // A fresh load carries the current hash and the save goes through.
    const fresh = await json(application, "/api/mcp");
    const saved = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({
        server: { ...entry, enabled: false },
        baseHash: fresh.body.servers[0].hash,
      }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(registryPath(), "utf8")).servers.github.enabled).toBe(false);

    // Editing an entry someone deleted is also a conflict.
    writeFileSync(registryPath(), JSON.stringify({ version: 1, servers: {} }));
    const gone = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({ server: entry, baseHash: saved.body.hash }),
    });
    expect(gone.status).toBe(409);
    expect(gone.body.error).toContain("deleted");
  });

  it("deletes entries, 404ing on the unknown", async () => {
    const application = app();
    await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({
        server: { transport: "http", url: "https://example.test/", enabled: true },
        baseHash: null,
      }),
    });
    const removed = await json(application, "/api/mcp/servers/github", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(JSON.parse(readFileSync(registryPath(), "utf8")).servers).toEqual({});

    const again = await json(application, "/api/mcp/servers/github", { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("surfaces a broken registry instead of editing through it", async () => {
    const application = app();
    mkdirSync(join(root!, ".data", "mcp"), { recursive: true });
    writeFileSync(registryPath(), "not json");

    const overview = await json(application, "/api/mcp");
    expect(overview.body.error).toContain("not valid JSON");
    expect(overview.body.servers).toEqual([]);

    const write = await json(application, "/api/mcp/servers/github", {
      method: "PUT",
      body: JSON.stringify({
        server: { transport: "http", url: "https://example.test/", enabled: true },
        baseHash: null,
      }),
    });
    expect(write.status).toBe(409);
    expect(write.body.error).toContain("Files page");
  });

  it("test-connects a stdio server, resolving ${VAR} from .env", { timeout: SLOW }, async () => {
    const application = app();
    writeFileSync(join(root!, ".env"), "PORT=59983\nFIXTURE_SECRET=from-env\n");
    await json(application, "/api/mcp/servers/fixture", {
      method: "PUT",
      body: JSON.stringify({
        server: {
          transport: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          env: { FIXTURE_ENV: "${FIXTURE_SECRET}" },
          // Disabled on purpose: the owner tests an entry before enabling it.
          enabled: false,
        },
        baseHash: null,
      }),
    });

    const result = await json(application, "/api/mcp/servers/fixture/test", { method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.tools.map((tool: any) => tool.name)).toContain("echo");
  });

  it("reports a missing ${VAR} by name from the test route", { timeout: SLOW }, async () => {
    const application = app();
    await json(application, "/api/mcp/servers/fixture", {
      method: "PUT",
      body: JSON.stringify({
        server: {
          transport: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          env: { FIXTURE_ENV: "${NUDGE_TEST_SURELY_UNSET_VAR}" },
          enabled: true,
        },
        baseHash: null,
      }),
    });
    const result = await json(application, "/api/mcp/servers/fixture/test", { method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain("NUDGE_TEST_SURELY_UNSET_VAR");

    const unknown = await json(application, "/api/mcp/servers/nope/test", { method: "POST" });
    expect(unknown.status).toBe(404);
  });
});
