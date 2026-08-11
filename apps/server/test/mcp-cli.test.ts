import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { mcpShimDir } from "../src/mcp/env.js";

const run = promisify(execFile);
const CLI = join(mcpShimDir(), "mcp");
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));
/** tsx-fallback launches compile TypeScript per exec — give them room. */
const SLOW = 30_000;

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeRegistry(servers: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "mcp-cli-"));
  mkdirSync(join(root, "mcp"));
  const path = join(root, "mcp", "servers.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers }));
  return path;
}

const STDIO_FIXTURE = {
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  env: { FIXTURE_ENV: "${FIXTURE_SECRET}" },
};

async function cli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(CLI, args, {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("mcp CLI", () => {
  it("refuses to run outside Nudge's bash tool", { timeout: SLOW }, async () => {
    const result = await cli(["ls"], {});
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("NUDGE_MCP_CONFIG");
  });

  it("explains when no registry exists yet", { timeout: SLOW }, async () => {
    root = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const result = await cli(["ls"], {
      NUDGE_MCP_CONFIG: join(root, "mcp", "servers.json"),
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("No MCP servers are configured");
  });

  it("surfaces registry diagnostics instead of a stack trace", { timeout: SLOW }, async () => {
    const path = makeRegistry({ broken: { transport: "grpc" } });
    const result = await cli(["ls"], { NUDGE_MCP_CONFIG: path });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("mcp/servers.json is invalid");
  });

  it("lists servers without connecting, marking disabled ones", { timeout: SLOW }, async () => {
    const path = makeRegistry({
      fixture: STDIO_FIXTURE,
      parked: { transport: "http", url: "https://example.invalid/mcp", enabled: false },
    });
    const result = await cli(["ls"], { NUDGE_MCP_CONFIG: path });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("fixture");
    expect(result.stdout).toContain("stdio");
    expect(result.stdout).toContain("parked");
    expect(result.stdout).toContain("(disabled)");
  });

  it("names the unknown server and the available ones", { timeout: SLOW }, async () => {
    const path = makeRegistry({ fixture: STDIO_FIXTURE });
    const result = await cli(["tools", "nope"], { NUDGE_MCP_CONFIG: path });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('No MCP server "nope"');
    expect(result.stderr).toContain("fixture");
  });

  it("reports a missing ${VAR} with owner guidance, without connecting", { timeout: SLOW }, async () => {
    const path = makeRegistry({ fixture: STDIO_FIXTURE });
    const result = await cli(["call", "fixture", "echo", '{"message":"hi"}'], {
      NUDGE_MCP_CONFIG: path,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("$FIXTURE_SECRET");
    expect(result.stderr).toContain("Secrets page");
  });

  it("discovers and calls a stdio server end to end", { timeout: SLOW }, async () => {
    const path = makeRegistry({ fixture: STDIO_FIXTURE });
    const env = { NUDGE_MCP_CONFIG: path, FIXTURE_SECRET: "s3cret" };

    const tools = await cli(["tools", "fixture"], env);
    expect(tools.code).toBe(0);
    expect(tools.stdout).toContain("echo — Echo a message back.");

    const schema = await cli(["schema", "fixture", "echo"], env);
    expect(schema.code).toBe(0);
    expect(schema.stdout).toContain("message");
    expect(schema.stdout).toContain("required");
    expect(schema.stdout).toContain("mcp call fixture echo");

    // The env block's ${VAR} reference reaches the child resolved, while the
    // rest of the CLI's environment (every .env secret) stays out of it.
    const call = await cli(["call", "fixture", "echo", '{"message":"hi"}'], {
      ...env,
      LEAK_PROBE: "should-not-reach-the-server",
    });
    expect(call.code).toBe(0);
    expect(call.stdout).toContain("echo: hi (FIXTURE_ENV=s3cret, LEAK_PROBE=)");
  });

  it("maps isError results to exit 1 with the tool's own message", { timeout: SLOW }, async () => {
    const path = makeRegistry({ fixture: STDIO_FIXTURE });
    const result = await cli(["call", "fixture", "explode"], {
      NUDGE_MCP_CONFIG: path,
      FIXTURE_SECRET: "x",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("exploded");
  });

  it("lists and reads resources", { timeout: SLOW }, async () => {
    const path = makeRegistry({ fixture: STDIO_FIXTURE });
    const env = { NUDGE_MCP_CONFIG: path, FIXTURE_SECRET: "x" };
    const resources = await cli(["resources", "fixture"], env);
    expect(resources.code).toBe(0);
    expect(resources.stdout).toContain("fixture://greeting");

    const read = await cli(["read", "fixture", "fixture://greeting"], env);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("hello from the fixture");
  });

  it("rejects arguments that are not one JSON object", { timeout: SLOW }, async () => {
    const path = makeRegistry({ fixture: STDIO_FIXTURE });
    const result = await cli(["call", "fixture", "echo", "not-json"], {
      NUDGE_MCP_CONFIG: path,
      FIXTURE_SECRET: "x",
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("JSON object");
  });

  it("talks streamable HTTP with interpolated auth headers", { timeout: SLOW }, async () => {
    const server = httpFixture("Bearer good-token");
    const port = await listen(server);
    try {
      const path = makeRegistry({
        remote: {
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}" },
        },
      });

      const ok = await cli(["call", "remote", "ping"], {
        NUDGE_MCP_CONFIG: path,
        MCP_TEST_TOKEN: "good-token",
      });
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("pong");

      const rejected = await cli(["tools", "remote"], {
        NUDGE_MCP_CONFIG: path,
        MCP_TEST_TOKEN: "bad-token",
      });
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain("Secrets page");
    } finally {
      server.close();
    }
  });
});

/** A stateless streamable-HTTP MCP server that checks the Authorization header. */
function httpFixture(expectedAuthorization: string): Server {
  return createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const mcp = new McpServer({ name: "http-fixture", version: "1.0.0" });
      mcp.registerTool("ping", { description: "Ping." }, () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
      }
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}
