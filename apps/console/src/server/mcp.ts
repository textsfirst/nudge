import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectEnvRefs,
  MCP_CONFIG_PATH,
  MCP_SERVER_NAME_PATTERN,
  parseMcpConfig,
  type McpConfig,
  type McpServerConfig,
} from "@nudge/agent";
import { connectMcpServer } from "@nudge/server/mcp";
import { readEnvKeys } from "./env-file.js";
import { writeDataFile, type FileResult } from "./files.js";

/**
 * Typed console surface over the MCP registry (DATA_DIR/mcp/servers.json).
 * The file stays the single source of truth — the agent edits it mid-thread —
 * so every operation is a fresh read-modify-write, entry-scoped to avoid
 * clobbering neighbours, with a per-entry hash to catch same-entry races.
 */

export interface McpServerView {
  name: string;
  config: McpServerConfig;
  /** Hash of the stored (normalized) entry; echoed back on save as baseHash. */
  hash: string;
  /** ${VAR} references, with whether each is set in .env (or process env). */
  envRefs: { name: string; set: boolean }[];
}

export interface McpOverview {
  path: string;
  exists: boolean;
  /** Parse diagnostics when the file exists but is invalid; servers is empty then. */
  error: string | null;
  servers: McpServerView[];
}

type Registry =
  | { exists: boolean; error: null; config: McpConfig }
  | { exists: true; error: string; config: null };

function readRegistry(dataDir: string): Registry {
  const path = join(dataDir, MCP_CONFIG_PATH);
  if (!existsSync(path)) {
    return { exists: false, error: null, config: { version: 1, servers: {} } };
  }
  const parsed = parseMcpConfig(readFileSync(path, "utf8"));
  return parsed.ok
    ? { exists: true, error: null, config: parsed.config }
    : { exists: true, error: parsed.error, config: null };
}

function entryHash(server: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(server)).digest("hex").slice(0, 16);
}

function view(name: string, server: McpServerConfig, env: Map<string, string>): McpServerView {
  return {
    name,
    config: server,
    hash: entryHash(server),
    envRefs: collectEnvRefs(server).map((ref) => ({
      name: ref,
      set: (env.get(ref) || process.env[ref] || "") !== "",
    })),
  };
}

export function mcpOverview(dataDir: string, envPath: string): McpOverview {
  const registry = readRegistry(dataDir);
  const env = readEnvKeys(envPath);
  return {
    path: MCP_CONFIG_PATH,
    exists: registry.exists,
    error: registry.error,
    servers: registry.config
      ? Object.entries(registry.config.servers).map(([name, server]) => view(name, server, env))
      : [],
  };
}

/**
 * Create or update one server. `baseHash` is the entry hash the caller loaded
 * (null when creating) — a mismatch means the file changed underneath, most
 * likely an agent edit, and the caller should reload rather than overwrite.
 */
export function upsertMcpServer(
  dataDir: string,
  envPath: string,
  name: string,
  server: unknown,
  baseHash: string | null,
): FileResult<McpServerView> {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 422,
      error: `"${name}" is not a valid server name — use a short slug like "github".`,
    };
  }
  const registry = readRegistry(dataDir);
  if (!registry.config) {
    return {
      ok: false,
      status: 409,
      error: `mcp/servers.json is invalid (${registry.error}) — fix it on the Files page first.`,
    };
  }
  const existing = registry.config.servers[name];
  if (baseHash === null && existing) {
    return { ok: false, status: 409, error: `A server named "${name}" already exists.` };
  }
  if (baseHash !== null && !existing) {
    return {
      ok: false,
      status: 409,
      error: `Server "${name}" was deleted while you were editing — reload and try again.`,
    };
  }
  if (baseHash !== null && existing && entryHash(existing) !== baseHash) {
    return {
      ok: false,
      status: 409,
      error: `Server "${name}" changed while you were editing (likely the agent) — reload and try again.`,
    };
  }
  const written = writeRegistry(dataDir, { ...registry.config.servers, [name]: server });
  if (!written.ok) return written;
  // Report the normalized entry (defaults applied) — what overview will show.
  const entry = written.value.servers[name];
  if (!entry) return { ok: false, status: 500, error: `Saved, but "${name}" did not round-trip.` };
  return { ok: true, value: view(name, entry, readEnvKeys(envPath)) };
}

export function deleteMcpServer(dataDir: string, name: string): FileResult<{ name: string }> {
  const registry = readRegistry(dataDir);
  if (!registry.config) {
    return {
      ok: false,
      status: 409,
      error: `mcp/servers.json is invalid (${registry.error}) — fix it on the Files page first.`,
    };
  }
  if (!registry.config.servers[name]) {
    return { ok: false, status: 404, error: `No MCP server "${name}".` };
  }
  const servers = { ...registry.config.servers };
  delete servers[name];
  const written = writeRegistry(dataDir, servers);
  return written.ok ? { ok: true, value: { name } } : written;
}

/** Validate the whole registry through the shared parser, then persist it. */
function writeRegistry(dataDir: string, servers: Record<string, unknown>): FileResult<McpConfig> {
  const serialized = `${JSON.stringify({ version: 1, servers }, null, 2)}\n`;
  const parsed = parseMcpConfig(serialized);
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
  const written = writeDataFile(dataDir, MCP_CONFIG_PATH, serialized);
  if (!written.ok) return written;
  return { ok: true, value: parsed.config };
}

export interface McpTestResult {
  ok: boolean;
  error?: string;
  tools?: { name: string; description: string }[];
  truncated?: boolean;
}

/**
 * Connect and list tools — reachability, auth, and env refs verified in one
 * click. Disabled servers are testable on purpose: the owner checks an entry
 * works before enabling it. A failed test is a 200 with ok:false; only an
 * unknown name or broken registry is an HTTP error.
 */
export async function testMcpServer(
  dataDir: string,
  envPath: string,
  name: string,
): Promise<FileResult<McpTestResult>> {
  const registry = readRegistry(dataDir);
  if (!registry.config) {
    return {
      ok: false,
      status: 409,
      error: `mcp/servers.json is invalid (${registry.error}) — fix it on the Files page first.`,
    };
  }
  const server = registry.config.servers[name];
  if (!server) return { ok: false, status: 404, error: `No MCP server "${name}".` };
  // The CLI resolves ${VAR} from the Nudge server's env, which loads .env at
  // boot; the console reads .env directly so tests see edits without a restart.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(readEnvKeys(envPath)),
  };
  try {
    const connected = await connectMcpServer({ name, config: server, env });
    try {
      const page = await connected.client.listTools({});
      return {
        ok: true,
        value: {
          ok: true,
          tools: page.tools.map((tool) => ({
            name: tool.name,
            description: (tool.description ?? "").split("\n")[0] ?? "",
          })),
          truncated: Boolean(page.nextCursor),
        },
      };
    } finally {
      await connected.close();
    }
  } catch (error) {
    return {
      ok: true,
      value: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
