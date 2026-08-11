import { mcpShimDir } from "../mcp/env.js";
import { delimiter } from "node:path";

/**
 * Environment for the agent's bash tool. The skills shim shares
 * apps/server/bin with gws and mcp, so the PATH prepend is byte-identical and
 * merge order between the builders does not matter.
 */
export function buildSkillsBashEnv(options: { dataDir: string }): Record<string, string> {
  return {
    PATH: `${mcpShimDir()}${delimiter}${process.env.PATH ?? ""}`,
    NUDGE_DATA_DIR: options.dataDir,
  };
}
