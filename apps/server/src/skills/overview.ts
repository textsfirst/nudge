import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { BUNDLED_SKILLS_DIR, hashDir, parseSkillFrontmatter, validateSkillMd } from "@nudge/agent";
import { readSkillsLock, SkillsUserError } from "./registry.js";

/**
 * The provenance-aware skill listing shared by the skills CLI and the
 * console: what the agent sees, where each skill came from, and whether the
 * shipped original is still available to restore.
 */

/** Same file the bundle sync maintains; read-only here. */
const MANIFEST_NAME = ".bundled-manifest.json";

export type SkillProvenance =
  | "bundled"
  | "bundled-customized"
  | "registry"
  | "registry-customized"
  | "local";

export interface SkillOverviewEntry {
  name: string;
  /** Exactly what the agent's prompt shows. */
  description: string;
  version: string;
  provenance: SkillProvenance;
  /** skills.sh identifier for registry installs. */
  source: string | null;
  installedAt: string | null;
  /** The shipped original exists, so restore is possible. */
  restorable: boolean;
  /** Files in the skill directory, SKILL.md first. */
  files: string[];
  /** Spec problem or structural warning; the skill may be degraded. */
  problem: string | null;
}

export interface SkillsOverview {
  skills: SkillOverviewEntry[];
  /** Bundled skills not currently in DATA_DIR (deleted or never seeded). */
  restorable: { name: string; description: string }[];
}

function readManifest(dataDir: string): Record<string, string> {
  const path = join(dataDir, MANIFEST_NAME);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}${sep}${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

export function skillsOverview(dataDir: string, bundledSkillsDir = BUNDLED_SKILLS_DIR): SkillsOverview {
  const skillsDir = join(dataDir, "skills");
  const manifest = readManifest(dataDir);
  const lock = readSkillsLock(dataDir);
  const entries: SkillOverviewEntry[] = [];
  const present = new Set<string>();

  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      present.add(entry.name);
      const dir = join(skillsDir, entry.name);
      const skillFile = join(dir, "SKILL.md");
      const bundledOrigin = manifest[`skills/${entry.name}`];
      const locked = lock[entry.name];
      const restorable = existsSync(join(bundledSkillsDir, entry.name, "SKILL.md"));

      if (!existsSync(skillFile)) {
        entries.push({
          name: entry.name,
          description: "",
          version: "0",
          provenance: locked ? "registry-customized" : bundledOrigin ? "bundled-customized" : "local",
          source: locked?.source ?? null,
          installedAt: locked?.installedAt ?? null,
          restorable,
          files: listFiles(dir),
          problem: "no SKILL.md — this directory is invisible to the agent.",
        });
        continue;
      }

      const content = readFileSync(skillFile, "utf8");
      const frontmatter = parseSkillFrontmatter(content);
      const localHash = hashDir(dir);
      const provenance: SkillProvenance = locked
        ? localHash === locked.hash
          ? "registry"
          : "registry-customized"
        : bundledOrigin !== undefined
          ? localHash === bundledOrigin
            ? "bundled"
            : "bundled-customized"
          : "local";
      entries.push({
        name: entry.name,
        description: frontmatter?.fields.description ?? "(no description)",
        version: frontmatter?.metadata.version ?? frontmatter?.fields.version ?? "0",
        provenance,
        source: locked?.source ?? null,
        installedAt: locked?.installedAt ?? null,
        restorable,
        files: listFiles(dir),
        problem: validateSkillMd(entry.name, content) ?? null,
      });
    }
  }

  const restorable: SkillsOverview["restorable"] = [];
  if (existsSync(bundledSkillsDir)) {
    for (const entry of readdirSync(bundledSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || present.has(entry.name)) continue;
      const skillFile = join(bundledSkillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      restorable.push({
        name: entry.name,
        description:
          parseSkillFrontmatter(readFileSync(skillFile, "utf8"))?.fields.description ??
          "(no description)",
      });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  restorable.sort((a, b) => a.name.localeCompare(b.name));
  return { skills: entries, restorable };
}

/**
 * Replace (or re-seed) a skill with the shipped original and mark it pristine
 * in the bundle manifest, so it resumes receiving updates on upgrade.
 */
export function restoreBundledSkill(
  dataDir: string,
  name: string,
  bundledSkillsDir = BUNDLED_SKILLS_DIR,
): void {
  const source = join(bundledSkillsDir, name);
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new SkillsUserError(`"${name}" is not a skill that ships with Nudge.`);
  }
  const target = join(dataDir, "skills", name);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });

  const manifestPath = join(dataDir, MANIFEST_NAME);
  const manifest = readManifest(dataDir);
  manifest[`skills/${name}`] = hashDir(source);
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, manifestPath);
}
