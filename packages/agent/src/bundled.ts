import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { BUNDLED_CONTENT_DIR, BUNDLED_SKILLS_DIR } from "./content.js";
import type { Logger } from "./types.js";

/**
 * Hermes-style seed-and-sync of shipped content into DATA_DIR.
 *
 * The manifest records the origin hash of everything we ever seeded, which is
 * what makes upgrades safe: a copy that still matches its origin was never
 * customized and can be replaced; anything else belongs to the owner or the
 * agent and is left alone forever. Deletions are respected the same way — a
 * manifest entry with no file means "seeded once, removed on purpose".
 */
const MANIFEST_NAME = ".bundled-manifest.json";

/** Keys are "SYSTEM.md" or "skills/<name>"; values are origin hashes. */
type Manifest = Record<string, string>;

export interface SyncBundledOptions {
  dataDir: string;
  /** Overridden in tests; defaults to the package's content directory. */
  bundledDir?: string;
  logger?: Logger;
}

export interface SyncBundledResult {
  seeded: string[];
  updated: string[];
  /** Present in the bundle but customized locally — never touched. */
  kept: string[];
}

export function syncBundledContent(options: SyncBundledOptions): SyncBundledResult {
  const bundledDir = options.bundledDir ?? BUNDLED_CONTENT_DIR;
  const bundledSkillsDir = options.bundledDir ? join(options.bundledDir, "skills") : BUNDLED_SKILLS_DIR;
  mkdirSync(options.dataDir, { recursive: true });

  const manifestPath = join(options.dataDir, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);
  const result: SyncBundledResult = { seeded: [], updated: [], kept: [] };
  const bundledKeys = new Set<string>();

  const systemSource = join(bundledDir, "SYSTEM.md");
  if (existsSync(systemSource)) {
    bundledKeys.add("SYSTEM.md");
    syncOne({
      key: "SYSTEM.md",
      sourceHash: hashFile(systemSource),
      target: join(options.dataDir, "SYSTEM.md"),
      targetHash: (target) => (existsSync(target) ? hashFile(target) : undefined),
      copy: (target) => cpSync(systemSource, target),
      manifest,
      result,
    });
  }

  for (const name of listBundledSkills(bundledSkillsDir)) {
    const key = `skills/${name}`;
    bundledKeys.add(key);
    const source = join(bundledSkillsDir, name);
    syncOne({
      key,
      sourceHash: hashDir(source),
      target: join(options.dataDir, "skills", name),
      targetHash: (target) => (existsSync(target) ? hashDir(target) : undefined),
      copy: (target) => {
        rmSync(target, { recursive: true, force: true });
        cpSync(source, target, { recursive: true });
      },
      manifest,
      result,
    });
  }

  // Dropped from the bundle: forget the origin, leave any local copy alone.
  for (const key of Object.keys(manifest)) {
    if (!bundledKeys.has(key)) delete manifest[key];
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  options.logger?.info("Bundled content synced", {
    seeded: result.seeded,
    updated: result.updated,
    kept: result.kept,
  });
  return result;
}

interface SyncOneInput {
  key: string;
  sourceHash: string;
  target: string;
  targetHash: (target: string) => string | undefined;
  copy: (target: string) => void;
  manifest: Manifest;
  result: SyncBundledResult;
}

function syncOne(input: SyncOneInput): void {
  const origin = input.manifest[input.key];
  const current = input.targetHash(input.target);

  if (origin === undefined) {
    // Never seeded. An existing file predates management (or the agent made
    // it under the same name) — it is theirs, and recording no origin keeps
    // it unmanaged forever.
    if (current !== undefined) {
      input.result.kept.push(input.key);
      return;
    }
    mkdirSync(dirname(input.target), { recursive: true });
    input.copy(input.target);
    input.manifest[input.key] = input.sourceHash;
    input.result.seeded.push(input.key);
    return;
  }

  if (current === undefined) return; // Deleted locally: respected, never re-seeded.
  if (current !== origin) {
    // Customized since seeding: the local copy wins, now and on every upgrade.
    input.result.kept.push(input.key);
    return;
  }
  if (input.sourceHash !== origin) {
    input.copy(input.target);
    input.manifest[input.key] = input.sourceHash;
    input.result.updated.push(input.key);
  }
}

function listBundledSkills(bundledSkillsDir: string): string[] {
  if (!existsSync(bundledSkillsDir)) return [];
  return readdirSync(bundledSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(bundledSkillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function readManifest(path: string): Manifest {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string"),
    ) as Manifest;
  } catch {
    // A corrupt manifest degrades safely: every existing file reads as
    // unmanaged (kept), and only genuinely missing files get seeded.
    return {};
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Order-independent content hash over every file in the directory. */
function hashDir(dir: string): string {
  const hash = createHash("sha256");
  for (const rel of walk(dir, "").sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walk(root: string, prefix: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix || "."), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}${sep}${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walk(root, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}
