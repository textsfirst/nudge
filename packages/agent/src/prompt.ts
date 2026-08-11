import { readBundledFile } from "./content.js";
import type { SkillMeta } from "./skills.js";
import { formatLocalTime } from "./time.js";

/**
 * The shipped system prompt (content/SYSTEM.md). Seeded into DATA_DIR at boot;
 * used directly when the owner deletes or empties their copy.
 */
export const DEFAULT_SYSTEM_FILE = readBundledFile("SYSTEM.md").trim();

/**
 * Slot 2 of the prompt stack. Deliberately small: file formats live in the
 * data directory's README.md and cost tokens only when consulted.
 */
export const TOOL_GUIDANCE = `## How you work

You are a texting assistant. Everything you know and do is defined by markdown
files in your data directory (list_files / read_file / edit_file / write_file);
README.md there documents every format — read it before writing a file type for
the first time in a conversation. Prefer edit_file for changing part of an
existing file; write_file replaces the whole file. Long files are paged — follow
the offset hint in the footer. Threads roll over silently at midnight and after
long idle gaps; you get a summary of the previous thread when they do. There
are no user commands — everything is natural conversation.

Reply tokens:
- Reply exactly [SILENT] when no reply is needed (bare "ok", "thanks").
- Reply [REACT:👍] to tapback the owner's last text instead of typing — ❤️ 👍
  👎 😂 ‼️ ❓ only. Alone it is a complete reply; put text after it to do both.
- Append [NEW_THREAD] when the owner asks to start over; it is stripped before
  sending and the thread resets afterward.

Your files (formats in README.md):
- SCHEDULE.md — every proactive message. Never promise a reminder without
  writing it here; confirm in plain language after saving.
- USER.md / MEMORY.md — bounded curated memory, injected every turn. Save
  durable facts (preferences, corrections, recurring people); skip ephemera.
  Over-budget writes fail — consolidate, then retry.
- skills/<name>/SKILL.md — your procedural memory. When the skills list shows
  something relevant, read it before acting. After solving a non-obvious
  problem or being corrected, save the lesson as a skill.

Use search_history for verbatim recall beyond the current thread.

When a scheduled prompt wakes you, you are messaging the owner proactively:
deliver something useful and self-contained, or [SILENT] if there is truly
nothing worth saying.`;

/**
 * Appended to the tool guidance only when Firecrawl is configured — naming
 * the web tools while they are absent invites hallucinated calls.
 */
const WEB_TOOL_GUIDANCE = `web_search finds pages; web_extract reads them as markdown. Search when
you need to find the right pages; extract when you already know the URL.`;

/** Appended only when the bash tool is in the set, for the same reason. */
const BASH_TOOL_GUIDANCE = `bash runs shell commands with your data directory as the working directory.
Use it for file operations (ls, grep, wc, find) and quick computation. Do not
use it to bypass the file tools' validation of SCHEDULE.md and memory files.`;

/** Appended only on the reply path, where the send_update tool is in the set. */
const PROGRESS_TOOL_GUIDANCE = `send_update texts the owner one short line while you keep working — it is how
you say "on it" without ending your turn. When a request will take more than a
moment (several lookups, web research, a run of commands), send a quick ack in
your usual voice ("on it", "give me a sec, checking") before you start, and
another short line if the work drags or changes shape. Quick one-tool-call
answers don't need one. It never replaces the reply you finish the turn with,
and that reply shouldn't repeat the updates.`;

/** Appended only when the send_file tool is in the set (reply path, multimodal on). */
const SEND_FILE_TOOL_GUIDANCE = `send_file texts the owner a file from your data directory — a photo they sent
earlier (saved under attachments/), or an image, PDF, or text file you made.
The file lands as its own message before your reply, so don't describe what
they can already see. You can never send audio or voice messages.`;

/** One line per connected Google account, only when bash carries the gws shim. */
function googleGuidance(accounts: GoogleAccountRef[]): string {
  const list = accounts
    .map((account) => `${account.label} (${account.email})`)
    .join(", ");
  return `The owner's Google accounts are connected: ${list}. Use the gws CLI in bash —
\`gws -a <account> ...\` — for Gmail, Calendar, Drive, and the rest; the
google-workspace skill has commands and pitfalls. \`gws accounts\` shows each
account's granted services. Google auth is owner-managed: never run \`gws auth\`;
if an account's auth has expired, say so instead of retrying.`;
}

export interface GoogleAccountRef {
  label: string;
  email: string;
}

export interface PromptStackInput {
  systemFile: string | undefined;
  memory: string;
  skills: SkillMeta[];
  carryover: string | null;
  compactionSummary: string | null;
  now: Date;
  timeZone: string;
  webEnabled?: boolean;
  bashEnabled?: boolean;
  /** True only on the reply path, where the send_update tool exists. */
  progressEnabled?: boolean;
  /** True only when the send_file tool exists (reply path, multimodal on). */
  fileSendEnabled?: boolean;
  /** Connected Google accounts; non-empty adds gws guidance (needs bash). */
  googleAccounts?: GoogleAccountRef[];
}

/**
 * The 5-slot stack: SYSTEM.md → tool guidance → memory → skills → volatile
 * time tail. Stable content first so prompt-prefix caching survives turns.
 */
export function buildSystemPrompt(input: PromptStackInput): string {
  let guidance = TOOL_GUIDANCE;
  if (input.webEnabled) guidance += `\n\n${WEB_TOOL_GUIDANCE}`;
  if (input.bashEnabled) guidance += `\n\n${BASH_TOOL_GUIDANCE}`;
  if (input.bashEnabled && input.googleAccounts && input.googleAccounts.length > 0) {
    guidance += `\n\n${googleGuidance(input.googleAccounts)}`;
  }
  if (input.progressEnabled) guidance += `\n\n${PROGRESS_TOOL_GUIDANCE}`;
  if (input.fileSendEnabled) guidance += `\n\n${SEND_FILE_TOOL_GUIDANCE}`;
  const sections = [input.systemFile?.trim() || DEFAULT_SYSTEM_FILE, guidance];

  if (input.memory) {
    sections.push(input.memory);
  }
  if (input.skills.length > 0) {
    sections.push(
      `## Skills\nRead skills/<name>/SKILL.md before relying on one.\n${input.skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join("\n")}`,
    );
  }
  if (input.carryover) {
    sections.push(`## Where the previous thread left off\n${input.carryover}`);
  }
  if (input.compactionSummary) {
    sections.push(`## Earlier in this thread (compacted)\n${input.compactionSummary}`);
  }
  sections.push(
    `Current local time: ${formatLocalTime(input.now, input.timeZone)} (${input.timeZone})`,
  );
  return sections.join("\n\n");
}
