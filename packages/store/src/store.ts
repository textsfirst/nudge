import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** `error` rows are console-facing diagnostics; the agent excludes them from model context. */
export type MessageRole = "user" | "assistant" | "error";
export type OutboundKind = "reply" | "nudge";
export type OutboundStatus = "pending" | "sending" | "sent" | "failed";

export interface SessionRow {
  id: number;
  handle: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  endReason: string | null;
  summary: string | null;
  carryover: string | null;
  compactedThrough: number;
}

export interface MessageRow {
  id: number;
  sessionId: number;
  handle: string;
  role: MessageRole;
  content: string;
  toolPayload: string | null;
  /** Model-reported prompt tokens for the turn that produced this row; assistant rows only. */
  inputTokens: number | null;
  /** Model-reported completion tokens for the turn that produced this row; assistant rows only. */
  outputTokens: number | null;
  /** JSON turn metrics (model, latency, cache tokens) for the console; assistant rows only. */
  metrics: string | null;
  createdAt: number;
}

/** A session with the aggregates the console's thread list shows. */
export interface SessionSummaryRow extends SessionRow {
  messageCount: number;
  preview: string | null;
}

export interface SpaceRow {
  handle: string;
  spaceId: string;
  platform: string;
  updatedAt: number;
}

export interface ScheduleStateRow {
  entryId: string;
  lastRunAt: number | null;
  claimedAt: number | null;
  completed: boolean;
}

export interface OutboundRow {
  id: number;
  handle: string;
  body: string;
  kind: OutboundKind;
  status: OutboundStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface MaintenanceResult {
  expiredOutbound: number;
  prunedOutbound: number;
  prunedWebhooks: number;
}

/** The live tool-step trace of a session's in-flight turn, for the console. */
export interface TurnProgressRow {
  sessionId: number;
  handle: string;
  startedAt: number;
  updatedAt: number;
  /** JSON array of {tool, input, output} entries — the same shape as a message's tool payload. */
  steps: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_SCHEMA_VERSION = 5;

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  summary TEXT,
  carryover TEXT,
  compacted_through INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(handle) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  handle TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TABLE IF NOT EXISTS spaces (
  handle TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_state (
  entry_id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  claimed_at INTEGER,
  completed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbound_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbound_open ON outbound_ledger(status)
  WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS processed_webhooks (
  message_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connection_health (
  id TEXT PRIMARY KEY,
  healthy INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

type Migration = (db: DatabaseSync) => void;

/**
 * Ordered, append-only database migrations. `PRAGMA user_version` is advanced
 * only after each migration succeeds, so a failed upgrade is rolled back and
 * retried cleanly on the next open.
 */
const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(INITIAL_SCHEMA);
    // Existing databases from before schema versioning can already contain
    // messages. FTS external-content tables do not backfill those rows when
    // first created, so rebuild once while adopting version 1.
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  },
  (db) => {
    // Settings overrides: dotted schema paths mapped to JSON values. Only
    // explicitly-set values are stored; everything else falls back to the
    // schema defaults at read time.
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  },
  (db) => {
    // Live tool-step traces for in-flight turns; the console polls this to
    // show progress. One row per session, deleted when the turn settles.
    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_progress (
        session_id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        steps TEXT NOT NULL
      )
    `);
  },
  (db) => {
    // Model-reported token usage per assistant message, for the console and
    // for observing context pressure. Nullable: user/error rows never have it.
    db.exec("ALTER TABLE messages ADD COLUMN input_tokens INTEGER");
    db.exec("ALTER TABLE messages ADD COLUMN output_tokens INTEGER");
  },
  (db) => {
    // Per-turn model metrics JSON (model id, TTFT, tokens/sec, cache tokens)
    // for the console. Nullable: user/error rows never have it.
    db.exec("ALTER TABLE messages ADD COLUMN metrics TEXT");
  },
];

export class NudgeStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    // The console opens the same file from its own process; wait out short
    // write locks instead of failing immediately.
    this.#db.exec("PRAGMA busy_timeout = 5000");
    try {
      migrate(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  // -- sessions ------------------------------------------------------------

  activeSession(handle: string): SessionRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE handle = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(handle);
    return row ? toSession(row) : undefined;
  }

  startSession(handle: string, at = Date.now(), carryover?: string): SessionRow {
    const result = this.#db
      .prepare(
        "INSERT INTO sessions (handle, started_at, last_activity_at, carryover) VALUES (?, ?, ?, ?)",
      )
      .run(handle, at, at, carryover ?? null);
    const session = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(Number(result.lastInsertRowid));
    if (!session) {
      throw new Error("Failed to read back the session that was just created");
    }
    return toSession(session);
  }

  touchSession(id: number, at = Date.now()): void {
    this.#db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(at, id);
  }

  endSession(id: number, reason: string, at = Date.now()): void {
    this.#db
      .prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
      .run(at, reason, id);
    this.clearTurnProgress(id);
  }

  setCompaction(id: number, summary: string, throughMessageId: number): void {
    this.#db
      .prepare("UPDATE sessions SET summary = ?, compacted_through = ? WHERE id = ?")
      .run(summary, throughMessageId, id);
  }

  /**
   * Sessions newest-first with the aggregates the console's thread list
   * shows. Console-facing; the agent never sees this.
   */
  listSessions(options?: { limit?: number; offset?: number }): {
    sessions: SessionSummaryRow[];
    total: number;
  } {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const totalRow = this.#db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    const sessions = this.#db
      .prepare(
        `SELECT sessions.*,
           (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id) AS message_count,
           (SELECT content FROM messages WHERE messages.session_id = sessions.id
              ORDER BY messages.id DESC LIMIT 1) AS preview
         FROM sessions ORDER BY sessions.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map((row) => ({
        ...toSession(row),
        messageCount: requiredNumber(row, "message_count"),
        preview: nullableString(row, "preview"),
      }));
    return { sessions, total: totalRow ? requiredNumber(totalRow, "n") : 0 };
  }

  sessionById(id: number): SessionRow | undefined {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  /** Delete a session and all its messages (the FTS trigger prunes the index). */
  deleteSession(id: number): boolean {
    this.#db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    this.clearTurnProgress(id);
    const result = this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteMessage(id: number): boolean {
    const result = this.#db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // -- messages ------------------------------------------------------------

  appendMessage(input: {
    sessionId: number;
    handle: string;
    role: MessageRole;
    content: string;
    toolPayload?: string;
    inputTokens?: number;
    outputTokens?: number;
    metrics?: string;
    at?: number;
  }): MessageRow {
    const at = input.at ?? Date.now();
    const result = this.#db
      .prepare(
        "INSERT INTO messages (session_id, handle, role, content, tool_payload, input_tokens, output_tokens, metrics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.sessionId,
        input.handle,
        input.role,
        input.content,
        input.toolPayload ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.metrics ?? null,
        at,
      );
    return {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      handle: input.handle,
      role: input.role,
      content: input.content,
      toolPayload: input.toolPayload ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      metrics: input.metrics ?? null,
      createdAt: at,
    };
  }

  // -- turn progress -------------------------------------------------------

  /** Upsert the live tool-step trace for a session's in-flight turn. */
  setTurnProgress(sessionId: number, handle: string, steps: string, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO turn_progress (session_id, handle, started_at, updated_at, steps)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           steps = excluded.steps, updated_at = excluded.updated_at`,
      )
      .run(sessionId, handle, at, at, steps);
  }

  turnProgress(sessionId: number): TurnProgressRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM turn_progress WHERE session_id = ?")
      .get(sessionId);
    return row
      ? {
          sessionId: requiredNumber(row, "session_id"),
          handle: requiredString(row, "handle"),
          startedAt: requiredNumber(row, "started_at"),
          updatedAt: requiredNumber(row, "updated_at"),
          steps: requiredString(row, "steps"),
        }
      : undefined;
  }

  clearTurnProgress(sessionId: number): void {
    this.#db.prepare("DELETE FROM turn_progress WHERE session_id = ?").run(sessionId);
  }

  sessionMessages(sessionId: number, afterMessageId = 0): MessageRow[] {
    return this.#db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id")
      .all(sessionId, afterMessageId)
      .map(toMessage);
  }

  searchMessages(query: string, limit = 8): MessageRow[] {
    const terms = query
      .split(/\s+/)
      .map((term) => term.replaceAll('"', ""))
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"`)
      .join(" ");
    if (!terms) return [];
    return this.#db
      .prepare(
        `SELECT messages.* FROM messages_fts
         JOIN messages ON messages.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(terms, limit)
      .map(toMessage);
  }

  // -- spaces --------------------------------------------------------------

  rememberSpace(handle: string, spaceId: string, platform: string, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO spaces (handle, space_id, platform, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET space_id = excluded.space_id,
           platform = excluded.platform, updated_at = excluded.updated_at`,
      )
      .run(handle, spaceId, platform, at);
  }

  spaceFor(handle: string): SpaceRow | undefined {
    const row = this.#db.prepare("SELECT * FROM spaces WHERE handle = ?").get(handle);
    return row
      ? {
          handle: requiredString(row, "handle"),
          spaceId: requiredString(row, "space_id"),
          platform: requiredString(row, "platform"),
          updatedAt: requiredNumber(row, "updated_at"),
        }
      : undefined;
  }

  // -- schedule state ------------------------------------------------------

  scheduleState(entryId: string): ScheduleStateRow {
    const row = this.#db.prepare("SELECT * FROM schedule_state WHERE entry_id = ?").get(entryId);
    if (!row) {
      return { entryId, lastRunAt: null, claimedAt: null, completed: false };
    }
    return {
      entryId,
      lastRunAt: nullableNumber(row, "last_run_at"),
      claimedAt: nullableNumber(row, "claimed_at"),
      completed: requiredNumber(row, "completed") === 1,
    };
  }

  /**
   * Record when an entry was first seen so recurring schedules fire from that
   * point forward rather than back-filling. No-op for known entries.
   */
  ensureScheduleBaseline(entryId: string, at = Date.now()): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO schedule_state (entry_id, last_run_at) VALUES (?, ?)")
      .run(entryId, at);
  }

  /** Claim an entry for a run. Returns false if it is already claimed or completed. */
  claimScheduleRun(entryId: string, at = Date.now(), staleClaimMs = 10 * 60 * 1000): boolean {
    this.#db
      .prepare("INSERT OR IGNORE INTO schedule_state (entry_id) VALUES (?)")
      .run(entryId);
    const result = this.#db
      .prepare(
        `UPDATE schedule_state SET claimed_at = ?
         WHERE entry_id = ? AND completed = 0
           AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(at, entryId, at - staleClaimMs);
    return result.changes > 0;
  }

  finishScheduleRun(entryId: string, ranAt = Date.now(), completed = false): void {
    this.#db
      .prepare(
        "UPDATE schedule_state SET last_run_at = ?, claimed_at = NULL, completed = ? WHERE entry_id = ?",
      )
      .run(ranAt, completed ? 1 : 0, entryId);
  }

  releaseScheduleClaim(entryId: string): void {
    this.#db.prepare("UPDATE schedule_state SET claimed_at = NULL WHERE entry_id = ?").run(entryId);
  }

  // -- outbound ledger -----------------------------------------------------

  enqueueOutbound(handle: string, body: string, kind: OutboundKind, at = Date.now()): number {
    const result = this.#db
      .prepare(
        "INSERT INTO outbound_ledger (handle, body, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(handle, body, kind, at, at);
    return Number(result.lastInsertRowid);
  }

  markOutbound(id: number, status: OutboundStatus, at = Date.now()): number {
    this.#db
      .prepare(
        "UPDATE outbound_ledger SET status = ?, updated_at = ?, attempts = attempts + ? WHERE id = ?",
      )
      .run(status, at, status === "sending" ? 1 : 0, id);
    const row = this.#db.prepare("SELECT attempts FROM outbound_ledger WHERE id = ?").get(id);
    if (!row) throw new Error(`No outbound ledger entry ${id}`);
    return requiredNumber(row, "attempts");
  }

  openOutbound(maxAgeMs = 24 * 60 * 60 * 1000, maxAttempts = 3, now = Date.now()): OutboundRow[] {
    return this.#db
      .prepare(
        `SELECT * FROM outbound_ledger
         WHERE status IN ('pending', 'sending') AND created_at > ? AND attempts < ?
         ORDER BY id`,
      )
      .all(now - maxAgeMs, maxAttempts)
      .map(toOutbound);
  }

  // -- connection health ---------------------------------------------------

  /** Last recorded state for a connection id, or undefined if never recorded. */
  connectionHealthy(id: string): boolean | undefined {
    const row = this.#db.prepare("SELECT healthy FROM connection_health WHERE id = ?").get(id);
    return row ? requiredNumber(row, "healthy") === 1 : undefined;
  }

  setConnectionHealthy(id: string, healthy: boolean, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO connection_health (id, healthy, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET healthy = excluded.healthy, updated_at = excluded.updated_at`,
      )
      .run(id, healthy ? 1 : 0, at);
  }

  // -- settings ------------------------------------------------------------

  /** Explicit setting overrides: dotted schema paths mapped to JSON values. */
  settingsOverrides(): Record<string, unknown> {
    const overrides: Record<string, unknown> = {};
    for (const row of this.#db.prepare("SELECT key, value FROM settings ORDER BY key").all()) {
      try {
        overrides[requiredString(row, "key")] = JSON.parse(requiredString(row, "value"));
      } catch {
        // A corrupt row falls back to the schema default for that key.
      }
    }
    return overrides;
  }

  /** Replace the full override set — a settings save is always a whole form. */
  replaceSettingsOverrides(overrides: Record<string, unknown>, at = Date.now()): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM settings").run();
      const insert = this.#db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      );
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        insert.run(key, JSON.stringify(value), at);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  // -- maintenance ---------------------------------------------------------

  /**
   * Bound operational bookkeeping without deleting conversation history.
   * Open sends outside the retry contract become terminal failures, webhook
   * ids are retained for 30 days, and terminal ledger rows for 90 days.
   */
  maintain(options: {
    now?: number;
    webhookRetentionMs?: number;
    outboundRetentionMs?: number;
    outboundMaxAgeMs?: number;
    outboundMaxAttempts?: number;
  } = {}): MaintenanceResult {
    const now = options.now ?? Date.now();
    const webhookRetentionMs = options.webhookRetentionMs ?? 30 * DAY_MS;
    const outboundRetentionMs = options.outboundRetentionMs ?? 90 * DAY_MS;
    const outboundMaxAgeMs = options.outboundMaxAgeMs ?? DAY_MS;
    const outboundMaxAttempts = options.outboundMaxAttempts ?? 3;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const expiredOutbound = Number(
        this.#db
          .prepare(
            `UPDATE outbound_ledger SET status = 'failed', updated_at = ?
             WHERE status IN ('pending', 'sending')
               AND (created_at <= ? OR attempts >= ?)`,
          )
          .run(now, now - outboundMaxAgeMs, outboundMaxAttempts).changes,
      );
      const prunedOutbound = Number(
        this.#db
          .prepare(
            `DELETE FROM outbound_ledger
             WHERE status IN ('sent', 'failed') AND updated_at <= ?`,
          )
          .run(now - outboundRetentionMs).changes,
      );
      const prunedWebhooks = Number(
        this.#db
          .prepare("DELETE FROM processed_webhooks WHERE processed_at <= ?")
          .run(now - webhookRetentionMs).changes,
      );
      this.#db.exec("COMMIT");
      return { expiredOutbound, prunedOutbound, prunedWebhooks };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Remove state for schedule entries that no longer exist after a valid reload. */
  pruneScheduleState(activeEntryIds: readonly string[]): number {
    if (activeEntryIds.length === 0) {
      return Number(this.#db.prepare("DELETE FROM schedule_state").run().changes);
    }
    const placeholders = activeEntryIds.map(() => "?").join(", ");
    return Number(
      this.#db
        .prepare(`DELETE FROM schedule_state WHERE entry_id NOT IN (${placeholders})`)
        .run(...activeEntryIds).changes,
    );
  }

  /** Carry state forward when a schedule id scheme changes. */
  migrateScheduleState(fromEntryId: string, toEntryId: string): void {
    if (fromEntryId === toEntryId) return;
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO schedule_state
           (entry_id, last_run_at, claimed_at, completed)
         SELECT ?, last_run_at, claimed_at, completed
         FROM schedule_state WHERE entry_id = ?`,
      )
      .run(toEntryId, fromEntryId);
    this.#db.prepare("DELETE FROM schedule_state WHERE entry_id = ?").run(fromEntryId);
  }

  // -- webhook dedupe ------------------------------------------------------

  isWebhookProcessed(messageId: string): boolean {
    return (
      this.#db.prepare("SELECT 1 FROM processed_webhooks WHERE message_id = ?").get(messageId) !==
      undefined
    );
  }

  markWebhookProcessed(messageId: string, at = Date.now()): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO processed_webhooks (message_id, processed_at) VALUES (?, ?)")
      .run(messageId, at);
  }
}

type Row = Record<string, unknown>;

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  const current = requiredNumber(row ?? {}, "user_version");
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`Invalid SQLite schema version ${current}`);
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this Nudge build supports ` +
        `(${CURRENT_SCHEMA_VERSION}). Upgrade Nudge before opening it.`,
    );
  }

  for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS[version - 1];
    if (!migration) throw new Error(`Missing SQLite migration ${version}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      migration(db);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`SQLite migration ${version} failed`, { cause: error });
    }
  }
}

function toSession(row: Row): SessionRow {
  return {
    id: requiredNumber(row, "id"),
    handle: requiredString(row, "handle"),
    startedAt: requiredNumber(row, "started_at"),
    lastActivityAt: requiredNumber(row, "last_activity_at"),
    endedAt: nullableNumber(row, "ended_at"),
    endReason: nullableString(row, "end_reason"),
    summary: nullableString(row, "summary"),
    carryover: nullableString(row, "carryover"),
    compactedThrough: requiredNumber(row, "compacted_through"),
  };
}

function toMessage(row: Row): MessageRow {
  return {
    id: requiredNumber(row, "id"),
    sessionId: requiredNumber(row, "session_id"),
    handle: requiredString(row, "handle"),
    role: requiredString(row, "role") as MessageRole,
    content: requiredString(row, "content"),
    toolPayload: nullableString(row, "tool_payload"),
    inputTokens: nullableNumber(row, "input_tokens"),
    outputTokens: nullableNumber(row, "output_tokens"),
    metrics: nullableString(row, "metrics"),
    createdAt: requiredNumber(row, "created_at"),
  };
}

function toOutbound(row: Row): OutboundRow {
  return {
    id: requiredNumber(row, "id"),
    handle: requiredString(row, "handle"),
    body: requiredString(row, "body"),
    kind: requiredString(row, "kind") as OutboundKind,
    status: requiredString(row, "status") as OutboundStatus,
    attempts: requiredNumber(row, "attempts"),
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
  };
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw invalidColumn(key, "number", value);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalidColumn(key, "finite number", value);
  return number;
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw invalidColumn(key, "string", value);
  return value;
}

function nullableNumber(row: Row, key: string): number | null {
  if (!(key in row)) throw invalidColumn(key, "number or null", undefined);
  return row[key] === null ? null : requiredNumber(row, key);
}

function nullableString(row: Row, key: string): string | null {
  if (!(key in row)) throw invalidColumn(key, "string or null", undefined);
  return row[key] === null ? null : requiredString(row, key);
}

function invalidColumn(key: string, expected: string, value: unknown): Error {
  return new Error(
    `Invalid database column ${key}: expected ${expected}, got ${
      value === undefined ? "missing" : typeof value
    }. The database may be corrupt or incompletely migrated.`,
  );
}
