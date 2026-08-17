import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGwsBashEnv,
  exchangeGoogleCode,
  GOOGLE_SKILL_NAME,
  googleAuthUrl,
  googleCredentialsPath,
  gwsShimDir,
  parseGoogleClientInput,
  probeGoogleAccount,
  readGoogleAccounts,
  readGoogleClient,
  removeGoogleAccount,
  saveGoogleAccount,
  saveGoogleClient,
  seedGoogleSkill,
} from "../src/google.js";

const CLIENT = { clientId: "id-123.apps.googleusercontent.com", clientSecret: "s3cret" };

let dataDir: string | undefined;

function makeDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), "google-"));
  return dataDir;
}

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

function idTokenWith(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return `h.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("parseGoogleClientInput", () => {
  it("accepts bare fields, the downloaded web/installed JSON, and raw JSON", () => {
    expect(parseGoogleClientInput({ client_id: "a", client_secret: "b" })).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
    expect(
      parseGoogleClientInput({ json: '{"web":{"client_id":"a","client_secret":"b"}}' }),
    ).toEqual({ clientId: "a", clientSecret: "b" });
    expect(
      parseGoogleClientInput({ json: '{"installed":{"client_id":"a","client_secret":"b"}}' }),
    ).toEqual({ clientId: "a", clientSecret: "b" });
    expect(parseGoogleClientInput({ json: '{"client_id":"a","client_secret":"b"}' })).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
  });

  it("rejects junk with actionable messages", () => {
    expect(() => parseGoogleClientInput({ json: "not json" })).toThrow("not valid JSON");
    expect(() => parseGoogleClientInput({ json: "{}" })).toThrow("client_id");
    expect(() => parseGoogleClientInput({ client_id: "a" })).toThrow("both");
  });
});

describe("client + account persistence", () => {
  it("round-trips the client with restrictive permissions", () => {
    const dir = makeDataDir();
    saveGoogleClient(dir, CLIENT);
    expect(readGoogleClient(dir)).toEqual(CLIENT);
    const mode = statSync(join(dir, "google", "client_secret.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("saves accounts: credentials file for gws, registry entry, seeded skill", () => {
    const dir = makeDataDir();
    const account = saveGoogleAccount(dir, {
      label: "work",
      client: CLIENT,
      tokens: {
        refreshToken: "refresh-1",
        email: "w@corp.com",
        grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
      },
    });
    expect(account.email).toBe("w@corp.com");
    // Base identity scopes are bookkeeping, not grants worth showing.
    expect(account.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);

    const credentials = JSON.parse(readFileSync(googleCredentialsPath(dir, "work"), "utf8"));
    expect(credentials).toEqual({
      type: "authorized_user",
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      refresh_token: "refresh-1",
    });
    expect(statSync(googleCredentialsPath(dir, "work")).mode & 0o777).toBe(0o600);
    expect(readGoogleAccounts(dir).map((entry) => entry.label)).toEqual(["work"]);
    const skill = readFileSync(join(dir, "skills", GOOGLE_SKILL_NAME, "SKILL.md"), "utf8");
    expect(skill).toContain("## Outbound mail: drafts first");
    expect(skill).toContain("gws gmail users drafts create");
  });

  it("upgrades an unmodified prior skill revision in place", () => {
    const dir = makeDataDir();
    const skillDir = join(dir, "skills", GOOGLE_SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    const prior = "---\nname: google-workspace\n---\nold shipped text\n";
    writeFileSync(join(skillDir, "SKILL.md"), prior);
    const hash = createHash("sha256").update(prior).digest("hex");
    seedGoogleSkill(dir, { priorHashes: new Set([hash]) });
    const upgraded = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(upgraded).toContain("## Outbound mail: drafts first");
  });

  it("never touches a customized skill copy", () => {
    const dir = makeDataDir();
    const skillDir = join(dir, "skills", GOOGLE_SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    const custom = "---\nname: google-workspace\n---\nmy own notes\n";
    writeFileSync(join(skillDir, "SKILL.md"), custom);
    seedGoogleSkill(dir);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(custom);
  });

  it("does not re-create a deleted skill at boot (createIfMissing: false)", () => {
    const dir = makeDataDir();
    seedGoogleSkill(dir, { createIfMissing: false });
    expect(existsSync(join(dir, "skills", GOOGLE_SKILL_NAME, "SKILL.md"))).toBe(false);
  });

  it("reconnecting a label replaces it; disconnect revokes and removes", async () => {
    const dir = makeDataDir();
    const tokens = { refreshToken: "r1", email: "a@b.c", grantedScopes: [] };
    saveGoogleAccount(dir, { label: "personal", client: CLIENT, tokens });
    saveGoogleAccount(dir, {
      label: "personal",
      client: CLIENT,
      tokens: { ...tokens, refreshToken: "r2" },
    });
    expect(readGoogleAccounts(dir)).toHaveLength(1);

    const revoked: string[] = [];
    const fetchStub = ((url: RequestInfo | URL) => {
      revoked.push(String(url));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    expect(await removeGoogleAccount(dir, "personal", fetchStub)).toBe(true);
    expect(revoked[0]).toContain("revoke?token=r2");
    expect(readGoogleAccounts(dir)).toHaveLength(0);
    expect(existsSync(join(dir, "google", "personal"))).toBe(false);
    expect(await removeGoogleAccount(dir, "personal", fetchStub)).toBe(false);
  });
});

describe("OAuth flow pieces", () => {
  it("builds a consent URL that always yields a refresh token", () => {
    const url = new URL(
      googleAuthUrl({ client: CLIENT, redirectUri: "http://localhost:3100/cb", scopes: ["s1"], state: "st" }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("scope")).toContain("s1");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("exchanges a code and reads the account email from the id_token", async () => {
    const tokens = await exchangeGoogleCode({
      code: "c0de",
      redirectUri: "http://localhost:3100/cb",
      client: CLIENT,
      fetch: (() =>
        Promise.resolve(
          jsonResponse({
            refresh_token: "refresh-9",
            id_token: idTokenWith("me@gmail.com"),
            scope: "openid https://www.googleapis.com/auth/calendar",
          }),
        )) as typeof fetch,
    });
    expect(tokens).toEqual({
      refreshToken: "refresh-9",
      email: "me@gmail.com",
      grantedScopes: ["openid", "https://www.googleapis.com/auth/calendar"],
    });
  });

  it("explains a missing refresh token instead of half-connecting", async () => {
    await expect(
      exchangeGoogleCode({
        code: "c",
        redirectUri: "r",
        client: CLIENT,
        fetch: (() => Promise.resolve(jsonResponse({ id_token: idTokenWith("x@y.z") }))) as typeof fetch,
      }),
    ).rejects.toThrow("no refresh token");
  });

  it("probes token health: ok, expired (invalid_grant), unreachable, missing", async () => {
    const dir = makeDataDir();
    saveGoogleAccount(dir, {
      label: "p",
      client: CLIENT,
      tokens: { refreshToken: "r", email: "a@b.c", grantedScopes: [] },
    });
    const respond = (response: Response | Error) =>
      probeGoogleAccount(dir, "p", (() =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response)) as typeof fetch);

    expect(await respond(jsonResponse({ access_token: "t" }))).toBe("ok");
    expect(await respond(jsonResponse({ error: "invalid_grant" }, 400))).toBe("expired");
    expect(await respond(jsonResponse({ error: "internal" }, 500))).toBe("unreachable");
    expect(await respond(new Error("offline"))).toBe("unreachable");
    expect(await probeGoogleAccount(dir, "nope", (() => Promise.reject(new Error("x"))) as typeof fetch)).toBe(
      "missing",
    );
  });
});

describe("gws bash environment", () => {
  it("puts the shim first on PATH and points it at the account store", () => {
    const dir = makeDataDir();
    const env = buildGwsBashEnv({ dataDir: dir, defaultAccount: "work", gwsPath: "/opt/gws" });
    expect(env.PATH!.startsWith(gwsShimDir())).toBe(true);
    expect(env.NUDGE_GOOGLE_DIR).toBe(join(dir, "google"));
    expect(env.NUDGE_GOOGLE_DEFAULT_ACCOUNT).toBe("work");
    expect(env.GWS_BINARY).toBe("/opt/gws");
    expect(existsSync(join(gwsShimDir(), "gws"))).toBe(true);
  });
});
