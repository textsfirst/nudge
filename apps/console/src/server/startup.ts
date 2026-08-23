import { isIP } from "node:net";

export interface ConsoleRuntime {
  port: number;
  host: string;
  remote: boolean;
  secureCookies: boolean;
}

export function resolveConsoleRuntime(environment: NodeJS.ProcessEnv = process.env): ConsoleRuntime {
  const port = parsePort(environment.CONSOLE_PORT, 3_100);
  const host = environment.CONSOLE_HOST?.trim() || "127.0.0.1";
  const remote = environment.CONSOLE_REMOTE === "1";

  if (!isLoopbackHost(host) && !remote) {
    throw new Error(
      `Refusing to bind the console to non-loopback host "${host}" without CONSOLE_REMOTE=1.`,
    );
  }

  return {
    port,
    host,
    remote,
    secureCookies: remote,
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`CONSOLE_PORT must be an integer from 1 to 65535 (received ${JSON.stringify(raw)}).`);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "localhost" || isLoopbackHostname(bare);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return false;
}
