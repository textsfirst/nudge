import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { node } from "@elysiajs/node";
import { Elysia } from "elysia";
import { createConsoleApp } from "./app.js";
import { ConsoleAuth } from "./auth.js";
import { ConsoleContext } from "./context.js";
import { resolveConsoleRuntime } from "./startup.js";

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

const STATIC_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function serveStatic(pathname: string): Response {
  if (!existsSync(join(publicDir, "index.html"))) {
    return new Response(
      "Console UI is not built. Run `pnpm console:start` to build and start it, or `pnpm console` for development.",
      {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...STATIC_SECURITY_HEADERS },
      },
    );
  }
  const requested = resolve(publicDir, `.${pathname}`);
  const insidePublicDir = relative(publicDir, requested);
  const target =
    insidePublicDir !== ".." &&
    !insidePublicDir.startsWith(`..${sep}`) &&
    !isAbsolute(insidePublicDir) &&
    extname(requested) !== "" &&
    existsSync(requested)
      ? requested
      : join(publicDir, "index.html");
  return new Response(readFileSync(target), {
    headers: {
      "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "Cache-Control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      ...STATIC_SECURITY_HEADERS,
    },
  });
}

async function main(): Promise<void> {
  const runtime = resolveConsoleRuntime();
  const context = new ConsoleContext();
  const auth = new ConsoleAuth(context.dataDir(), { secureCookies: runtime.secureCookies });

  const app = new Elysia({ adapter: node() })
    .use(
      createConsoleApp({
        root: context.root,
        auth,
        allowedOrigins: runtime.allowedOrigins,
        secureCookies: runtime.secureCookies,
        context,
      }),
    )
    .get("/*", ({ request }) => serveStatic(new URL(request.url).pathname));

  app.listen({ port: runtime.port, hostname: runtime.host }, () => {
    console.log("\nNudge Console is ready");
    console.log(`  Open: ${runtime.browserUrl}`);
    if (runtime.browserUrl !== runtime.apiUrl) console.log(`  API:  ${runtime.apiUrl}`);
    console.log(`  Data: ${context.dataDir()}`);
    if (runtime.remote) console.log("  Mode: remote (HTTPS origin required)");
    if (auth.created) {
      console.log("\nFirst-run console access code:");
      console.log(`  ${auth.revealCapability()}`);
      console.log("\nPaste this code into the login page. It is not part of the URL.");
    } else {
      console.log("  Access code: stored (run `pnpm console:auth` to show it)");
    }
    console.log("  Stop: Ctrl+C\n");
  });

  const server = app.server as Server | null;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nStopping Nudge Console (${signal})…`);
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    context.close();
  };
  const handleSignal = (signal: string) => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(`Nudge Console shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => handleSignal("Ctrl+C"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  server?.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Nudge Console could not start: port ${runtime.port} is already in use.\n` +
          "Stop the other process or choose another port with CONSOLE_PORT=<port>.",
      );
    } else {
      console.error(`Nudge Console server error: ${error.message}`);
    }
    process.exitCode = 1;
  });
}

main().catch((error: unknown) => {
  console.error(
    `Nudge Console could not start.\n\n${error instanceof Error ? error.message : String(error)}\n\n` +
      "Try `pnpm console` for development or check the CONSOLE_* settings in .env.example.",
  );
  process.exitCode = 1;
});
