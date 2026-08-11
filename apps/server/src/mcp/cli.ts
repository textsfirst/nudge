import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseMcpConfig, type McpConfig, type McpServerConfig } from "@nudge/agent";
import { connectMcpServer, McpUserError, type ConnectedMcp } from "./client.js";
import {
  renderCallResult,
  renderResourceContents,
  renderResourceList,
  renderServerList,
  renderToolList,
  renderToolSchema,
} from "./render.js";

/**
 * The agent-facing MCP CLI, driven over bash — the gws pattern: no tool
 * schemas in the prompt, capability discovered per call. Exit codes mirror
 * the gws shim contract:
 *   0 ok · 1 the tool said no (the output says why) · 2 connection, auth, or
 *   registry problem (owner-facing, do not retry) · 3 usage.
 */

const EXIT_OK = 0;
const EXIT_TOOL = 1;
const EXIT_CONFIG = 2;
const EXIT_USAGE = 3;

/** Default well under the bash tool's 120s so our message, not a bash kill, reaches the model. */
const DEFAULT_CALL_TIMEOUT_SECONDS = 60;
const MAX_CALL_TIMEOUT_SECONDS = 600;

const USAGE = `mcp — the owner's connected MCP servers (registry: mcp/servers.json)

  mcp ls                                   servers
  mcp tools <server>                       what a server offers
  mcp schema <server> <tool>               one tool's arguments
  mcp call <server> <tool> ['<json>'] [--timeout <seconds>]
  mcp resources <server>                   resources a server exposes
  mcp read <server> <uri>                  read one resource
`;

type Writable = { write(text: string): unknown };

export async function runMcpCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Writable,
  err: Writable,
): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "--help") {
    (verb ? out : err).write(USAGE);
    return verb ? EXIT_OK : EXIT_USAGE;
  }
  try {
    const config = loadConfig(env);
    switch (verb) {
      case "ls":
        out.write(`${renderServerList(config)}\n`);
        return EXIT_OK;
      case "tools":
        return await withServer(config, rest[0], env, async (name, connected) => {
          const { tools, truncated } = await listAllTools(connected);
          out.write(`${renderToolList(name, tools)}\n`);
          if (truncated) out.write(`[Tool list truncated after ${MAX_LIST_PAGES} pages.]\n`);
          return EXIT_OK;
        });
      case "schema":
        return await withServer(config, rest[0], env, async (name, connected) => {
          const toolName = rest[1];
          if (!toolName) throw new McpUserError("Usage: mcp schema <server> <tool>", EXIT_USAGE);
          const { tools } = await listAllTools(connected);
          const tool = tools.find((entry) => entry.name === toolName);
          if (!tool) {
            out.write(
              `No tool "${toolName}" on ${name}. Tools:\n${tools.map((entry) => `  ${entry.name}`).join("\n")}\n`,
            );
            return EXIT_TOOL;
          }
          out.write(`${renderToolSchema(name, tool)}\n`);
          return EXIT_OK;
        });
      case "call":
        return await withServer(config, rest[0], env, async (name, connected) => {
          const toolName = rest[1];
          if (!toolName) {
            throw new McpUserError("Usage: mcp call <server> <tool> ['<json>']", EXIT_USAGE);
          }
          const { json, timeoutSeconds } = parseCallArguments(rest.slice(2));
          const result = (await connected.client.callTool(
            { name: toolName, arguments: json },
            undefined,
            { timeout: timeoutSeconds * 1_000 },
          )) as CallToolResult;
          out.write(`${renderCallResult(result, saveBinary)}\n`);
          return result.isError ? EXIT_TOOL : EXIT_OK;
        });
      case "resources":
        return await withServer(config, rest[0], env, async (name, connected) => {
          const resources = [];
          let cursor: string | undefined;
          let pages = 0;
          do {
            const page = await connected.client.listResources({ cursor });
            resources.push(...page.resources);
            cursor = page.nextCursor;
            pages += 1;
          } while (cursor && pages < MAX_LIST_PAGES);
          out.write(`${renderResourceList(name, resources)}\n`);
          if (cursor) out.write(`[Resource list truncated after ${MAX_LIST_PAGES} pages.]\n`);
          return EXIT_OK;
        });
      case "read":
        return await withServer(config, rest[0], env, async (_name, connected) => {
          const uri = rest[1];
          if (!uri) throw new McpUserError("Usage: mcp read <server> <uri>", EXIT_USAGE);
          const result = await connected.client.readResource({ uri });
          out.write(`${renderResourceContents(result, saveBinary)}\n`);
          return EXIT_OK;
        });
      default:
        throw new McpUserError(`Unknown command "${verb}".\n${USAGE}`, EXIT_USAGE);
    }
  } catch (error) {
    if (error instanceof McpUserError) {
      err.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof McpError) {
      // The server itself answered with an error: unknown tool, bad
      // arguments, timeout. The message says why; the model can adjust.
      err.write(`${error.message}\n`);
      return EXIT_TOOL;
    }
    err.write(`mcp failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CONFIG;
  }
}

// -- plumbing ---------------------------------------------------------------

function loadConfig(env: NodeJS.ProcessEnv): McpConfig {
  const path = env.NUDGE_MCP_CONFIG;
  if (!path) {
    throw new McpUserError(
      "mcp is managed by Nudge and only available inside its bash tool (NUDGE_MCP_CONFIG is unset).",
      EXIT_USAGE,
    );
  }
  if (!existsSync(path)) {
    throw new McpUserError(
      "No MCP servers are configured yet. Create mcp/servers.json (format in README.md) or " +
        "tell the owner to.",
      EXIT_USAGE,
    );
  }
  const parsed = parseMcpConfig(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    throw new McpUserError(
      `mcp/servers.json is invalid — ${parsed.error}. Fix it (format in README.md).`,
    );
  }
  return parsed.config;
}

/** Resolve the server argument, connect, run, and always close. */
async function withServer(
  config: McpConfig,
  name: string | undefined,
  env: NodeJS.ProcessEnv,
  run: (name: string, connected: ConnectedMcp) => Promise<number>,
): Promise<number> {
  const server = selectServer(config, name);
  const connected = await connectMcpServer({ name: server.name, config: server.config, env });
  try {
    return await run(server.name, connected);
  } finally {
    await connected.close();
  }
}

function selectServer(
  config: McpConfig,
  name: string | undefined,
): { name: string; config: McpServerConfig } {
  const names = Object.keys(config.servers);
  if (names.length === 0) {
    throw new McpUserError(
      "mcp/servers.json has no servers yet (format in README.md).",
      EXIT_USAGE,
    );
  }
  if (!name) {
    throw new McpUserError(`Which server? Available: ${names.join(", ")}.`, EXIT_USAGE);
  }
  const selected = config.servers[name];
  if (!selected) {
    throw new McpUserError(`No MCP server "${name}". Available: ${names.join(", ")}.`, EXIT_USAGE);
  }
  if (!selected.enabled) {
    throw new McpUserError(
      `Server "${name}" is disabled in mcp/servers.json — ask the owner before enabling it.`,
      EXIT_USAGE,
    );
  }
  return { name, config: selected };
}

/** Backstop against a server that returns a cursor forever. */
const MAX_LIST_PAGES = 50;

async function listAllTools(connected: ConnectedMcp): Promise<{ tools: Tool[]; truncated: boolean }> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await connected.client.listTools({ cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < MAX_LIST_PAGES);
  return { tools, truncated: Boolean(cursor) };
}

function parseCallArguments(rest: string[]): {
  json: Record<string, unknown>;
  timeoutSeconds: number;
} {
  let json: Record<string, unknown> = {};
  let seenJson = false;
  let timeoutSeconds = DEFAULT_CALL_TIMEOUT_SECONDS;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--timeout") {
      const value = Number(rest[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new McpUserError("--timeout needs a number of seconds.", EXIT_USAGE);
      }
      timeoutSeconds = Math.min(value, MAX_CALL_TIMEOUT_SECONDS);
      index += 1;
    } else {
      if (seenJson) {
        throw new McpUserError(
          "Pass arguments as one JSON object, not several — check your shell quoting.",
          EXIT_USAGE,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(argument);
      } catch {
        throw new McpUserError(
          `Arguments must be one JSON object (single-quote it for bash), got: ${argument}`,
          EXIT_USAGE,
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new McpUserError("Arguments must be one JSON object, like '{\"key\":\"value\"}'.", EXIT_USAGE);
      }
      json = parsed as Record<string, unknown>;
      seenJson = true;
    }
  }
  return { json, timeoutSeconds };
}

const BINARY_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** Binary blocks spill to a temp file the model can reach through bash. */
function saveBinary(base64: string, mimeType: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  const path = join(dir, `content.${BINARY_EXTENSIONS[mimeType] ?? "bin"}`);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}
