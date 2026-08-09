import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
}

/**
 * Read-only scanner over DATA_DIR/skills for the prompt's level-0 skill list.
 * The agent creates and edits skills through the generic file tools; the
 * workspace validator enforces the SKILL.md frontmatter contract.
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
      const meta = parseFrontmatter(readFileSync(file, "utf8"));
      skills.push({
        name: entry.name,
        description: meta.description ?? "(no description)",
        version: meta.version ?? "0",
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match?.[1]) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair?.[1] && pair[2] !== undefined) {
      meta[pair[1]] = pair[2].trim();
    }
  }
  return meta;
}
