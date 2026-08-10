import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gwsShimDir } from "../src/google.js";

const run = promisify(execFile);
const SHIM = join(gwsShimDir(), "gws");

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeGoogleDir(accounts: { label: string; email: string }[]): string {
  root = mkdtempSync(join(tmpdir(), "gws-shim-"));
  const googleDir = join(root, "google");
  mkdirSync(googleDir, { recursive: true });
  writeFileSync(
    join(googleDir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: accounts.map((account) => ({ ...account, scopes: [], connectedAt: "2026-01-01" })),
    }),
  );
  for (const account of accounts) {
    mkdirSync(join(googleDir, account.label));
    writeFileSync(join(googleDir, account.label, "credentials.json"), "{}");
  }
  return googleDir;
}

/** A fake real-gws that prints the env selection the shim made. */
function makeFakeGws(): string {
  const binDir = join(root!, "fake-bin");
  mkdirSync(binDir);
  const binary = join(binDir, "gws");
  writeFileSync(
    binary,
    `#!/usr/bin/env bash
echo "args:$@"
echo "creds:$GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"
echo "config:$GOOGLE_WORKSPACE_CLI_CONFIG_DIR"
if [ "$1" = "fail-auth" ]; then exit 2; fi
`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

async function shim(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(SHIM, args, {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("gws shim", () => {
  it("refuses to run outside Nudge's bash tool", async () => {
    const result = await shim(["gmail"], {});
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("NUDGE_GOOGLE_DIR");
  });

  it("lists accounts as JSON, marking the default", async () => {
    const googleDir = makeGoogleDir([
      { label: "personal", email: "p@gmail.com" },
      { label: "work", email: "w@corp.com" },
    ]);
    const result = await shim(["accounts"], {
      NUDGE_GOOGLE_DIR: googleDir,
      NUDGE_GOOGLE_DEFAULT_ACCOUNT: "work",
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { label: string; default: boolean }[];
    expect(parsed.map((entry) => entry.label)).toEqual(["personal", "work"]);
    expect(parsed.find((entry) => entry.label === "work")?.default).toBe(true);
  });

  it("blocks gws auth — connections are owner-managed", async () => {
    const googleDir = makeGoogleDir([{ label: "personal", email: "p@gmail.com" }]);
    const result = await shim(["auth", "login"], { NUDGE_GOOGLE_DIR: googleDir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("owner");
  });

  it("demands an explicit account when several are connected and none is default", async () => {
    const googleDir = makeGoogleDir([
      { label: "personal", email: "p@gmail.com" },
      { label: "work", email: "w@corp.com" },
    ]);
    const result = await shim(["gmail", "+triage"], { NUDGE_GOOGLE_DIR: googleDir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("-a <account>");
    expect(result.stderr).toContain("personal (p@gmail.com)");
  });

  it("execs the real gws with per-account credentials, stripping -a", async () => {
    const googleDir = makeGoogleDir([
      { label: "personal", email: "p@gmail.com" },
      { label: "work", email: "w@corp.com" },
    ]);
    const binary = makeFakeGws();
    const result = await shim(["-a", "work", "gmail", "+triage"], {
      NUDGE_GOOGLE_DIR: googleDir,
      GWS_BINARY: binary,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("args:gmail +triage");
    expect(result.stdout).toContain(`creds:${join(googleDir, "work", "credentials.json")}`);
    expect(result.stdout).toContain(`config:${join(googleDir, "work")}`);
  });

  it("uses the sole account without -a, and finds the binary on PATH", async () => {
    const googleDir = makeGoogleDir([{ label: "personal", email: "p@gmail.com" }]);
    const binary = makeFakeGws();
    const result = await shim(["calendar", "+agenda"], {
      NUDGE_GOOGLE_DIR: googleDir,
      PATH: `${join(root!, "fake-bin")}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`creds:${join(googleDir, "personal", "credentials.json")}`);
    expect(result.stdout).toContain("args:calendar +agenda");
    void binary;
  });

  it("appends an owner-actionable hint on auth failures (exit 2)", async () => {
    const googleDir = makeGoogleDir([{ label: "personal", email: "p@gmail.com" }]);
    const binary = makeFakeGws();
    const result = await shim(["fail-auth"], {
      NUDGE_GOOGLE_DIR: googleDir,
      GWS_BINARY: binary,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("reconnect");
  });

  it("names the missing account and the available ones", async () => {
    const googleDir = makeGoogleDir([{ label: "personal", email: "p@gmail.com" }]);
    const result = await shim(["-a", "nope", "gmail"], { NUDGE_GOOGLE_DIR: googleDir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('No Google account "nope"');
  });

  it("explains when no accounts are connected yet", async () => {
    root = mkdtempSync(join(tmpdir(), "gws-shim-"));
    const googleDir = join(root, "google");
    const result = await shim(["gmail"], { NUDGE_GOOGLE_DIR: googleDir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("No Google accounts are connected");
  });
});
