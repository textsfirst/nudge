import { existsSync } from "node:fs";
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
