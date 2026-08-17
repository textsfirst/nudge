import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Curated memory rendered into the prompt stack. USER.md and MEMORY.md are
 * injected wholesale; LOOPS.md contributes only a one-line status hint.
 * The agent maintains them through the generic file tools; MEMORY_LIMITS in
 * files.ts enforces their budgets at write time.
 */
export class MemoryFiles {
  constructor(private readonly dataDir: string) {}

  render(): string {
    const sections: string[] = [];
    const user = this.#read("USER.md");
    if (user) sections.push(`### About the owner (USER.md)\n${user}`);
    const agent = this.#read("MEMORY.md");
    if (agent) sections.push(`### Notes to self (MEMORY.md)\n${agent}`);
    const loops = this.#read("LOOPS.md");
    if (loops) {
      const count = loops.split("\n").filter((line) => /^## /.test(line)).length;
      if (count > 0) {
        const label = count === 1 ? "1 open loop" : `${count} open loops`;
        sections.push(
          `### Open loops (LOOPS.md)\n${label} — read LOOPS.md before follow-ups or a rundown.`,
        );
      }
    }
    return sections.length > 0 ? `## Memory\n${sections.join("\n\n")}` : "";
  }

  #read(name: string): string {
    const path = join(this.dataDir, name);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  }
}
