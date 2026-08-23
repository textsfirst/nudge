import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp, type ConsoleApp } from "../src/server/app.js";
import { json, secureTestOptions } from "./auth-helper.js";

const SLOW = 30_000;

let root: string | undefined;
const extra: string[] = [];

function makeWorkspace(): string {
  root = mkdtempSync(join(tmpdir(), "console-skills-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(join(root, ".env"), "NUDGE_DATA_DIR=.data\nPORT=59983\n");
  mkdirSync(join(root, ".data", "skills", "mine"), { recursive: true });
  writeFileSync(
    join(root, ".data", "skills", "mine", "SKILL.md"),
    "---\nname: mine\ndescription: my own skill\n---\nBody.\n",
  );
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(): ConsoleApp {
  return createConsoleApp({ root: makeWorkspace(), ...secureTestOptions });
}

/** A committed local git repo holding one installable skill. */
function makeRepo(name: string): string {
  const repo = mkdtempSync(join(tmpdir(), "console-skills-repo-"));
  extra.push(repo);
  mkdirSync(join(repo, name), { recursive: true });
  writeFileSync(
    join(repo, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: from the registry\n---\nBody.\n`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], {
      cwd: repo,
      stdio: "ignore",
    });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "skill");
  return repo;
}

describe("console skills API", () => {
  it("lists skills with provenance, including the shipped restorables", async () => {
    const overview = await json(app(), "/api/skills");
    expect(overview.status).toBe(200);
    const mine = overview.body.skills.find((skill: any) => skill.name === "mine");
    expect(mine).toMatchObject({ provenance: "local", description: "my own skill" });
    // The real bundle ships skills; none are installed in this workspace.
    expect(overview.body.restorable.length).toBeGreaterThan(0);
  });

  it("restores a shipped skill and reports it as bundled-pristine", async () => {
    const application = app();
    const { body } = await json(application, "/api/skills");
    const shipped = body.restorable[0].name;
    const restored = await json(application, `/api/skills/${shipped}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(existsSync(join(root!, ".data", "skills", shipped, "SKILL.md"))).toBe(true);

    const after = await json(application, "/api/skills");
    expect(after.body.skills.find((skill: any) => skill.name === shipped)).toMatchObject({
      provenance: "bundled",
      restorable: true,
    });

    const unknown = await json(application, "/api/skills/not-a-real-skill/restore", {
      method: "POST",
    });
    expect(unknown.status).toBe(404);
  });

  it("installs from a repo, then updates and deletes", { timeout: SLOW }, async () => {
    const application = app();
    const repo = makeRepo("registry-skill");

    const missing = await json(application, "/api/skills/install", {
      method: "POST",
      body: JSON.stringify({ source: "" }),
    });
    expect(missing.status).toBe(422);

    const installed = await json(application, "/api/skills/install", {
      method: "POST",
      body: JSON.stringify({ source: repo }),
    });
    expect(installed.status).toBe(200);
    expect(installed.body.name).toBe("registry-skill");

    const overview = await json(application, "/api/skills");
    expect(
      overview.body.skills.find((skill: any) => skill.name === "registry-skill"),
    ).toMatchObject({ provenance: "registry" });

    // Local edit → update refuses with 409 until forced.
    writeFileSync(
      join(root!, ".data", "skills", "registry-skill", "SKILL.md"),
      "---\nname: registry-skill\ndescription: tweaked\n---\nBody.\n",
    );
    const refused = await json(application, "/api/skills/registry-skill/update", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(409);
    const forced = await json(application, "/api/skills/registry-skill/update", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);

    const removed = await json(application, "/api/skills/registry-skill", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await json(application, "/api/skills/registry-skill", { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("keeps skills-lock.json out of hand-editing surfaces", async () => {
    const application = app();
    writeFileSync(join(root!, ".data", "skills-lock.json"), "{}\n");
    const write = await json(application, "/api/files/content", {
      method: "PUT",
      body: JSON.stringify({ path: "skills-lock.json", content: "{}" }),
    });
    expect(write.status).toBe(403);
  });
});
