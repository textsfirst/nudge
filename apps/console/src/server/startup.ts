import { isIP } from "node:net";

export interface ConsoleRuntime {
  port: number;
  host: string;
  remote: boolean;
  secureCookies: boolean;
  allowedOrigins: string[];
  browserUrl: string;
  apiUrl: string;
}

export function resolveConsoleRuntime(environment: NodeJS.ProcessEnv = process.env): ConsoleRuntime {
  const port = parsePort(environment.CONSOLE_PORT, 3_100);
  const host = environment.CONSOLE_HOST?.trim() || "127.0.0.1";
  const remote = environment.CONSOLE_REMOTE === "1";
  const publicOrigin = optionalOrigin(environment.CONSOLE_PUBLIC_ORIGIN, "CONSOLE_PUBLIC_ORIGIN");
  const uiOrigin = optionalOrigin(environment.CONSOLE_UI_ORIGIN, "CONSOLE_UI_ORIGIN");

  if (!isLoopbackHost(host) && !remote) {
    throw new Error(
      `Refusing to bind the console to non-loopback host "${host}" without CONSOLE_REMOTE=1. ` +
        "For remote access, terminate TLS and set CONSOLE_PUBLIC_ORIGIN=https://your-console.example.",
    );
  }

  if (remote) {
    if (!publicOrigin || !publicOrigin.startsWith("https://")) {
      throw new Error(
        "Remote console mode requires an exact HTTPS CONSOLE_PUBLIC_ORIGIN (for example https://console.example.com).",
      );
    }
    if (uiOrigin && !uiOrigin.startsWith("https://")) {
      throw new Error("CONSOLE_UI_ORIGIN must also use HTTPS in remote mode.");
    }
    return {
      port,
      host,
      remote: true,
      secureCookies: true,
      allowedOrigins: unique([publicOrigin, ...(uiOrigin ? [uiOrigin] : [])]),
      browserUrl: uiOrigin ?? publicOrigin,
      apiUrl: publicOrigin,
    };
  }

  if (publicOrigin && !isLoopbackHostname(new URL(publicOrigin).hostname)) {
    throw new Error("CONSOLE_PUBLIC_ORIGIN must be loopback unless CONSOLE_REMOTE=1 is set.");
  }
  if (uiOrigin && !isLoopbackHostname(new URL(uiOrigin).hostname)) {
    throw new Error("CONSOLE_UI_ORIGIN must be loopback unless CONSOLE_REMOTE=1 is set.");
  }

  const localOrigins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
  return {
    port,
    host,
    remote: false,
    secureCookies: false,
    allowedOrigins: unique([
      ...localOrigins,
      ...(publicOrigin ? [publicOrigin] : []),
      ...(uiOrigin ? [uiOrigin] : []),
    ]),
    browserUrl: uiOrigin ?? publicOrigin ?? `http://localhost:${port}`,
    apiUrl: publicOrigin ?? `http://localhost:${port}`,
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

function optionalOrigin(raw: string | undefined, name: string): string | undefined {
  if (!raw?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be an absolute http(s) origin.`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must contain only scheme, host, and optional port.`);
  }
  return url.origin;
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
