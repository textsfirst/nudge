import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function findWorkspaceRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

export function resolveFromWorkspace(path: string): string {
  return isAbsolute(path) ? path : resolve(findWorkspaceRoot(), path);
}

/** Default owner-controlled state directory for source and release installs. */
export function defaultDataDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  if (configHome) return resolve(configHome, "nudge");
  return resolve(environment.HOME?.trim() || homedir(), ".config", "nudge");
}

export function resolveDataDir(
  root: string,
  configured: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return configured ? resolve(root, configured) : defaultDataDir(environment);
}

/** Relative owner-state paths, such as provider auth files, live in data_dir. */
export function resolveDataFile(dataDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dataDir, path);
}
