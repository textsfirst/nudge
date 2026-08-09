import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two curated memory files, rendered into the prompt stack. The agent
 * maintains them through the generic file tools; MEMORY_LIMITS in files.ts
 * enforces their budgets at write time.
 */
export class MemoryFiles {
  constructor(private readonly dataDir: string) {}

  render(): string {
    const sections: string[] = [];
    const user = this.#read("USER.md");
    if (user) sections.push(`### About the owner (USER.md)\n${user}`);
    const agent = this.#read("MEMORY.md");
    if (agent) sections.push(`### Notes to self (MEMORY.md)\n${agent}`);
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
