import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot } from "@nudge/server/paths";
import { defaultSettings, settingsFromOverrides, type Settings } from "@nudge/server/config";
import { NudgeStore } from "@nudge/store";
import { readEnvKeys } from "./env-file.js";

export interface ConsoleOptions {
  /** Workspace root; tests point this at a temp directory. */
  root?: string | undefined;
}

export interface SettingsSnapshot {
  settings: Settings;
  overrides: Record<string, unknown>;
  error: string | null;
}

/**
 * Everything the console knows about the Nudge checkout it manages. Settings
 * live in the database and are re-read per request — the console exists to
 * edit them, so nothing may cache a stale copy. Bootstrap values come from
 * the workspace .env (with the process environment as fallback) because they
 * are needed to locate the database in the first place.
 */
export class ConsoleContext {
  readonly root: string;
  #store: NudgeStore | undefined;
  #storePath: string | undefined;

  constructor(options: ConsoleOptions = {}) {
    this.root = options.root ?? findWorkspaceRoot();
  }

  get envPath(): string {
    return join(this.root, ".env");
  }

  #env(key: string): string | undefined {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined) return fromProcess || undefined;
    return readEnvKeys(this.envPath).get(key) || undefined;
  }

  dataDir(): string {
    return resolve(this.root, this.#env("NUDGE_DATA_DIR") ?? ".data");
  }

  serverPort(): number {
    const port = Number(this.#env("PORT"));
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 3_000;
  }

  dbPath(): string {
    return join(this.dataDir(), "nudge.db");
  }

  dbExists(): boolean {
    return existsSync(this.dbPath());
  }

  /**
   * Effective settings from the database, with a defaults fallback so the
   * console stays useful when stored overrides no longer fit the schema.
   */
  settings(): SettingsSnapshot {
    let overrides: Record<string, unknown> = {};
    try {
      overrides = this.store().settingsOverrides();
      return { settings: settingsFromOverrides(overrides), overrides, error: null };
    } catch (error) {
      return {
        settings: defaultSettings(),
        overrides,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Shared store handle, reopened if an env edit moved the data dir. */
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
