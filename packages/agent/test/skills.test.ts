import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkillFrontmatter, SkillsLibrary, validateSkillMd } from "../src/skills.js";
import { validateDataFile } from "../src/files.js";

const VALID = `---
name: pdf-processing
description: Extract PDF text and fill forms. Use when handling PDFs.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
---

Body.
`;

describe("parseSkillFrontmatter", () => {
  it("reads flat fields and the nested metadata map", () => {
    const parsed = parseSkillFrontmatter(VALID);
    expect(parsed?.fields).toMatchObject({
      name: "pdf-processing",
      description: "Extract PDF text and fill forms. Use when handling PDFs.",
      license: "Apache-2.0",
    });
    expect(parsed?.metadata).toEqual({ author: "example-org", version: "1.0" });
    // metadata is a map, not a scalar field.
    expect(parsed?.fields.metadata).toBeUndefined();
  });

  it("returns undefined without frontmatter fences", () => {
    expect(parseSkillFrontmatter("# just markdown\n")).toBeUndefined();
  });
});

describe("validateSkillMd (Agent Skills spec)", () => {
  const skill = (frontmatter: string) => `---\n${frontmatter}\n---\nBody.\n`;

  it("accepts a conforming skill", () => {
    expect(validateSkillMd("pdf-processing", VALID)).toBeUndefined();
  });

  it("enforces the spec name rules", () => {
    for (const name of ["PDF-Processing", "-pdf", "pdf-", "pdf--processing", "a".repeat(65)]) {
      expect(
        validateSkillMd("x", skill(`name: ${name}\ndescription: d`)),
        name,
      ).toContain("invalid");
    }
  });

  it("requires the name to match the directory", () => {
    expect(validateSkillMd("triage", skill("name: email-triage\ndescription: d"))).toContain(
      'must match its directory "triage"',
    );
  });

  it("requires and caps the description", () => {
    expect(validateSkillMd("a", skill("name: a"))).toContain('"description:"');
    expect(validateSkillMd("a", skill(`name: a\ndescription: ${"x".repeat(1025)}`))).toContain(
      "1024",
    );
  });

  it("is wired into the data-file validator with the directory name", () => {
    const bad = validateDataFile("skills/triage/SKILL.md", skill("name: other\ndescription: d"));
    expect(bad).toContain("must match");
    expect(
      validateDataFile("skills/triage/SKILL.md", skill("name: triage\ndescription: d")),
    ).toBeUndefined();
  });
});

describe("SkillsLibrary tolerant reads", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("lists by directory name, honoring metadata.version and legacy version", () => {
    dir = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(dir, "modern"));
    writeFileSync(
      join(dir, "modern", "SKILL.md"),
      '---\nname: modern\ndescription: new style\nmetadata:\n  version: "2"\n---\nBody.\n',
    );
    mkdirSync(join(dir, "legacy"));
    writeFileSync(
      join(dir, "legacy", "SKILL.md"),
      "---\nname: elsewhere\ndescription: old style\nversion: 3\n---\nBody.\n",
    );
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "SKILL.md"), "no frontmatter at all\n");

    const list = new SkillsLibrary(dir).list();
    expect(list).toEqual([
      // Non-conforming skills still list — reads are tolerant on purpose.
      { name: "broken", description: "(no description)", version: "0" },
      // Directory name is identity even when frontmatter disagrees.
      { name: "legacy", description: "old style", version: "3" },
      { name: "modern", description: "new style", version: "2" },
    ]);
  });
});
