import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
}

/**
 * Skills follow the Agent Skills spec (agentskills.io), the format behind the
 * skills.sh ecosystem: a skill is a directory whose SKILL.md carries YAML
 * frontmatter with `name` (matching the directory) and `description`, plus
 * optional `license`, `compatibility`, `metadata` (string map), and
 * `allowed-tools`. Writes enforce the spec; reads stay tolerant so a
 * pre-existing or hand-imported skill still reaches the prompt.
 */

/** Spec name rule: lowercase alphanumerics and single hyphens, 1-64 chars. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMPATIBILITY_MAX = 500;

export interface SkillFrontmatter {
  /** Top-level scalar fields (name, description, license, …). */
  fields: Record<string, string>;
  /** The nested `metadata:` string map, when present. */
  metadata: Record<string, string>;
}

/**
 * Frontmatter reader covering the spec's shape: flat scalar fields plus the
 * one-level `metadata:` map. Not a YAML parser — deeper nesting is ignored.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (match?.[1] === undefined) return undefined;
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  for (const line of match[1].split("\n")) {
    const nested = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (nested?.[1] !== undefined && nested[2] !== undefined) {
      if (inMetadata) metadata[nested[1]] = unquote(nested[2]);
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair?.[1] === undefined || pair[2] === undefined) continue;
    inMetadata = pair[1] === "metadata" && pair[2].trim() === "";
    if (!inMetadata) fields[pair[1]] = unquote(pair[2]);
  }
  return { fields, metadata };
}

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * Spec validation for a SKILL.md about to be written into skills/<dirName>/.
 * Returns a problem description, or undefined when the file conforms.
 */
export function validateSkillMd(dirName: string, content: string): string | undefined {
  const frontmatter = parseSkillFrontmatter(content);
  if (!frontmatter) {
    return 'SKILL.md needs YAML frontmatter (--- fences) with "name:" and "description:".';
  }
  const name = frontmatter.fields.name ?? "";
  if (name === "") return 'SKILL.md frontmatter needs a "name:" field.';
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_PATTERN.test(name)) {
    return (
      `skill name "${name}" is invalid — use 1-${SKILL_NAME_MAX} lowercase letters, ` +
      "digits, and single hyphens (like pdf-processing)."
    );
  }
  if (name !== dirName) {
    return `skill name "${name}" must match its directory "${dirName}".`;
  }
  const description = frontmatter.fields.description ?? "";
  if (description === "") return 'SKILL.md frontmatter needs a "description:" field.';
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return `skill description is capped at ${SKILL_DESCRIPTION_MAX} characters, got ${description.length}.`;
  }
  const compatibility = frontmatter.fields.compatibility;
  if (compatibility !== undefined && compatibility.length > SKILL_COMPATIBILITY_MAX) {
    return `skill compatibility is capped at ${SKILL_COMPATIBILITY_MAX} characters.`;
  }
  return undefined;
}

/**
 * Read-only scanner over DATA_DIR/skills for the prompt's level-0 skill list.
 * The agent creates and edits skills through the generic file tools; the
 * workspace validator enforces the spec contract on write. Reads are
 * deliberately tolerant: the directory name is the skill's identity, and a
 * non-conforming SKILL.md still lists rather than silently vanishing.
 */
export class SkillsLibrary {
  constructor(private readonly dir: string) {}

  list(): SkillMeta[] {
    if (!existsSync(this.dir)) return [];
    const skills: SkillMeta[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(this.dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const meta = parseSkillFrontmatter(readFileSync(file, "utf8"));
      skills.push({
        name: entry.name,
        description: meta?.fields.description ?? "(no description)",
        // Spec convention is metadata.version; the old top-level version is
        // still honored so pre-migration skills read the same.
        version: meta?.metadata.version ?? meta?.fields.version ?? "0",
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }
}
