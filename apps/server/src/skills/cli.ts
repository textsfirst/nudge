import { restoreBundledSkill, skillsOverview, type SkillOverviewEntry } from "./overview.js";
import {
  checkSkillUpdates,
  installSkill,
  removeSkill,
  SkillsUserError,
  updateSkill,
} from "./registry.js";

/**
 * The agent-facing skills CLI, driven over bash — the gws/mcp pattern: no
 * schemas in the prompt, capability discovered per call. Exit codes mirror
 * the shim contract: 0 ok · 2 owner-facing problem (do not blindly retry) ·
 * 3 usage.
 */

const EXIT_OK = 0;
const EXIT_PROBLEM = 2;
const EXIT_USAGE = 3;

const USAGE = `skills — manage skills (Agent Skills format; registry: skills.sh)

  skills ls                        installed skills and provenance
  skills add <owner/repo[/name]>   install from a public GitHub repo
  skills check                     check registry installs for upstream updates
  skills update <name> [--force]   re-install from the recorded source
  skills restore <name>            restore a shipped skill to its original
  skills rm <name>                 delete a skill (and its lock entry)
`;

type Writable = { write(text: string): unknown };

export async function runSkillsCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Writable,
  err: Writable,
): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "--help") {
    (verb ? out : err).write(USAGE);
    return verb ? EXIT_OK : EXIT_USAGE;
  }
  const dataDir = env.NUDGE_DATA_DIR;
  if (!dataDir) {
    err.write(
      "skills is managed by Nudge and only available inside its bash tool (NUDGE_DATA_DIR is unset).\n",
    );
    return EXIT_USAGE;
  }
  try {
    switch (verb) {
      case "ls": {
        const overview = skillsOverview(dataDir);
        if (overview.skills.length === 0) out.write("No skills installed.\n");
        for (const skill of overview.skills) {
          out.write(`${describeSkill(skill)}\n`);
        }
        for (const gone of overview.restorable) {
          out.write(`(removed, restorable: ${gone.name} — ${gone.description})\n`);
        }
        return EXIT_OK;
      }
      case "add": {
        const source = rest[0];
        if (!source) {
          err.write("Usage: skills add <owner/repo[/name]>\n");
          return EXIT_USAGE;
        }
        const installed = await installSkill({ dataDir, source });
        out.write(`Installed ${installed.name} from ${installed.source}.\n`);
        return EXIT_OK;
      }
      case "check": {
        const statuses = await checkSkillUpdates(dataDir);
        if (statuses.length === 0) out.write("No registry skills to check.\n");
        for (const status of statuses) {
          const notes = [
            status.updateAvailable ? "update available" : "up to date",
            ...(status.customized ? ["customized locally"] : []),
            ...(status.error ? [status.error] : []),
          ];
          out.write(`${status.name} (${status.source}): ${notes.join("; ")}\n`);
        }
        return EXIT_OK;
      }
      case "update": {
        const name = rest[0];
        if (!name) {
          err.write("Usage: skills update <name> [--force]\n");
          return EXIT_USAGE;
        }
        const updated = await updateSkill({ dataDir, name, force: rest.includes("--force") });
        out.write(`Updated ${updated.name} from ${updated.source}.\n`);
        return EXIT_OK;
      }
      case "restore": {
        const name = rest[0];
        if (!name) {
          err.write("Usage: skills restore <name>\n");
          return EXIT_USAGE;
        }
        restoreBundledSkill(dataDir, name);
        out.write(`Restored ${name} to the shipped version; it resumes receiving updates.\n`);
        return EXIT_OK;
      }
      case "rm": {
        const name = rest[0];
        if (!name) {
          err.write("Usage: skills rm <name>\n");
          return EXIT_USAGE;
        }
        if (!removeSkill(dataDir, name)) {
          err.write(`No skill "${name}".\n`);
          return EXIT_PROBLEM;
        }
        out.write(`Removed ${name}.\n`);
        return EXIT_OK;
      }
      default:
        err.write(`Unknown command "${verb}".\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof SkillsUserError) {
      err.write(`${error.message}\n`);
      return EXIT_PROBLEM;
    }
    err.write(`skills failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_PROBLEM;
  }
}

function describeSkill(skill: SkillOverviewEntry): string {
  const provenance =
    skill.provenance === "registry"
      ? skill.source
      : skill.provenance === "registry-customized"
        ? `${skill.source}, customized`
        : skill.provenance === "bundled"
          ? "bundled"
          : skill.provenance === "bundled-customized"
            ? "bundled, customized — no longer receives updates"
            : "local";
  const problem = skill.problem ? ` [problem: ${skill.problem}]` : "";
  return `${skill.name} v${skill.version} (${provenance}) — ${skill.description}${problem}`;
}
