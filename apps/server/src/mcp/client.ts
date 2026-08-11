import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { interpolateEnvRefs, type McpServerConfig } from "@nudge/agent";

/**
 * Per-invocation MCP connections for the mcp CLI. No warm broker on purpose:
 * the streamable-HTTP handshake is one round trip, and holding sessions open
 * would mean an authed localhost surface plus lifecycle coupling to the
 * server process. Startup cost for npx-launched stdio servers is documented
 * in the mcp skill instead.
 */

export const CONNECT_TIMEOUT_MS = 15_000;

/** An owner-facing failure: the message is the diagnosis, exit code included. */
export class McpUserError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
  }
}

export interface ConnectedMcp {
  client: Client;
  close(): Promise<void>;
}

/** `${VAR}` interpolation that turns a miss into owner-facing guidance. */
function resolve(value: string, env: NodeJS.ProcessEnv, server: string): string {
  const outcome = interpolateEnvRefs(value, env);
  if (!outcome.ok) {
    throw new McpUserError(
      `Server "${server}" needs $${outcome.missing}, which is not set. Do not retry — tell the ` +
        "owner to add it on the console's Secrets page (it lands in .env) and restart Nudge.",
    );
  }
  return outcome.value;
}

export async function connectMcpServer(input: {
  name: string;
  config: McpServerConfig;
  env: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
}): Promise<ConnectedMcp> {
  const { name, config, env } = input;
  const client = new Client({ name: "nudge", version: "1.0.0" });

  let transport: StreamableHTTPClientTransport | StdioClientTransport;
  let stderrTail = "";
  if (config.transport === "http") {
    const url = resolve(config.url, env, name);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      headers[key] = resolve(value, env, name);
    }
    transport = new StreamableHTTPClientTransport(parseUrl(url, name, config.url), {
      requestInit: { headers },
    });
  } else {
    // Children get the SDK's minimal environment plus the config's env block —
    // never the full process env, which holds every .env secret. A ${VAR} ref
    // in the env block is how a server is granted a credential.
    const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [key, value] of Object.entries(config.env ?? {})) {
      childEnv[key] = resolve(value, env, name);
    }
    transport = new StdioClientTransport({
      command: resolve(config.command, env, name),
      args: config.args.map((argument) => resolve(argument, env, name)),
      env: childEnv,
      ...(config.cwd ? { cwd: resolve(config.cwd, env, name) } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1_000);
    });
  }

  const close = async (): Promise<void> => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };

  try {
    await withTimeout(
      // The cast bridges the SDK's Transport interface, whose optional
      // callbacks are not declared `| undefined` (exactOptionalPropertyTypes).
      client.connect(transport as Transport),
      input.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      () =>
        new McpUserError(
          `Server "${name}" did not respond within ${Math.round((input.connectTimeoutMs ?? CONNECT_TIMEOUT_MS) / 1_000)}s. ` +
            "A first npx/uvx run can be slow to install — try once more; if it still fails, " +
            "tell the owner it may be down or misconfigured in mcp/servers.json.",
        ),
    );
  } catch (error) {
    await close();
    throw error instanceof McpUserError ? error : connectFailure(name, error, stderrTail);
  }
  return { client, close };
}

/** The error names the raw registry value — the resolved URL may be a secret. */
function parseUrl(resolved: string, server: string, raw: string): URL {
  try {
    return new URL(resolved);
  } catch {
    throw new McpUserError(
      `Server "${server}" has an invalid url in mcp/servers.json: ${raw}`,
    );
  }
}

/** Classify a failed handshake into owner-facing guidance. */
function connectFailure(server: string, error: unknown, stderrTail: string): McpUserError {
  const detail = error instanceof Error ? error.message : String(error);
  if (/\b(401|403|unauthorized|forbidden)\b/i.test(detail)) {
    return new McpUserError(
      `Server "${server}" rejected the connection (${detail.trim()}). Its credentials come ` +
        "from .env — do not retry; tell the owner to check them on the console's Secrets page.",
    );
  }
  const stderr = stderrTail.trim();
  return new McpUserError(
    `Could not connect to server "${server}": ${detail.trim()}` +
      (stderr ? `\nServer output: ${stderr}` : "") +
      "\nDo not retry — tell the owner to check mcp/servers.json.",
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(onTimeout()), ms);
    promise
      .then((value) => resolvePromise(value))
      .catch((error: unknown) => rejectPromise(error instanceof Error ? error : new Error(String(error))))
      .finally(() => clearTimeout(timer));
  });
}
