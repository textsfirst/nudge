import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  buildSendUpdateTool,
  DEFAULT_MAX_LINES,
  executeBash,
  FileWorkspace,
  MAX_LIST_ENTRIES,
  MEMORY_LIMITS,
  splitLines,
  truncateHead,
  truncateTail,
} from "../src/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nudge-tools-"));
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("truncate", () => {
  it("passes short content through untouched", () => {
    const result = truncateHead("a\nb");
    expect(result).toMatchObject({ text: "a\nb", truncated: false, totalLines: 2 });
  });

  it("does not count a trailing newline as a line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(truncateHead("").totalLines).toBe(0);
  });

  it("keeps the head or tail at the line cap", () => {
    const content = numberedLines(2500);
    const head = truncateHead(content);
    expect(head.truncatedBy).toBe("lines");
    expect([head.firstLine, head.lastLine]).toEqual([1, DEFAULT_MAX_LINES]);
    expect(splitLines(head.text).at(-1)).toBe("line 2000");

    const tail = truncateTail(content);
    expect([tail.firstLine, tail.lastLine]).toEqual([501, 2500]);
    expect(splitLines(tail.text)[0]).toBe("line 501");
  });

  it("accounts bytes as UTF-8 and never splits a code point", () => {
    // "é" is 2 bytes: three 100-char lines are 200 bytes each.
    const result = truncateHead(Array(3).fill("é".repeat(100)).join("\n"), { maxBytes: 350 });
    expect(result.truncatedBy).toBe("bytes");
    expect(result.lastLine).toBe(1);

    // A single line over the whole budget is sliced, not dropped.
    const emoji = truncateHead("😀".repeat(100), { maxBytes: 101 });
    expect(emoji.truncated).toBe(true);
    expect(Buffer.byteLength(emoji.text, "utf8")).toBeLessThanOrEqual(101);
    expect(emoji.text).toBe("😀".repeat(25)); // 4 bytes each; 101 rounds down to 25
  });
});

describe("read_file paging", () => {
  it("returns small files verbatim", () => {
    const workspace = new FileWorkspace(tempDir());
    workspace.write("notes.md", "hello\nworld\n");
    expect(workspace.read("notes.md")).toBe("hello\nworld\n");
  });

  it("caps long files with a continuation footer", () => {
    const workspace = new FileWorkspace(tempDir());
    workspace.write("big.md", numberedLines(2500));
    const first = workspace.read("big.md");
    expect(first).toContain("line 2000");
    expect(first).not.toContain("line 2001\n");
    expect(first).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");

    const rest = workspace.read("big.md", { offset: 2001 });
    expect(rest.startsWith("line 2001")).toBe(true);
    expect(rest).toContain("line 2500");
    expect(rest).not.toContain("[Showing");
  });

  it("notes remaining lines when a user limit stops early", () => {
    const workspace = new FileWorkspace(tempDir());
    workspace.write("doc.md", numberedLines(200));
    const page = workspace.read("doc.md", { offset: 1, limit: 80 });
    expect(splitLines(page)[79]).toBe("line 80");
    expect(page).toContain("[120 more lines in file. Use offset=81 to continue.]");
  });

  it("names the byte cap when it is the limiting factor", () => {
    const workspace = new FileWorkspace(tempDir());
    workspace.write("wide.md", Array(100).fill("x".repeat(1000)).join("\n"));
    expect(workspace.read("wide.md")).toContain("(50KB limit). Use offset=");
  });

  it("rejects an offset beyond the end of the file", () => {
    const workspace = new FileWorkspace(tempDir());
    workspace.write("doc.md", numberedLines(200));
    expect(workspace.read("doc.md", { offset: 300 })).toBe(
      "Error: offset 300 is beyond the end of doc.md (200 lines).",
    );
  });
});

describe("applyEdits", () => {
  it("applies batched edits back-to-front", () => {
    const outcome = applyEdits("alpha\nbeta\ngamma", [
      { oldText: "gamma", newText: "GAMMA" },
      { oldText: "alpha", newText: "ALPHA" },
    ]);
    expect(outcome).toEqual({ ok: true, result: "ALPHA\nbeta\nGAMMA" });
  });

  it("reports not-found with the multi-edit label", () => {
    const single = applyEdits("abc", [{ oldText: "zzz", newText: "y" }]);
    expect(single).toMatchObject({ ok: false });
    if (!single.ok) expect(single.error).toContain("Error: oldText not found");

    const multi = applyEdits("abc", [
      { oldText: "a", newText: "A" },
      { oldText: "zzz", newText: "y" },
      { oldText: "c", newText: "C" },
    ]);
    if (!multi.ok) expect(multi.error).toContain("edit 2 of 3: oldText not found");
  });

  it("requires uniqueness and rejects overlaps", () => {
    const dupe = applyEdits("x x", [{ oldText: "x", newText: "y" }]);
    if (!dupe.ok) expect(dupe.error).toContain("matches 2 locations");

    const overlap = applyEdits("abcdef", [
      { oldText: "abcd", newText: "1" },
      { oldText: "cdef", newText: "2" },
    ]);
    if (!overlap.ok) expect(overlap.error).toContain("edits 1 and 2 overlap");
  });

  it("rejects edits that change nothing", () => {
    const outcome = applyEdits("abc", [{ oldText: "b", newText: "b" }]);
    if (!outcome.ok) expect(outcome.error).toContain("produce no change");
  });
});

describe("FileWorkspace.edit", () => {
  it("edits in place and validates the result", () => {
    const dir = tempDir();
    const workspace = new FileWorkspace(dir);
    workspace.write("SCHEDULE.md", "## Morning\nwhen: every day at 7:30\nSay hi.");
    expect(
      workspace.edit("SCHEDULE.md", [{ oldText: "at 7:30", newText: "at 8:00" }]),
    ).toContain("Applied 1 edit to SCHEDULE.md");
    expect(readFileSync(join(dir, "SCHEDULE.md"), "utf8")).toContain("every day at 8:00");
  });

  it("keeps validators enforced: bad schedule grammar is not saved", () => {
    const workspace = new FileWorkspace(tempDir());
    workspace.write("SCHEDULE.md", "## Morning\nwhen: every day at 7:30\nSay hi.");
    const rejected = workspace.edit("SCHEDULE.md", [
      { oldText: "every day at 7:30", newText: "whenever" },
    ]);
    expect(rejected).toContain("Error: not saved.");
    expect(workspace.read("SCHEDULE.md")).toContain("every day at 7:30");
  });

  it("keeps validators enforced: memory budget survives edits", () => {
    const dir = tempDir();
    const workspace = new FileWorkspace(dir);
    workspace.write("MEMORY.md", "- seed");
    const rejected = workspace.edit("MEMORY.md", [
      { oldText: "- seed", newText: "x".repeat(MEMORY_LIMITS["MEMORY.md"]! + 1) },
    ]);
    expect(rejected).toContain("capped at");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- seed");
  });

  it("refuses read-only, hidden, and missing files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "README.md"), "docs");
    const workspace = new FileWorkspace(dir);
    expect(workspace.edit("README.md", [{ oldText: "docs", newText: "x" }])).toContain(
      "read-only",
    );
    expect(workspace.edit("chatgpt-auth.json", [{ oldText: "a", newText: "b" }])).toContain(
      "not writable",
    );
    expect(workspace.edit("missing.md", [{ oldText: "a", newText: "b" }])).toContain(
      'no file "missing.md"',
    );
  });
});

describe("list_files cap", () => {
  it("caps huge listings with a footer", () => {
    const dir = tempDir();
    for (let i = 0; i < MAX_LIST_ENTRIES + 10; i += 1) {
      writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.md`), "x");
    }
    const listing = new FileWorkspace(dir).list();
    expect(splitLines(listing)).toHaveLength(MAX_LIST_ENTRIES + 1); // entries + footer
    expect(listing).toContain(`[Showing ${MAX_LIST_ENTRIES} of ${MAX_LIST_ENTRIES + 10} files.]`);
  });
});

describe("executeBash", () => {
  const cwd = tempDir();

  it("returns stdout, and (no output) for silent success", async () => {
    expect((await executeBash("echo hi", { cwd })).trim()).toBe("hi");
    expect(await executeBash("true", { cwd })).toBe("(no output)");
  });

  it("appends the exit status after the captured output", async () => {
    const result = await executeBash("echo boom >&2; exit 3", { cwd });
    expect(result).toContain("boom");
    expect(result).toContain("Command exited with code 3");
  });

  it("runs in the given working directory", async () => {
    const dir = tempDir();
    const result = await executeBash("pwd", { cwd: dir });
    expect(result.trim()).toBe(realpathSync(dir));
  });

  it("merges the provided env over the inherited one", async () => {
    const result = await executeBash('echo "$NUDGE_GOOGLE_DIR"', {
      cwd,
      env: { NUDGE_GOOGLE_DIR: "/tmp/google" },
    });
    expect(result.trim()).toBe("/tmp/google");
  });

  it("kills the process tree on timeout", async () => {
    const started = Date.now();
    const result = await executeBash("sleep 5; echo late", { cwd, timeoutSeconds: 1 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toContain("Command timed out after 1 seconds");
    expect(result).not.toContain("late");
  });

  it("tail-truncates long output and spills the full output to a temp file", async () => {
    const result = await executeBash("seq 1 5000", { cwd });
    expect(result).toContain("5000");
    expect(result).not.toMatch(/^1\n/);
    const footer = /\[Output truncated: showing last 2000 of 5000 lines\. Full output: (.+)\]/.exec(
      result,
    );
    expect(footer).not.toBeNull();
    const spilled = readFileSync(footer![1]!, "utf8");
    expect(spilled.startsWith("1\n")).toBe(true);
    expect(spilled.endsWith("5000\n")).toBe(true);
  });

  it("is not held open by a detached grandchild holding the pipes", async () => {
    const started = Date.now();
    const result = await executeBash("sleep 20 & echo done", { cwd });
    expect(result).toContain("done");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("strips ANSI escapes and control characters", async () => {
    const result = await executeBash("printf 'a\\033[31mred\\033[0m\\007b'", { cwd });
    expect(result).toBe("aredb");
  });

  it("reports spawn failures as errors", async () => {
    const result = await executeBash("echo hi", { cwd: join(cwd, "does-not-exist") });
    expect(result.startsWith("Error:")).toBe(true);
  });
});

describe("send_update", () => {
  function makeTool(send: (text: string) => Promise<void>) {
    const execute = buildSendUpdateTool(send)["send_update"]!.execute as (
      input: { text: string },
      options: { toolCallId: string; messages: [] },
    ) => Promise<string>;
    return (text: string) => execute({ text }, { toolCallId: "call-1", messages: [] });
  }

  it("sends the trimmed update and confirms", async () => {
    const sent: string[] = [];
    const update = makeTool(async (text) => void sent.push(text));
    await expect(update("  checking your calendar  ")).resolves.toBe("sent");
    expect(sent).toEqual(["checking your calendar"]);
  });

  it("strips reply tokens and skips updates that were nothing else", async () => {
    const sent: string[] = [];
    const update = makeTool(async (text) => void sent.push(text));
    await expect(update("on it [NEW_THREAD]")).resolves.toBe("sent");
    await expect(update("[SILENT]")).resolves.toBe("skipped: empty update");
    await expect(update("[REACT:👍]")).resolves.toBe("skipped: empty update");
    expect(sent).toEqual(["on it"]);
  });

  it("skips a repeat of the last update", async () => {
    const sent: string[] = [];
    const update = makeTool(async (text) => void sent.push(text));
    await update("still digging");
    await expect(update("still digging")).resolves.toContain("skipped");
    expect(sent).toEqual(["still digging"]);
  });

  it("refuses updates past the per-turn cap", async () => {
    const sent: string[] = [];
    const update = makeTool(async (text) => void sent.push(text));
    for (let i = 0; i < 5; i += 1) {
      await expect(update(`update ${i}`)).resolves.toBe("sent");
    }
    await expect(update("one too many")).resolves.toContain("update limit reached");
    expect(sent).toHaveLength(5);
  });

  it("degrades a send failure to a result string", async () => {
    const update = makeTool(async () => {
      throw new Error("space unavailable");
    });
    await expect(update("hello")).resolves.toBe("failed to send: space unavailable");
  });
});
