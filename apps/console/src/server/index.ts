import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { node } from "@elysiajs/node";
import { CONFIG_FILE, ensureSettingsFile } from "@nudge/server/config";
import { Elysia } from "elysia";
import { createConsoleApp } from "./app.js";

const PORT = Number(process.env.CONSOLE_PORT ?? 3100);
/**
 * Localhost by default — the console edits secrets and SYSTEM.md with no auth
 * layer of its own. Reach it remotely through a tunnel you trust (Tailscale,
 * ssh -L), not by binding wider.
 */
const HOST = process.env.CONSOLE_HOST ?? "127.0.0.1";

const publicDir = resolve(fileURLToPath(new URL("../public", import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function serveStatic(pathname: string): Response {
  if (!existsSync(join(publicDir, "index.html"))) {
    return new Response(
      "Console UI is not built. Run `pnpm --filter @nudge/console build` (or use `pnpm console` for the dev server).",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const requested = resolve(publicDir, `.${pathname}`);
  const target =
    requested.startsWith(publicDir) && extname(requested) !== "" && existsSync(requested)
      ? requested
      : join(publicDir, "index.html");
  return new Response(readFileSync(target), {
    headers: {
      "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

// Seed or update the settings file so the Config tab always opens with the
// current template instead of an empty editor.
try {
  const ensured = ensureSettingsFile();
  if (ensured.created) {
    console.log(
      JSON.stringify({
        level: "info",
        message: `Created ${CONFIG_FILE} with defaults — set owner_handle in the Config tab.`,
      }),
    );
  } else if (ensured.added.length > 0) {
    console.log(
      JSON.stringify({
        level: "info",
        message: `Added new settings to ${CONFIG_FILE}`,
        added: ensured.added,
      }),
    );
  }
} catch (error) {
  console.log(
    JSON.stringify({
      level: "warn",
      message: `Could not seed ${CONFIG_FILE}`,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

new Elysia({ adapter: node() })
  .use(createConsoleApp())
  .get("/*", ({ request }) => serveStatic(new URL(request.url).pathname))
  .listen({ port: PORT, hostname: HOST }, () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: "Nudge console is listening",
        url: `http://${HOST}:${PORT}`,
      }),
    );
  });
