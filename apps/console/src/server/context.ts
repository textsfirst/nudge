import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot } from "@nudge/server/paths";
import { CONFIG_FILE, parseSettings, type Settings } from "@nudge/server/config";
import { NudgeStore } from "@nudge/store";

export interface ConsoleOptions {
  /** Workspace root; tests point this at a temp directory. */
  root?: string | undefined;
}

export interface SettingsSnapshot {
  raw: string | undefined;
  settings: Settings | undefined;
  error: string | undefined;
}

/**
 * Everything the console knows about the Nudge checkout it manages. Settings
 * are re-read per request — the console exists to edit them, so nothing may
 * cache a broken (or stale) copy. The console must boot and stay useful while
 * nudge.config.yaml is missing or invalid; only defaults degrade.
 */
export class ConsoleContext {
  readonly root: string;
  #store: NudgeStore | undefined;
  #storePath: string | undefined;

  constructor(options: ConsoleOptions = {}) {
    this.root = options.root ?? findWorkspaceRoot();
  }

  get configPath(): string {
    return join(this.root, CONFIG_FILE);
  }

  get envPath(): string {
    return join(this.root, ".env");
  }

  settings(): SettingsSnapshot {
    let raw: string | undefined;
    try {
      raw = readFileSync(this.configPath, "utf8");
    } catch {
      return { raw: undefined, settings: undefined, error: `${CONFIG_FILE} is missing.` };
    }
    try {
      return { raw, settings: parseSettings(raw), error: undefined };
    } catch (error) {
      return {
        raw,
        settings: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  dataDir(settings = this.settings().settings): string {
    return resolve(this.root, settings?.data_dir ?? ".data");
  }

  dbPath(settings = this.settings().settings): string {
    return join(this.dataDir(settings), "nudge.db");
  }

  dbExists(): boolean {
    return existsSync(this.dbPath());
  }

  /** Shared store handle, reopened if a config edit moved data_dir. */
  store(): NudgeStore {
    const path = this.dbPath();
    if (!this.#store || this.#storePath !== path) {
      this.#store?.close();
      this.#store = new NudgeStore(path);
      this.#storePath = path;
    }
    return this.#store;
  }

  close(): void {
    this.#store?.close();
    this.#store = undefined;
    this.#storePath = undefined;
  }
}
