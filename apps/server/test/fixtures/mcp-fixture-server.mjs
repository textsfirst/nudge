// A minimal stdio MCP server for CLI tests: one happy tool, one erroring
// tool, one resource. Run with `node`, resolved against apps/server's deps.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo a message back. Useful only for tests.",
    inputSchema: { message: z.string().describe("What to echo") },
  },
  ({ message }) => ({
    content: [
      {
        type: "text",
        text:
          `echo: ${message} ` +
          `(FIXTURE_ENV=${process.env.FIXTURE_ENV ?? ""}, LEAK_PROBE=${process.env.LEAK_PROBE ?? ""})`,
      },
    ],
  }),
);

server.registerTool(
  "explode",
  { description: "Always fails with a tool-level error." },
  () => ({ content: [{ type: "text", text: "the fixture exploded, as requested" }], isError: true }),
);

server.registerResource(
  "greeting",
  "fixture://greeting",
  { description: "A canned greeting." },
  (uri) => ({ contents: [{ uri: uri.href, text: "hello from the fixture" }] }),
);

await server.connect(new StdioServerTransport());
