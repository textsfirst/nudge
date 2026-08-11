import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The MCP server registry: DATA_DIR/mcp/servers.json, a file convention like
 * SCHEDULE.md (files are the API). The agent reads and edits it through the
 * normal file tools with validated writes; the mcp CLI in bash consumes it.
 *
 * Secrets never live in the file — values may hold "${VAR}" references,
 * resolved from the owner's .env by the CLI when a server is contacted.
 */

export const MCP_CONFIG_PATH = join("mcp", "servers.json");

/** Names are typed by the agent in every mcp call — keep them short slugs. */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const envValue = z.string();

const httpServerSchema = z.strictObject({
  transport: z.literal("http"),
  url: envValue.min(1),
  headers: z.record(z.string(), envValue).optional(),
  enabled: z.boolean().default(true),
});

const stdioServerSchema = z.strictObject({
  transport: z.literal("stdio"),
  command: envValue.min(1),
  args: z.array(envValue).default([]),
  env: z.record(z.string(), envValue).optional(),
  cwd: envValue.optional(),
  enabled: z.boolean().default(true),
});

const configSchema = z.strictObject({
  version: z.literal(1),
  // Names are re-checked after parse — zod v4 swallows custom key messages.
  servers: z.record(
    z.string(),
    z.discriminatedUnion("transport", [httpServerSchema, stdioServerSchema]),
  ),
});

export type McpServerConfig = z.infer<typeof configSchema>["servers"][string];
export type McpConfig = z.infer<typeof configSchema>;

/** What the prompt line needs: which servers exist, nothing about how to reach them. */
export interface McpServerRef {
  name: string;
  transport: "http" | "stdio";
}

/**
 * Diagnostics-bearing parse, shared by validated writes (files.ts) and the
 * CLI. Error strings are agent-facing: name the problem and where.
 */
export function parseMcpConfig(
  content: string,
): { ok: true; config: McpConfig } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      error: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
    return { ok: false, error: issues.join("; ") };
  }
  for (const name of Object.keys(parsed.data.servers)) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `"${name}" is not a valid server name — use a short slug like "github"`,
      };
    }
  }
  return { ok: true, config: parsed.data };
}

/** The registry, or undefined when absent or invalid — never throws. */
export function readMcpConfig(dataDir: string): McpConfig | undefined {
  const path = join(dataDir, MCP_CONFIG_PATH);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseMcpConfig(readFileSync(path, "utf8"));
    return parsed.ok ? parsed.config : undefined;
  } catch {
    return undefined;
  }
}

/** Enabled entries only — what the prompt line and `mcp ls` show. */
export function listEnabledMcpServers(dataDir: string): McpServerRef[] {
  const config = readMcpConfig(dataDir);
  if (!config) return [];
  return Object.entries(config.servers)
    .filter(([, server]) => server.enabled)
    .map(([name, server]) => ({ name, transport: server.transport }));
}

const ENV_REF_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Resolve "${VAR}" references from the process environment. A miss reports
 * the variable's name so the failure can tell the owner exactly what to add.
 */
export function interpolateEnvRefs(
  value: string,
  env: NodeJS.ProcessEnv,
): { ok: true; value: string } | { ok: false; missing: string } {
  let missing: string | undefined;
  const resolved = value.replaceAll(ENV_REF_PATTERN, (reference, name: string) => {
    const found = env[name];
    if (found === undefined) {
      missing ??= name;
      return reference;
    }
    return found;
  });
  return missing ? { ok: false, missing } : { ok: true, value: resolved };
}
