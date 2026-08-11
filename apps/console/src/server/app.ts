import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatGptAuthManager } from "@nudge/agent";
import { parseSchedule, nextRun } from "@nudge/schedule";
import {
  formatIssues,
  overridesFromSettings,
  SETTINGS_FORM,
  settingsSchema,
  type Settings,
} from "@nudge/server/config";
import { Elysia } from "elysia";
import { ApiProblem, ConnectionsService, type ConnectionsOptions } from "./connections.js";
import { ConsoleContext, type ConsoleOptions } from "./context.js";
import { deleteEnvValue, listSecrets, setEnvValue } from "./env-file.js";
import { deleteDataFile, listDataFiles, readDataFile, writeDataFile } from "./files.js";
import { deleteMcpServer, mcpOverview, testMcpServer, upsertMcpServer } from "./mcp.js";

/**
 * Attachment types the browser may render at the console origin. Nothing here
 * can carry script (no svg, no html); audio/wav is the served voice format.
 */
const INLINE_SAFE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "audio/wav",
  "audio/x-wav",
  "audio/x-caf",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
]);

/**
 * The console API. Everything is owner-facing and assumes a localhost bind —
 * there is deliberately no auth layer; see index.ts.
 */
export function createConsoleApp(
  options: ConsoleOptions & ConnectionsOptions & { adapter?: never } = {},
) {
  const context = new ConsoleContext(options);
  const connections = new ConnectionsService(context, options);

  return (
    new Elysia()
      .onError(({ error, set }) => {
        set.status = error instanceof ApiProblem ? error.status : 500;
        return { error: error instanceof Error ? error.message : String(error) };
      })

      // -- status ----------------------------------------------------------
      .get("/api/status", async () => {
        const snapshot = context.settings();
        const port = context.serverPort();
        const server = await probe(`http://127.0.0.1:${port}/healthz`);
        const missingSecrets = listSecrets(context.envPath)
          .filter((secret) => secret.required && !secret.set)
          .map((secret) => secret.key);
        const authError = await subscriptionAuthError(context.root, snapshot.settings);
        const settingsError =
          snapshot.error ??
          (snapshot.settings.owner_handle === ""
            ? "owner_handle is not set — configure it on the Settings page."
            : null);
        const localStartupError =
          settingsError ??
          (missingSecrets.length > 0
            ? `Missing required secrets: ${missingSecrets.join(", ")}`
            : authError);
        return {
          workspaceRoot: context.root,
          dataDir: context.dataDir(),
          settingsValid: settingsError === null,
          settingsError,
          ownerHandle: snapshot.settings.owner_handle || null,
          serverPort: port,
          serverUp: server.reachable,
          serverHealthy: server.healthy,
          serverError: server.error ?? (!server.reachable ? localStartupError : null),
          dbExists: context.dbExists(),
        };
      })

      // -- settings ---------------------------------------------------------
      .get("/api/settings", () => {
        const snapshot = context.settings();
        return {
          settings: snapshot.settings,
          overrides: snapshot.overrides,
          form: SETTINGS_FORM,
          error: snapshot.error,
        };
      })
      .put("/api/settings", ({ body, set }) => {
        const input = (body as Record<string, unknown>)?.settings;
        const parsed = settingsSchema.safeParse(input ?? {});
        if (!parsed.success) {
          set.status = 422;
          return {
            error: formatIssues(parsed.error),
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          };
        }
        context.store().replaceSettingsOverrides(overridesFromSettings(parsed.data));
        return {
          ok: true,
          settings: parsed.data,
          note: "Settings are read at boot — restart the Nudge server to apply.",
        };
      })

      // -- secrets (values never leave the server) --------------------------
      .get("/api/secrets", () => ({ secrets: listSecrets(context.envPath) }))
      .put("/api/secrets/:key", ({ params, body, set }) => {
        const value = typeof (body as Record<string, unknown>)?.value === "string"
          ? String((body as Record<string, unknown>).value)
          : undefined;
        if (value === undefined || value === "") {
          set.status = 422;
          return { error: "Provide a non-empty value (delete the secret to unset it)." };
        }
        try {
          setEnvValue(context.envPath, params.key, value);
        } catch (error) {
          set.status = 422;
          return { error: error instanceof Error ? error.message : String(error) };
        }
        return { ok: true, note: "Secrets are read at boot — restart the Nudge server to apply." };
      })
      .delete("/api/secrets/:key", ({ params, set }) => {
        if (!deleteEnvValue(context.envPath, params.key)) {
          set.status = 404;
          return { error: `${params.key} is not in .env.` };
        }
        return { ok: true };
      })

      // -- data-dir files ---------------------------------------------------
      .get("/api/files", () => ({ files: listDataFiles(context.dataDir()) }))
      .get("/api/files/content", ({ query, set }) => {
        const result = readDataFile(context.dataDir(), String(query.path ?? ""));
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return result.value;
      })
      .put("/api/files/content", ({ body, set }) => {
        const record = (body ?? {}) as Record<string, unknown>;
        if (typeof record.path !== "string" || typeof record.content !== "string") {
          set.status = 422;
          return { error: "Expected { path, content }." };
        }
        const result = writeDataFile(context.dataDir(), record.path, record.content);
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return result.value;
      })
      .delete("/api/files/content", ({ query, set }) => {
        const result = deleteDataFile(context.dataDir(), String(query.path ?? ""));
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return result.value;
      })

      // -- MCP servers (typed surface over DATA_DIR/mcp/servers.json) -------
      .get("/api/mcp", () => mcpOverview(context.dataDir(), context.envPath))
      .put("/api/mcp/servers/:name", ({ params, body, set }) => {
        const record = (body ?? {}) as Record<string, unknown>;
        const result = upsertMcpServer(
          context.dataDir(),
          context.envPath,
          params.name,
          record.server,
          typeof record.baseHash === "string" ? record.baseHash : null,
        );
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return result.value;
      })
      .delete("/api/mcp/servers/:name", ({ params, set }) => {
        const result = deleteMcpServer(context.dataDir(), params.name);
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return { ok: true };
      })
      .post("/api/mcp/servers/:name/test", async ({ params, set }) => {
        const result = await testMcpServer(context.dataDir(), context.envPath, params.name);
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return result.value;
      })

      // -- connections (Google accounts for gws + ChatGPT subscription) -----
      .get("/api/connections", () => connections.overview())
      .put("/api/connections/google/client", ({ body }) =>
        connections.saveClient((body ?? {}) as Record<string, unknown>),
      )
      .post("/api/connections/google/start", ({ body }) =>
        connections.startGoogle((body ?? {}) as Record<string, unknown>),
      )
      .get("/api/connections/google/callback", ({ query }) =>
        connections.googleCallback(query as Record<string, string | undefined>),
      )
      .delete("/api/connections/google/:label", async ({ params, set }) => {
        if (!(await connections.disconnectGoogle(params.label))) {
          set.status = 404;
          return { error: `No Google account "${params.label}".` };
        }
        return { ok: true };
      })
      .post("/api/connections/chatgpt/start", () => connections.startChatGpt())
      .get("/api/connections/chatgpt/flow/:id", ({ params, set }) => {
        const flow = connections.chatGptFlow(params.id);
        if (!flow) {
          set.status = 404;
          return { error: "No such sign-in attempt — start again." };
        }
        return flow;
      })

      // -- schedule preview -------------------------------------------------
      .post("/api/schedule/preview", ({ body }) => {
        const content = contentOf(body);
        const { entries, errors } = parseSchedule(content);
        const timeZone = context.settings().settings.timezone;
        const now = new Date();
        return {
          errors,
          timeZone,
          entries: entries.map((entry) => {
            const next = nextRun(entry, now, timeZone);
            return {
              name: entry.name,
              kind: entry.when.kind,
              pattern: entry.when.pattern,
              prompt: entry.prompt,
              nextRun: next ? next.toISOString() : null,
            };
          }),
        };
      })

      // -- threads ----------------------------------------------------------
      .get("/api/threads", ({ query }) => {
        const limit = clamp(Number(query.limit ?? 25), 1, 100);
        const offset = Math.max(0, Number(query.offset ?? 0) || 0);
        return context.store().listSessions({ limit, offset });
      })
      .get("/api/threads/:id", ({ params, set }) => {
        const id = Number(params.id);
        const session = context.store().sessionById(id);
        if (!session) {
          set.status = 404;
          return { error: `No thread ${params.id}.` };
        }
        const attachmentsByMessage = context.store().attachmentsForSession(id);
        const messages = context.store().sessionMessages(id).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          toolCalls: parseToolPayload(message.toolPayload),
          inputTokens: message.inputTokens,
          outputTokens: message.outputTokens,
          metrics: parseMetrics(message.metrics),
          attachments: (attachmentsByMessage.get(message.id) ?? []).map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            status: attachment.status,
            transcript: attachment.transcript,
            caption: attachment.caption,
            /** False when the transfer failed — nothing to serve. */
            hasContent: attachment.path !== null || attachment.altPath !== null,
          })),
        }));
        // A live tool-step trace exists only while a turn is in flight. Traces
        // that stopped updating (e.g. the server died mid-turn) are ignored.
        const progress = session.endedAt === null ? context.store().turnProgress(id) : undefined;
        const fresh = progress && Date.now() - progress.updatedAt < 10 * 60 * 1000;
        return {
          session,
          messages,
          progress: fresh
            ? {
                startedAt: progress.startedAt,
                updatedAt: progress.updatedAt,
                toolCalls: parseToolPayload(progress.steps) ?? [],
              }
            : null,
        };
      })
      // Bytes for a stored attachment. The served path comes from the
      // database row, never the request — no traversal surface. Voice serves
      // the browser-playable wav conversion; HEIC serves its jpeg.
      .get("/api/attachments/:id/content", ({ params, set }) => {
        const row = context.store().attachmentById(Number(params.id));
        const relative = row ? (row.altPath ?? row.path) : null;
        if (!row || !relative) {
          set.status = 404;
          return { error: `No stored attachment ${params.id}.` };
        }
        const absolute = resolve(context.dataDir(), relative);
        if (!existsSync(absolute)) {
          set.status = 404;
          return { error: `The stored file for attachment ${params.id} is missing.` };
        }
        const mimeType = row.altPath
          ? row.kind === "voice"
            ? "audio/wav"
            : "image/jpeg"
          : row.mimeType.toLowerCase();
        // The stored MIME comes from the message sender. Only render types
        // that cannot execute script at the console origin; everything else
        // (svg, html, …) downloads as an opaque file.
        const inline = INLINE_SAFE_MIME.has(mimeType);
        // Header values must be Latin-1 and quote-free; the original name
        // rides along RFC 5987-encoded for browsers that use it.
        const asciiName =
          row.name.replace(/["\\\r\n]/g, "").replace(/[^ -~]/g, "_") || "attachment";
        set.headers["content-type"] = inline ? mimeType : "application/octet-stream";
        set.headers["content-disposition"] =
          `${inline ? "inline" : "attachment"}; filename="${asciiName}"; ` +
          `filename*=UTF-8''${encodeURIComponent(row.name)}`;
        set.headers["x-content-type-options"] = "nosniff";
        // Hash-named files never change in place.
        set.headers["cache-control"] = "private, max-age=31536000, immutable";
        return new Uint8Array(readFileSync(absolute));
      })
      .post("/api/threads/:id/end", ({ params, set }) => {
        const id = Number(params.id);
        const session = context.store().sessionById(id);
        if (!session) {
          set.status = 404;
          return { error: `No thread ${params.id}.` };
        }
        if (session.endedAt !== null) {
          set.status = 409;
          return { error: "Thread is already ended." };
        }
        context.store().endSession(id, "console");
        return { ok: true };
      })
      .delete("/api/threads/:id", ({ params, set }) => {
        if (!context.store().deleteSession(Number(params.id))) {
          set.status = 404;
          return { error: `No thread ${params.id}.` };
        }
        return { ok: true };
      })
      .delete("/api/threads/:id/messages/:messageId", ({ params, set }) => {
        if (!context.store().deleteMessage(Number(params.messageId))) {
          set.status = 404;
          return { error: `No message ${params.messageId}.` };
        }
        return { ok: true };
      })
      .get("/api/search", ({ query }) => {
        const text = String(query.q ?? "").trim();
        if (!text) return { hits: [] };
        return {
          hits: context.store().searchMessages(text, 25).map((message) => ({
            id: message.id,
            sessionId: message.sessionId,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          })),
        };
      })
  );
}

export type ConsoleApp = ReturnType<typeof createConsoleApp>;

function contentOf(body: unknown): string {
  const content = (body as Record<string, unknown>)?.content;
  return typeof content === "string" ? content : "";
}


function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function parseToolPayload(payload: string | null): unknown[] | null {
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseMetrics(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function probe(url: string): Promise<{
  reachable: boolean;
  healthy: boolean;
  error: string | null;
}> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    const body = (await response.json().catch(() => null)) as
      | { provider?: { error?: unknown } }
      | null;
    return {
      reachable: true,
      healthy: response.ok,
      error:
        typeof body?.provider?.error === "string"
          ? body.provider.error
          : response.ok
            ? null
            : `Health check failed with HTTP ${response.status}`,
    };
  } catch {
    return { reachable: false, healthy: false, error: null };
  }
}

async function subscriptionAuthError(root: string, settings: Settings): Promise<string | null> {
  if (settings.provider.selected !== "chatgpt-subscription") return null;
  try {
    await new ChatGptAuthManager({
      authFile: resolve(root, settings.provider.chatgpt.auth_file),
    }).validateStored();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
