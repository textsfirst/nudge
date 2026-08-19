import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeStore } from "@nudge/store";
import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildTools,
  DEFAULT_SYSTEM_FILE,
  FileWorkspace,
  MEMORY_LIMITS,
  MemoryFiles,
  PEOPLE_FILE_LIMIT,
  SkillsLibrary,
  startOfDayInZone,
} from "../src/index.js";

const NOW = new Date(Date.UTC(2026, 7, 10, 15, 0, 0));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nudge-units-"));
}

describe("buildSystemPrompt", () => {
  const base = {
    memory: "",
    skills: [],
    carryover: null,
    compactionSummary: null,
    now: NOW,
    timeZone: "UTC",
  };

  it("orders the stack: SYSTEM.md, guidance, memory, skills, time tail", () => {
    const prompt = buildSystemPrompt({
      ...base,
      systemFile: "You are Testy.",
      memory: "## Memory\n- fact",
      skills: [{ name: "deploys", description: "How to deploy", version: "1" }],
    });
    const positions = [
      prompt.indexOf("You are Testy."),
      prompt.indexOf("## How you work"),
      prompt.indexOf("## Memory"),
      prompt.indexOf("deploys: How to deploy"),
      prompt.indexOf("Current local time:"),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("falls back to the built-in identity when SYSTEM.md is absent", () => {
    const prompt = buildSystemPrompt({ ...base, systemFile: undefined });
    expect(prompt.startsWith(DEFAULT_SYSTEM_FILE.slice(0, 30))).toBe(true);
  });

  it("names connected Google accounts only when bash carries the gws shim", () => {
    const accounts = [{ label: "work", email: "w@corp.com" }];
    const withGws = buildSystemPrompt({
      ...base,
      systemFile: "x",
      bashEnabled: true,
      googleAccounts: accounts,
    });
    expect(withGws).toContain("work (w@corp.com)");
    expect(withGws).toContain("gws -a <account>");

    const noBash = buildSystemPrompt({
      ...base,
      systemFile: "x",
      bashEnabled: false,
      googleAccounts: accounts,
    });
    expect(noBash).not.toContain("gws");
    const noAccounts = buildSystemPrompt({ ...base, systemFile: "x", bashEnabled: true });
    expect(noAccounts).not.toContain("gws -a");
  });
});

describe("startOfDayInZone", () => {
  it("computes local midnight for offset zones", () => {
    // 2026-08-10 03:00 UTC is 2026-08-09 20:00 in Los Angeles (UTC-7 in August).
    const at = new Date(Date.UTC(2026, 7, 10, 3, 0, 0));
    expect(startOfDayInZone(at, "UTC")).toBe(Date.UTC(2026, 7, 10));
    expect(startOfDayInZone(at, "America/Los_Angeles")).toBe(Date.UTC(2026, 7, 9, 7));
  });
});

describe("FileWorkspace", () => {
  it("lists, reads, and writes ordinary files", () => {
    const workspace = new FileWorkspace(tempDir());
    expect(workspace.list()).toBe("(no files yet)");
    expect(workspace.write("notes.md", "hello")).toContain("Saved notes.md");
    expect(workspace.read("notes.md")).toBe("hello");
    expect(workspace.list()).toBe("notes.md");
    expect(workspace.read("missing.md")).toContain('no file "missing.md"');
  });

  it("blocks traversal, secrets, and runtime state", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "chatgpt-auth.json"), "{\"secret\":true}");
    writeFileSync(join(dir, "console-auth.json"), "{\"capability\":\"secret\"}");
    writeFileSync(join(dir, "nudge.db"), "sqlite");
    mkdirSync(join(dir, "google", "work"), { recursive: true });
    writeFileSync(join(dir, "google", "work", "credentials.json"), "{\"refresh_token\":\"r\"}");
    const workspace = new FileWorkspace(dir);

    expect(workspace.read("../outside.md")).toContain("outside your data directory");
    expect(workspace.read("chatgpt-auth.json")).toContain("not readable");
    expect(workspace.read("console-auth.json")).toContain("not readable");
    expect(workspace.read("google/work/credentials.json")).toContain("not readable");
    expect(workspace.write("google/notes.md", "x")).toContain("not writable");
    expect(workspace.write("nudge.db", "x")).toContain("not writable");
    expect(workspace.list()).toBe("(no files yet)");
  });

  it("rejects symlink escapes out of the data directory", () => {
    const dir = tempDir();
    const outside = join(dir, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "TOP_SECRET");
    symlinkSync(outside, join(dir, "escape"));
    const workspace = new FileWorkspace(dir);
    expect(workspace.read("escape")).toContain("outside your data directory");
    expect(workspace.write("escape", "OVERWRITTEN")).toContain("outside your data directory");
    expect(readFileSync(outside, "utf8")).toBe("TOP_SECRET");
  });

  it("keeps SYSTEM.md and README.md read-only to the agent", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "SYSTEM.md"), "identity");
    const workspace = new FileWorkspace(dir);
    expect(workspace.read("SYSTEM.md")).toBe("identity");
    expect(workspace.write("SYSTEM.md", "hijacked")).toContain("read-only");
    expect(workspace.write("README.md", "docs")).toContain("read-only");
  });

  it("validates SCHEDULE.md writes with diagnostics", () => {
    const workspace = new FileWorkspace(tempDir());
    const bad = workspace.write("SCHEDULE.md", "## Vibes\nwhen: whenever\nGo.");
    expect(bad).toContain("not saved");
    expect(bad).toContain("cannot parse");
    expect(workspace.read("SCHEDULE.md")).toContain("no file");

    expect(
      workspace.write("SCHEDULE.md", "## Morning\nwhen: every day at 7:30\nSay hi."),
    ).toContain("Saved SCHEDULE.md");
  });

  it("enforces memory budgets", () => {
    const workspace = new FileWorkspace(tempDir());
    expect(workspace.write("USER.md", "- likes espresso")).toContain("Saved");
    const over = workspace.write("USER.md", "x".repeat(MEMORY_LIMITS["USER.md"]! + 1));
    expect(over).toContain("capped at 1375");
    expect(workspace.read("USER.md")).toBe("- likes espresso");
  });

  it("enforces the LOOPS.md budget", () => {
    const workspace = new FileWorkspace(tempDir());
    const under = "## Landlord\nwaiting on a reply\n";
    expect(workspace.write("LOOPS.md", under)).toContain("Saved");
    const over = workspace.write("LOOPS.md", "x".repeat(MEMORY_LIMITS["LOOPS.md"]! + 1));
    expect(over).toContain("capped at 4000");
    expect(workspace.read("LOOPS.md")).toBe(under);
  });

  it("enforces people file layout and budget", () => {
    const workspace = new FileWorkspace(tempDir());
    const under = "- sister; calls her Sar\n";
    expect(workspace.write("people/sarah.md", under)).toContain("Saved");
    const over = workspace.write("people/sarah.md", "x".repeat(PEOPLE_FILE_LIMIT + 1));
    expect(over).toContain("capped at 1500");
    expect(workspace.read("people/sarah.md")).toBe(under);

    expect(workspace.write("people/nested/deep.md", "x")).toContain("people/<name>.md");
    expect(workspace.write("people/notes.txt", "x")).toContain("people/<name>.md");
    expect(workspace.read("people/nested/deep.md")).toContain("no file");
    expect(workspace.read("people/notes.txt")).toContain("no file");
  });

  it("lints skill frontmatter and layout", () => {
    const workspace = new FileWorkspace(tempDir());
    expect(workspace.write("skills/deploys/SKILL.md", "no frontmatter")).toContain(
      "needs YAML frontmatter",
    );
    expect(workspace.write("skills/SKILL.md", "---\nname: x\ndescription: y\n---\n")).toContain(
      "skills/<name>/SKILL.md",
    );
    expect(
      workspace.write(
        "skills/deploys/SKILL.md",
        "---\nname: deploys\ndescription: How to deploy\nversion: 1\n---\n\n## Steps",
      ),
    ).toContain("Saved");
  });
});

describe("MemoryFiles", () => {
  it("renders present files and stays empty otherwise", () => {
    const dir = tempDir();
    const memory = new MemoryFiles(dir);
    expect(memory.render()).toBe("");

    writeFileSync(join(dir, "USER.md"), "- night owl\n");
    writeFileSync(join(dir, "MEMORY.md"), "- check the ledger first\n");
    const rendered = memory.render();
    expect(rendered).toContain("## Memory");
    expect(rendered.indexOf("About the owner")).toBeLessThan(rendered.indexOf("Notes to self"));
    expect(rendered).toContain("night owl");
    expect(rendered).not.toContain("Open loops");
  });

  it("hints at open loops without injecting LOOPS.md", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "LOOPS.md"), "## Landlord\nwaiting\n\n## W-9\ndue Friday\n");
    const rendered = new MemoryFiles(dir).render();
    expect(rendered).toContain("## Memory");
    expect(rendered).toContain("### Open loops (LOOPS.md)");
    expect(rendered).toContain("2 open loops — read LOOPS.md before follow-ups or a rundown.");
    expect(rendered).not.toContain("waiting");
    expect(rendered).not.toContain("due Friday");

    writeFileSync(join(dir, "LOOPS.md"), "## Just one\nstill open\n");
    expect(new MemoryFiles(dir).render()).toContain("1 open loop —");
  });

  it("omits the loops hint when LOOPS.md is missing or has no headings", () => {
    const dir = tempDir();
    expect(new MemoryFiles(dir).render()).toBe("");
    writeFileSync(join(dir, "LOOPS.md"), "");
    expect(new MemoryFiles(dir).render()).toBe("");
    writeFileSync(join(dir, "LOOPS.md"), "nothing headed\n");
    expect(new MemoryFiles(dir).render()).toBe("");
  });
});

describe("SkillsLibrary", () => {
  it("lists skills from frontmatter, ignoring malformed ones", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "deploys"), { recursive: true });
    writeFileSync(
      join(dir, "deploys", "SKILL.md"),
      "---\nname: deploys\ndescription: How to deploy\nversion: 3\n---\nBody",
    );
    mkdirSync(join(dir, "empty-dir"), { recursive: true });

    expect(new SkillsLibrary(dir).list()).toEqual([
      { name: "deploys", description: "How to deploy", version: "3" },
    ]);
    expect(new SkillsLibrary(join(dir, "missing")).list()).toEqual([]);
  });
});

describe("tools", () => {
  it("exposes exactly the minimal surface", () => {
    const tools = buildTools({
      workspace: new FileWorkspace(tempDir()),
      store: new NudgeStore(":memory:"),
    });
    expect(Object.keys(tools).sort()).toEqual([
      "edit_file",
      "list_files",
      "read_file",
      "search_history",
      "write_file",
    ]);
  });

  it("adds bash only when a working directory is provided", () => {
    const context = {
      workspace: new FileWorkspace(tempDir()),
      store: new NudgeStore(":memory:"),
    };
    expect(Object.keys(buildTools(context))).not.toContain("bash");
    expect(Object.keys(buildTools({ ...context, bash: { cwd: tempDir() } }))).toContain("bash");
  });

  it("searches history verbatim", async () => {
    const store = new NudgeStore(":memory:");
    const session = store.startSession("+1", 1_000);
    store.appendMessage({
      sessionId: session.id,
      handle: "+1",
      role: "user",
      content: "the wifi password is hunter2",
    });
    const tools = buildTools({ workspace: new FileWorkspace(tempDir()), store });
    const search = tools.search_history!.execute as (input: unknown) => Promise<string>;
    expect(await search({ query: "wifi password" })).toContain("hunter2");
    expect(await search({ query: "zzznope" })).toContain("No messages match");
  });

  it("round-trips schedule edits through the file tools", async () => {
    const dir = tempDir();
    const tools = buildTools({
      workspace: new FileWorkspace(dir),
      store: new NudgeStore(":memory:"),
    });
    const write = tools.write_file!.execute as (input: unknown) => Promise<string>;
    const read = tools.read_file!.execute as (input: unknown) => Promise<string>;

    expect(
      await write({ path: "SCHEDULE.md", content: "## Hi\nwhen: every day at 9:00\nSay hi." }),
    ).toContain("Saved");
    expect(await read({ path: "SCHEDULE.md" })).toContain("every day at 9:00");
    expect(readFileSync(join(dir, "SCHEDULE.md"), "utf8")).toContain("Say hi.");
  });
});
