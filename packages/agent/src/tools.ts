import type { NudgeStore } from "@nudge/store";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DEFAULT_BASH_TIMEOUT_SECONDS, executeBash, MAX_BASH_TIMEOUT_SECONDS } from "./bash.js";
import { MAX_LIST_ENTRIES, type FileWorkspace } from "./files.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";
import { findUrlSecret, stripBase64Images, truncateHeadTail, type FirecrawlClient } from "./web.js";

export interface ToolContext {
  workspace: FileWorkspace;
  store: NudgeStore;
  /** When absent, the web tools are omitted from the set entirely. */
  web?: FirecrawlClient;
  /** When absent, the bash tool is omitted. cwd is a default, not a jail. */
  bash?: { cwd: string; env?: Record<string, string> | undefined };
}

/**
 * The whole tool surface: three generic file operations over the data
 * directory (files are the API — schedule, memory, skills are all file
 * conventions documented in README.md) plus genuine computation: full-text
 * history search and, when Firecrawl is configured, web search/extract.
 */
export function buildTools(context: ToolContext): ToolSet {
  return {
    ...(context.web ? webTools(context.web) : {}),
    ...(context.bash ? bashTool(context.bash) : {}),
    list_files: tool({
      description: `List every file in your data directory (up to ${MAX_LIST_ENTRIES} entries).`,
      inputSchema: z.object({}),
      execute: () => context.workspace.list(),
    }),

    read_file: tool({
      description: `Read a file from your data directory (README.md documents the formats). Returns at most ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; page longer files with offset (1-indexed line) and limit, following the footer's hint.`,
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).optional(),
      }),
      execute: ({ path, offset, limit }) => context.workspace.read(path, { offset, limit }),
    }),

    edit_file: tool({
      description:
        "Replace exact text in an existing file. Each edit's oldText must match the current file contents exactly (including whitespace) and appear exactly once — add surrounding lines to disambiguate. The result is validated like write_file. Prefer this over write_file for small changes.",
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(z.object({ oldText: z.string().min(1), newText: z.string() }))
          .min(1),
      }),
      execute: ({ path, edits }) => context.workspace.edit(path, edits),
    }),

    write_file: tool({
      description:
        "Create or replace a whole file in your data directory. Writes are validated per file (schedule grammar, memory budgets, skill frontmatter) and rejected with diagnostics. For small changes to an existing file, prefer edit_file.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: ({ path, content }) => context.workspace.write(path, content),
    }),

    search_history: tool({
      description:
        "Full-text search over every past message in every thread. Returns verbatim matches.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: ({ query, limit }) => {
        const hits = context.store.searchMessages(query, limit ?? 8);
        if (hits.length === 0) return `No messages match "${query}".`;
        return hits
          .map(
            (hit) =>
              `[${new Date(hit.createdAt).toISOString()}] ${hit.role}: ${truncate(hit.content, 400)}`,
          )
          .join("\n");
      },
    }),
  };
}

/** Progress texts allowed per turn before further updates are refused. */
const UPDATE_CAP = 5;

/**
 * The mid-turn progress tool, built fresh per reply turn around that turn's
 * send closure — the dedupe and cap state must not outlive the turn. Progress
 * is best-effort: a failed send degrades to a result string the model can
 * read, never an error that would sink the turn.
 */
export function buildSendUpdateTool(send: (text: string) => Promise<void>): ToolSet {
  let lastSent: string | undefined;
  let sent = 0;
  return {
    send_update: tool({
      description:
        "Text the owner one short progress line while you keep working. Only for tasks that take many steps; your usual voice rules apply. This never replaces your reply — finish the turn with a normal reply that doesn't repeat the updates.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        const update = text.replaceAll("[SILENT]", "").replaceAll("[NEW_THREAD]", "").trim();
        if (!update) return "skipped: empty update";
        if (update === lastSent) return "skipped: that update was already sent";
        if (sent >= UPDATE_CAP) {
          return "skipped: update limit reached for this turn — finish the task and reply";
        }
        try {
          await send(update);
        } catch (error) {
          return `failed to send: ${error instanceof Error ? error.message : String(error)}`;
        }
        lastSent = update;
        sent += 1;
        return "sent";
      },
    }),
  };
}

function bashTool(bash: { cwd: string; env?: Record<string, string> | undefined }): ToolSet {
  return {
    bash: tool({
      description: `Run a bash command; it executes in your data directory. Use it for file operations (ls, grep, wc, find) and quick computation. Returns stdout+stderr, capped at the last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB — when capped, the full output is saved to a temp file named in the footer. Commands time out after ${DEFAULT_BASH_TIMEOUT_SECONDS}s unless you pass timeout (seconds).`,
      inputSchema: z.object({
        command: z.string().min(1),
        timeout: z.number().finite().positive().max(MAX_BASH_TIMEOUT_SECONDS).optional(),
      }),
      execute: ({ command, timeout }, { abortSignal }) =>
        executeBash(command, {
          cwd: bash.cwd,
          ...(bash.env ? { env: bash.env } : {}),
          ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        }),
    }),
  };
}

const SEARCH_LIMIT_DEFAULT = 5;
const EXTRACT_URL_MAX = 3;
const EXTRACT_CHAR_DEFAULT = 12_000;

function webTools(web: FirecrawlClient): ToolSet {
  return {
    web_search: tool({
      description:
        'Search the web. Returns titles, URLs, and descriptions. Operators like site:example.com, -term, and "exact phrase" pass through. Use web_extract to read a result.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ query, limit }) => {
        try {
          const hits = await web.search(query, limit ?? SEARCH_LIMIT_DEFAULT);
          if (hits.length === 0) return `No results for "${query}".`;
          return hits
            .map(
              (hit, index) =>
                `${index + 1}. ${hit.title || hit.url}\n   ${hit.url}\n   ${truncate(hit.description, 300)}`,
            )
            .join("\n");
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),

    web_extract: tool({
      description:
        "Fetch web pages as clean markdown (works on PDFs too). Pages over the char budget are truncated head+tail with a footer showing totals; raise char_limit when you need more of a long page.",
      inputSchema: z.object({
        urls: z.array(z.string()).min(1).max(EXTRACT_URL_MAX),
        char_limit: z.number().int().min(2_000).max(50_000).optional(),
      }),
      execute: async ({ urls, char_limit }) => {
        const sections: string[] = [];
        for (const url of urls) {
          sections.push(await extractOne(web, url, char_limit ?? EXTRACT_CHAR_DEFAULT));
        }
        return sections.join("\n\n---\n\n");
      },
    }),
  };
}

async function extractOne(web: FirecrawlClient, url: string, budget: number): Promise<string> {
  const secret = findUrlSecret(url);
  if (secret) {
    return `## ${url}\nError: blocked — this URL contains ${secret}. Secrets must not be sent to the web extractor.`;
  }
  try {
    const page = await web.scrape(url);
    const clean = stripBase64Images(page.markdown).trim();
    if (!clean) return `## ${url}\nNo readable content at this URL.`;
    const heading = page.title ? `## ${page.title} — ${url}` : `## ${url}`;
    return `${heading}\n\n${truncateHeadTail(clean, budget)}`;
  } catch (error) {
    return `## ${url}\nError: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
