import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { node } from "@elysiajs/node";
import { distributionCommands, isReleaseDistribution } from "@nudge/server/distribution";
import { Elysia } from "elysia";
import { createConsoleApp } from "./app.js";
import { ConsoleAuth } from "./auth.js";
import { ConsoleContext } from "./context.js";
import { resolveConsoleRuntime } from "./startup.js";

const publicDir = resolve(fileURLToPath(new URL("../public", import.meta.url)));

/**
 * The handle @elysiajs/node passes to the listen callback: `stop()` closes
 * the listener, and `raw` is the srvx server whose ready() rejects with the
 * listen errors srvx otherwise swallows (`app.server` stays null under the
 * node adapter, so this callback argument is the only handle we get).
 */
interface NodeServerHandle {
  stop(): Promise<void>;
  raw: { ready(): Promise<unknown> };
}

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
      isReleaseDistribution()
        ? "Console UI is missing from this release. Download the edge archive again."
        : `Console UI is not built. Run \`pnpm console:start\` to build and start it, or \`${distributionCommands().console}\` for development.`,
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
  const context = new ConsoleContext();
  const runtime = resolveConsoleRuntime(context.environment());
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

  let server: NodeServerHandle | undefined;
  app.listen({ port: runtime.port, hostname: runtime.host }, (instance) => {
    server = instance as unknown as NodeServerHandle;
  });

  try {
    await server?.raw.ready();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `Nudge Console could not start: port ${runtime.port} is already in use.\n` +
          "Stop the other process or choose another port with CONSOLE_PORT=<port>.",
      );
    } else {
      console.error(
        `Nudge Console server error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    context.close();
    process.exitCode = 1;
    return;
  }

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
    console.log(`  Access code: stored (run \`${distributionCommands().auth}\` to show it)`);
  }
  console.log("  Stop: Ctrl+C\n");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nStopping Nudge Console (${signal})…`);
    await server?.stop();
    context.close();
  };
  const handleSignal = (signal: string) => {
    // srvx's own graceful-shutdown plugin turns itself off when CI or TEST is
    // set, so this handler must fully stop the process on its own; the unref'd
    // timer backstops a close wedged on lingering keep-alive connections.
    const backstop = setTimeout(() => process.exit(process.exitCode ?? 0), 5_000);
    backstop.unref();
    void shutdown(signal)
      .catch((error: unknown) => {
        console.error(`Nudge Console shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      })
      .finally(() => process.exit(process.exitCode ?? 0));
  };
  process.once("SIGINT", () => handleSignal("Ctrl+C"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(
    `Nudge Console could not start.\n\n${error instanceof Error ? error.message : String(error)}\n\n` +
      `Try \`${distributionCommands().console}\` or check the CONSOLE_* settings in .env.`,
  );
  process.exitCode = 1;
});
