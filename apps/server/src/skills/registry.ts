import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hashDir, parseSkillFrontmatter, validateSkillMd } from "@nudge/agent";

const run = promisify(execFile);

/**
 * Installing skills from the skills.sh ecosystem: a skill is identified as
 * owner/repo or owner/repo/skill-name, fetched from GitHub with a shallow git
 * clone, spec-validated, and copied into DATA_DIR/skills. Provenance lands in
 * DATA_DIR/skills-lock.json (the skills.sh lockfile convention) so installs
 * can be checked for upstream updates and told apart from local edits.
 *
 * Shipped-with-Nudge skills keep their existing bundle-manifest lifecycle;
 * the lockfile covers registry installs only.
 */

export const SKILLS_LOCK_NAME = "skills-lock.json";
const CLONE_TIMEOUT_MS = 60_000;
const SCAN_DEPTH = 3;

/** An owner-facing failure: the message is the diagnosis. */
export class SkillsUserError extends Error {}

export interface SkillLockEntry {
  /** owner/repo/skill-name, the skills.sh identifier it was installed from. */
  source: string;
  /** The repo part alone — kept separate because source is display-shaped. */
  repo: string;
  /** hashDir of the installed copy — a local mismatch means customized. */
  hash: string;
  installedAt: string;
}

export type SkillsLock = Record<string, SkillLockEntry>;

export function readSkillsLock(dataDir: string): SkillsLock {
  const path = join(dataDir, SKILLS_LOCK_NAME);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SkillsLock;
  } catch {
    return {};
  }
}

function writeSkillsLock(dataDir: string, lock: SkillsLock): void {
  const path = join(dataDir, SKILLS_LOCK_NAME);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(temporary, path);
}

export interface ParsedSource {
  /** owner/repo (or a git URL / local path in tests). */
  repo: string;
  /** Skill directory name within the repo, when pinned. */
  skill: string | null;
}

/** owner/repo, owner/repo/skill-name, or a full URL / absolute path. */
export function parseSource(input: string): ParsedSource {
  const trimmed = input.trim().replace(/^https:\/\/(www\.)?skills\.sh\//, "");
  if (trimmed.includes("://") || trimmed.startsWith("/")) {
    return { repo: trimmed, skill: null };
  }
  const parts = trimmed.split("/").filter((part) => part !== "");
  if (parts.length < 2 || parts.length > 3) {
    throw new SkillsUserError(
      `"${input}" is not a skills.sh identifier — use owner/repo or owner/repo/skill-name.`,
    );
  }
  return { repo: `${parts[0]}/${parts[1]}`, skill: parts[2] ?? null };
}

function gitUrl(repo: string): string {
  return repo.includes("://") || repo.startsWith("/") ? repo : `https://github.com/${repo}.git`;
}

/** Shallow-clone the repo into a fresh temp dir; caller removes it. */
async function fetchRepo(repo: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nudge-skills-"));
  try {
    await run("git", ["clone", "--depth", "1", "--quiet", gitUrl(repo), dir], {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new SkillsUserError(
      `Could not fetch ${repo} (${detail}). Check the identifier — public GitHub repos only.`,
    );
  }
  return dir;
}

export interface RepoSkill {
  name: string;
  dir: string;
  description: string;
  /** Spec problem, when the skill does not validate. */
  problem: string | undefined;
}

/** Every directory holding a SKILL.md, a few levels deep. */
export function scanRepoSkills(repoDir: string): RepoSkill[] {
  const found: RepoSkill[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const child = join(dir, entry.name);
      const skillFile = join(child, "SKILL.md");
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, "utf8");
        found.push({
          name: entry.name,
          dir: child,
          description: parseSkillFrontmatter(content)?.fields.description ?? "(no description)",
          problem: validateSkillMd(entry.name, content),
        });
        continue;
      }
      if (depth < SCAN_DEPTH) visit(child, depth + 1);
    }
  };
  visit(repoDir, 1);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export interface InstallResult {
  name: string;
  source: string;
  description: string;
}

export async function installSkill(options: {
  dataDir: string;
  source: string;
  /** Pre-parsed source (used by update, where repo and skill are recorded). */
  parsed?: ParsedSource;
  /** Replace an existing install of the same name (used by update). */
  replace?: boolean;
}): Promise<InstallResult> {
  const { repo, skill } = options.parsed ?? parseSource(options.source);
  const repoDir = await fetchRepo(repo);
  try {
    const skills = scanRepoSkills(repoDir);
    if (skills.length === 0) {
      throw new SkillsUserError(`${repo} contains no skills (no SKILL.md directories found).`);
    }
    const picked = skill === null ? (skills.length === 1 ? skills[0] : undefined) : skills.find((candidate) => candidate.name === skill);
    if (!picked) {
      const listing = skills.map((entry) => `  ${entry.name} — ${entry.description}`).join("\n");
      throw new SkillsUserError(
        skill === null
          ? `${repo} has several skills — pick one:\n${listing}`
          : `No skill "${skill}" in ${repo}. Available:\n${listing}`,
      );
    }
    if (picked.problem) {
      throw new SkillsUserError(
        `${repo}/${picked.name} does not pass Agent Skills validation: ${picked.problem}`,
      );
    }

    const target = join(options.dataDir, "skills", picked.name);
    if (existsSync(target) && !options.replace) {
      throw new SkillsUserError(
        `skills/${picked.name} already exists. Remove it first, or run update for a registry skill.`,
      );
    }
    rmSync(target, { recursive: true, force: true });
    cpSync(picked.dir, target, { recursive: true });
    rmSync(join(target, ".git"), { recursive: true, force: true });
    const symlink = firstSymlink(target);
    if (symlink) {
      rmSync(target, { recursive: true, force: true });
      throw new SkillsUserError(
        `${repo}/${picked.name} contains a symlink (${symlink}) and was not installed.`,
      );
    }

    const lock = readSkillsLock(options.dataDir);
    const entry: SkillLockEntry = {
      source: `${repo}/${picked.name}`,
      repo,
      hash: hashDir(target),
      installedAt: new Date().toISOString(),
    };
    lock[picked.name] = entry;
    writeSkillsLock(options.dataDir, lock);
    return { name: picked.name, source: entry.source, description: picked.description };
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

export interface SkillUpdateStatus {
  name: string;
  source: string;
  /** Local copy no longer matches the installed hash. */
  customized: boolean;
  /** Upstream differs from what was installed. */
  updateAvailable: boolean;
  /** Upstream fetch or validation problem, if any. */
  error: string | null;
}

export async function checkSkillUpdates(dataDir: string): Promise<SkillUpdateStatus[]> {
  const lock = readSkillsLock(dataDir);
  const statuses: SkillUpdateStatus[] = [];
  for (const [name, entry] of Object.entries(lock)) {
    const local = join(dataDir, "skills", name);
    const customized = existsSync(local) ? hashDir(local) !== entry.hash : false;
    try {
      const repo = entry.repo ?? parseSource(entry.source).repo;
      const repoDir = await fetchRepo(repo);
      try {
        const upstream = scanRepoSkills(repoDir).find((candidate) => candidate.name === name);
        statuses.push({
          name,
          source: entry.source,
          customized,
          updateAvailable: upstream !== undefined && hashDir(upstream.dir) !== entry.hash,
          error: upstream === undefined ? `no longer present in ${repo}` : null,
        });
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    } catch (error) {
      statuses.push({
        name,
        source: entry.source,
        customized,
        updateAvailable: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return statuses;
}

export async function updateSkill(options: {
  dataDir: string;
  name: string;
  /** Overwrite local customizations. */
  force?: boolean;
}): Promise<InstallResult> {
  const lock = readSkillsLock(options.dataDir);
  const entry = lock[options.name];
  if (!entry) {
    throw new SkillsUserError(
      `"${options.name}" is not a registry skill (not in ${SKILLS_LOCK_NAME}).`,
    );
  }
  const local = join(options.dataDir, "skills", options.name);
  if (!options.force && existsSync(local) && hashDir(local) !== entry.hash) {
    throw new SkillsUserError(
      `skills/${options.name} was customized locally since install — updating would discard ` +
        "those edits. Pass --force to overwrite.",
    );
  }
  return installSkill({
    dataDir: options.dataDir,
    source: entry.source,
    parsed: { repo: entry.repo ?? parseSource(entry.source).repo, skill: options.name },
    replace: true,
  });
}

export function removeSkill(dataDir: string, name: string): boolean {
  const target = join(dataDir, "skills", name);
  const lock = readSkillsLock(dataDir);
  const existed = existsSync(target) || lock[name] !== undefined;
  rmSync(target, { recursive: true, force: true });
  if (lock[name] !== undefined) {
    delete lock[name];
    writeSkillsLock(dataDir, lock);
  }
  return existed;
}

function firstSymlink(dir: string, root = dir): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) return abs.slice(root.length + 1);
    if (entry.isDirectory()) {
      const nested = firstSymlink(abs, root);
      if (nested) return nested;
    }
  }
  return undefined;
}
