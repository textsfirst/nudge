import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Curated memory rendered into the prompt stack. USER.md and MEMORY.md are
 * injected wholesale; LOOPS.md contributes only a one-line status hint.
 * The agent maintains them through the generic file tools; MEMORY_LIMITS in
 * files.ts enforces their budgets at write time.
 *
 * A missing or empty file renders as an explicit empty marker rather than
 * disappearing: a blank slot the model can see is a nudge to fill it, while
 * an absent section gives no signal the file exists at all.
 */
export class MemoryFiles {
  constructor(private readonly dataDir: string) {}

  render(): string {
    const sections: string[] = [];
    const user = this.raw("USER.md");
    sections.push(
      `### About the owner (USER.md)\n${user || "(empty — nothing saved about the owner yet)"}`,
    );
    const agent = this.raw("MEMORY.md");
    sections.push(`### Notes to self (MEMORY.md)\n${agent || "(empty — no notes saved yet)"}`);
    const loops = this.raw("LOOPS.md");
    if (loops) {
      const count = loops.split("\n").filter((line) => /^## /.test(line)).length;
      if (count > 0) {
        const label = count === 1 ? "1 open loop" : `${count} open loops`;
        sections.push(
          `### Open loops (LOOPS.md)\n${label} — read LOOPS.md before follow-ups or a rundown.`,
        );
      }
    }
    return `## Memory\n${sections.join("\n\n")}`;
  }

  /** The trimmed file content, or "" when missing/unreadable (memory promotion reads these). */
  raw(name: string): string {
    const path = join(this.dataDir, name);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  }
}
