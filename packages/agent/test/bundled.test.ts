import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncBundledContent } from "../src/index.js";

const SKILL = (version: number, body = "Steps: do the thing.") =>
  `---\nname: briefing\ndescription: morning briefing\nversion: ${version}\n---\n\n${body}\n`;

function makeDirs(): { bundledDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nudge-bundled-"));
  const bundledDir = join(root, "bundled");
  mkdirSync(join(bundledDir, "skills", "briefing"), { recursive: true });
  writeFileSync(join(bundledDir, "SYSTEM.md"), "You are Nudge v1.\n");
  writeFileSync(join(bundledDir, "skills", "briefing", "SKILL.md"), SKILL(1));
  return { bundledDir, dataDir: join(root, "data") };
}

describe("syncBundledContent", () => {
  it("seeds SYSTEM.md and bundled skills into an empty data dir", () => {
    const { bundledDir, dataDir } = makeDirs();
    const result = syncBundledContent({ dataDir, bundledDir });

    expect(result.seeded).toEqual(["SYSTEM.md", "skills/briefing"]);
    expect(readFileSync(join(dataDir, "SYSTEM.md"), "utf8")).toBe("You are Nudge v1.\n");
    expect(readFileSync(join(dataDir, "skills", "briefing", "SKILL.md"), "utf8")).toBe(SKILL(1));
    expect(existsSync(join(dataDir, ".bundled-manifest.json"))).toBe(true);
  });

  it("is a no-op when nothing changed", () => {
    const { bundledDir, dataDir } = makeDirs();
    syncBundledContent({ dataDir, bundledDir });
    const result = syncBundledContent({ dataDir, bundledDir });
    expect(result).toEqual({ seeded: [], updated: [], kept: [] });
  });

  it("updates unmodified copies when the bundle changes", () => {
    const { bundledDir, dataDir } = makeDirs();
    syncBundledContent({ dataDir, bundledDir });

    writeFileSync(join(bundledDir, "SYSTEM.md"), "You are Nudge v2.\n");
    writeFileSync(join(bundledDir, "skills", "briefing", "SKILL.md"), SKILL(2));
    const result = syncBundledContent({ dataDir, bundledDir });

    expect(result.updated).toEqual(["SYSTEM.md", "skills/briefing"]);
    expect(readFileSync(join(dataDir, "SYSTEM.md"), "utf8")).toBe("You are Nudge v2.\n");
    expect(readFileSync(join(dataDir, "skills", "briefing", "SKILL.md"), "utf8")).toBe(SKILL(2));
  });

  it("never touches customized copies, even across later bundle changes", () => {
    const { bundledDir, dataDir } = makeDirs();
    syncBundledContent({ dataDir, bundledDir });

    writeFileSync(join(dataDir, "SYSTEM.md"), "My own prompt.\n");
    writeFileSync(join(dataDir, "skills", "briefing", "SKILL.md"), SKILL(1, "My tweaked steps."));
    writeFileSync(join(bundledDir, "SYSTEM.md"), "You are Nudge v2.\n");
    writeFileSync(join(bundledDir, "skills", "briefing", "SKILL.md"), SKILL(2));
    const result = syncBundledContent({ dataDir, bundledDir });

    expect(result.kept).toEqual(["SYSTEM.md", "skills/briefing"]);
    expect(result.updated).toEqual([]);
    expect(readFileSync(join(dataDir, "SYSTEM.md"), "utf8")).toBe("My own prompt.\n");
    expect(readFileSync(join(dataDir, "skills", "briefing", "SKILL.md"), "utf8")).toBe(
      SKILL(1, "My tweaked steps."),
    );
  });

  it("respects local deletions and never re-seeds them", () => {
    const { bundledDir, dataDir } = makeDirs();
    syncBundledContent({ dataDir, bundledDir });

    rmSync(join(dataDir, "SYSTEM.md"));
    rmSync(join(dataDir, "skills", "briefing"), { recursive: true });
    const result = syncBundledContent({ dataDir, bundledDir });

    expect(result).toEqual({ seeded: [], updated: [], kept: [] });
    expect(existsSync(join(dataDir, "SYSTEM.md"))).toBe(false);
    expect(existsSync(join(dataDir, "skills", "briefing"))).toBe(false);
  });

  it("leaves pre-existing unmanaged files alone", () => {
    const { bundledDir, dataDir } = makeDirs();
    mkdirSync(join(dataDir, "skills", "briefing"), { recursive: true });
    writeFileSync(join(dataDir, "SYSTEM.md"), "Prompt from before the sync existed.\n");
    writeFileSync(
      join(dataDir, "skills", "briefing", "SKILL.md"),
      SKILL(9, "The agent wrote this skill first."),
    );

    const result = syncBundledContent({ dataDir, bundledDir });
    expect(result.kept).toEqual(["SYSTEM.md", "skills/briefing"]);
    expect(readFileSync(join(dataDir, "SYSTEM.md"), "utf8")).toBe(
      "Prompt from before the sync existed.\n",
    );
  });

  it("replaces the whole skill directory on update, dropping stale support files", () => {
    const { bundledDir, dataDir } = makeDirs();
    mkdirSync(join(bundledDir, "skills", "briefing", "references"));
    writeFileSync(join(bundledDir, "skills", "briefing", "references", "old.md"), "old\n");
    syncBundledContent({ dataDir, bundledDir });

    rmSync(join(bundledDir, "skills", "briefing", "references"), { recursive: true });
    writeFileSync(join(bundledDir, "skills", "briefing", "SKILL.md"), SKILL(2));
    const result = syncBundledContent({ dataDir, bundledDir });

    expect(result.updated).toEqual(["skills/briefing"]);
    expect(existsSync(join(dataDir, "skills", "briefing", "references"))).toBe(false);
  });

  it("forgets skills dropped from the bundle but keeps the local copy", () => {
    const { bundledDir, dataDir } = makeDirs();
    syncBundledContent({ dataDir, bundledDir });

    rmSync(join(bundledDir, "skills", "briefing"), { recursive: true });
    const result = syncBundledContent({ dataDir, bundledDir });

    expect(result).toEqual({ seeded: [], updated: [], kept: [] });
    expect(existsSync(join(dataDir, "skills", "briefing", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dataDir, ".bundled-manifest.json"), "utf8"));
    expect(Object.keys(manifest)).toEqual(["SYSTEM.md"]);
  });
});
