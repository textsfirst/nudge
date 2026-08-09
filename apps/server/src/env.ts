import { config as loadDotEnv } from "dotenv";
import { resolveFromWorkspace } from "./paths.js";

export function loadWorkspaceEnvironment(): void {
  loadDotEnv({
    path: resolveFromWorkspace(".env"),
    quiet: true,
  });
}
