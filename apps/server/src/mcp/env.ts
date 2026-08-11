import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_CONFIG_PATH } from "@nudge/agent";

/** The directory holding the agent-facing mcp launcher (apps/server/bin). */
export function mcpShimDir(): string {
  return fileURLToPath(new URL("../../bin", import.meta.url));
}

/**
 * Environment for the agent's bash tool, mirroring buildGwsBashEnv. Both
 * shims live in apps/server/bin, so the PATH prepend is byte-identical to
 * gws's and the merge order between the two builders does not matter.
 */
export function buildMcpBashEnv(options: { dataDir: string }): Record<string, string> {
  return {
    PATH: `${mcpShimDir()}${delimiter}${process.env.PATH ?? ""}`,
    NUDGE_MCP_CONFIG: join(options.dataDir, MCP_CONFIG_PATH),
  };
}
