import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSkillsCli } from "../src/skills/cli.js";
import { restoreBundledSkill, skillsOverview } from "../src/skills/overview.js";
import {
  checkSkillUpdates,
  installSkill,
  parseSource,
  readSkillsLock,
  removeSkill,
  scanRepoSkills,
  updateSkill,
} from "../src/skills/registry.js";

/** Local git repos stand in for GitHub — clone URLs accept absolute paths. */
const SLOW = 30_000;

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillMd(name: string, description = `${name} does things`): string {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: "1"\n---\nBody.\n`;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A committed repo whose skills/ dir holds the given skills. */
function makeRepo(skills: Record<string, string>): string {
  const repo = tmp("skills-repo-");
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(repo, "skills", name), { recursive: true });
    writeFileSync(join(repo, "skills", name, "SKILL.md"), content);
  }
  git(repo, "init", "--quiet");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "skills");
  return repo;
}

function makeDataDir(): string {
  return tmp("skills-data-");
}

describe("parseSource", () => {
  it("parses skills.sh identifiers", () => {
    expect(parseSource("owner/repo")).toEqual({ repo: "owner/repo", skill: null });
    expect(parseSource("owner/repo/pdf-processing")).toEqual({
      repo: "owner/repo",
      skill: "pdf-processing",
    });
    expect(parseSource("https://skills.sh/owner/repo/x")).toEqual({
      repo: "owner/repo",
      skill: "x",
    });
    expect(parseSource("/absolute/local/path")).toEqual({ repo: "/absolute/local/path", skill: null });
    expect(() => parseSource("just-a-name")).toThrow("skills.sh identifier");
  });
});

describe("scanRepoSkills", () => {
  it("finds skill directories and flags spec problems", () => {
    const repo = tmp("scan-");
    mkdirSync(join(repo, "skills", "good"), { recursive: true });
    writeFileSync(join(repo, "skills", "good", "SKILL.md"), skillMd("good"));
    mkdirSync(join(repo, "skills", "bad"), { recursive: true });
    writeFileSync(join(repo, "skills", "bad", "SKILL.md"), skillMd("mismatched"));
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "SKILL.md"), skillMd("dep"));

    const found = scanRepoSkills(repo);
    expect(found.map((skill) => skill.name)).toEqual(["bad", "good"]);
    expect(found.find((skill) => skill.name === "good")?.problem).toBeUndefined();
    expect(found.find((skill) => skill.name === "bad")?.problem).toContain("must match");
  });
});

describe("installSkill", { timeout: SLOW }, () => {
  it("installs the only skill of a repo and records the lock", async () => {
    const repo = makeRepo({ "pdf-processing": skillMd("pdf-processing") });
    const dataDir = makeDataDir();
    const installed = await installSkill({ dataDir, source: repo });
    expect(installed.name).toBe("pdf-processing");
    expect(existsSync(join(dataDir, "skills", "pdf-processing", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dataDir, "skills", "pdf-processing", ".git"))).toBe(false);

    const lock = readSkillsLock(dataDir);
    expect(lock["pdf-processing"]?.source).toBe(`${repo}/pdf-processing`);
    expect(lock["pdf-processing"]?.hash).toMatch(/^[0-9a-f]{64}$/);

    // Same name again is a conflict, not an overwrite.
    await expect(installSkill({ dataDir, source: repo })).rejects.toThrow("already exists");
  });

  it("demands a pick from multi-skill repos and validates the pick", async () => {
    const repo = makeRepo({ one: skillMd("one"), two: skillMd("two") });
    const dataDir = makeDataDir();
    await expect(installSkill({ dataDir, source: repo })).rejects.toThrow("pick one");
    const installed = await installSkill({
      dataDir,
      source: repo,
      parsed: { repo, skill: "two" },
    });
    expect(installed.name).toBe("two");

    // A skill that fails spec validation never lands in DATA_DIR.
    const badRepo = makeRepo({ bad: skillMd("mismatched-name") });
    await expect(installSkill({ dataDir, source: badRepo })).rejects.toThrow(
      "Agent Skills validation",
    );
    expect(existsSync(join(dataDir, "skills", "bad"))).toBe(false);
  });
});

describe("update flow", { timeout: SLOW }, () => {
  it("checks upstream, refuses to clobber local edits, updates cleanly", async () => {
    const repo = makeRepo({ tool: skillMd("tool", "v1 description") });
    const dataDir = makeDataDir();
    await installSkill({ dataDir, source: repo });

    // No upstream change yet.
    let statuses = await checkSkillUpdates(dataDir);
    expect(statuses).toMatchObject([{ name: "tool", customized: false, updateAvailable: false }]);

    // Upstream moves ahead.
    writeFileSync(join(repo, "skills", "tool", "SKILL.md"), skillMd("tool", "v2 description"));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "v2");
    statuses = await checkSkillUpdates(dataDir);
    expect(statuses).toMatchObject([{ name: "tool", updateAvailable: true }]);

    // A customized local copy is protected...
    const local = join(dataDir, "skills", "tool", "SKILL.md");
    writeFileSync(local, skillMd("tool", "my local tweak"));
    await expect(updateSkill({ dataDir, name: "tool" })).rejects.toThrow("customized locally");
    // ...unless forced.
    await updateSkill({ dataDir, name: "tool", force: true });
    expect(readFileSync(local, "utf8")).toContain("v2 description");

    expect(removeSkill(dataDir, "tool")).toBe(true);
    expect(existsSync(join(dataDir, "skills", "tool"))).toBe(false);
    expect(readSkillsLock(dataDir)).toEqual({});
    expect(removeSkill(dataDir, "tool")).toBe(false);
  });
});

describe("skillsOverview", { timeout: SLOW }, () => {
  it("classifies provenance across bundled, registry, and local skills", async () => {
    const dataDir = makeDataDir();
    // A fake bundle with one skill; restore seeds it and marks it pristine.
    const bundled = tmp("bundled-");
    mkdirSync(join(bundled, "shipped"));
    writeFileSync(join(bundled, "shipped", "SKILL.md"), skillMd("shipped"));
    mkdirSync(join(bundled, "removed"));
    writeFileSync(join(bundled, "removed", "SKILL.md"), skillMd("removed"));
    restoreBundledSkill(dataDir, "shipped", bundled);

    const repo = makeRepo({ installed: skillMd("installed") });
    await installSkill({ dataDir, source: repo });

    mkdirSync(join(dataDir, "skills", "mine"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "mine", "SKILL.md"), skillMd("mine"));
    mkdirSync(join(dataDir, "skills", "husk"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "husk", "notes.txt"), "no SKILL.md here");

    let overview = skillsOverview(dataDir, bundled);
    expect(
      Object.fromEntries(overview.skills.map((skill) => [skill.name, skill.provenance])),
    ).toEqual({
      shipped: "bundled",
      installed: "registry",
      mine: "local",
      husk: "local",
    });
    expect(overview.skills.find((skill) => skill.name === "husk")?.problem).toContain(
      "invisible to the agent",
    );
    expect(overview.restorable).toEqual([
      { name: "removed", description: "removed does things" },
    ]);

    // Editing the bundled skill flips it to customized; restore flips it back.
    writeFileSync(join(dataDir, "skills", "shipped", "SKILL.md"), skillMd("shipped", "tweaked"));
    overview = skillsOverview(dataDir, bundled);
    expect(overview.skills.find((skill) => skill.name === "shipped")?.provenance).toBe(
      "bundled-customized",
    );
    restoreBundledSkill(dataDir, "shipped", bundled);
    overview = skillsOverview(dataDir, bundled);
    expect(overview.skills.find((skill) => skill.name === "shipped")?.provenance).toBe("bundled");
  });
});

describe("skills CLI", { timeout: SLOW }, () => {
  const capture = () => {
    const chunks: string[] = [];
    return { write: (text: string) => chunks.push(text), text: () => chunks.join("") };
  };

  it("refuses to run outside Nudge's bash tool", async () => {
    const out = capture();
    const err = capture();
    expect(await runSkillsCli(["ls"], {}, out, err)).toBe(3);
    expect(err.text()).toContain("NUDGE_DATA_DIR");
  });

  it("drives install, ls, and rm end to end", async () => {
    const repo = makeRepo({ "cli-skill": skillMd("cli-skill") });
    const dataDir = makeDataDir();
    const env = { NUDGE_DATA_DIR: dataDir };

    const out = capture();
    expect(await runSkillsCli(["add", repo], env, out, capture())).toBe(0);
    expect(out.text()).toContain("Installed cli-skill");

    const list = capture();
    expect(await runSkillsCli(["ls"], env, list, capture())).toBe(0);
    expect(list.text()).toContain("cli-skill v1");
    expect(list.text()).toContain(`${repo}/cli-skill`);

    const err = capture();
    expect(await runSkillsCli(["rm", "cli-skill"], env, capture(), err)).toBe(0);
    expect(await runSkillsCli(["rm", "cli-skill"], env, capture(), err)).toBe(2);
  });
});
