import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

/**
 * Shared temp-workspace fixture for the console API tests.
 *
 * Every workspace pins NUDGE_DATA_DIR=.data in its .env so no test can ever
 * resolve to the developer's real ~/.config/nudge, and creating one stubs the
 * ambient NUDGE_DATA_DIR/PORT out of process.env — ConsoleContext prefers
 * process.env over the workspace .env, so a developer's exported values would
 * otherwise point every test at their live data directory.
 */

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export interface WorkspaceOptions {
  /** mkdtemp prefix, e.g. "console-mcp-". Defaults to "console-". */
  prefix?: string;
  /** Extra .env lines appended after the NUDGE_DATA_DIR pin. */
  env?: string;
}

export function makeWorkspace(options: WorkspaceOptions = {}): string {
  vi.stubEnv("NUDGE_DATA_DIR", undefined);
  vi.stubEnv("PORT", undefined);
  const root = mkdtempSync(join(tmpdir(), options.prefix ?? "console-"));
  roots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeWorkspaceEnv(root, options.env);
  mkdirSync(join(root, ".data"), { recursive: true });
  return root;
}

/** Rewrites the workspace .env, always keeping the NUDGE_DATA_DIR pin. */
export function writeWorkspaceEnv(root: string, extra = ""): void {
  writeFileSync(join(root, ".env"), `NUDGE_DATA_DIR=.data\n${extra}`);
}
