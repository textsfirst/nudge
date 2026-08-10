import { readFileSync, writeFileSync } from "node:fs";
import { Document, Pair, Scalar, YAMLMap, parseDocument, parse as parseYamlDocument } from "yaml";
import { z } from "zod";
import { resolveFromWorkspace } from "./paths.js";

export const CONFIG_FILE = "nudge.config.yaml";

export const settingsSchema = z.object({
  owner_handle: z.string().min(1, "set it to your handle — the exact sender.id Photon sends"),
  timezone: z
    .string()
    .min(1)
    .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    .refine(isValidTimeZone, { message: "must be an IANA timezone like America/Los_Angeles" }),
  provider: z
    .object({
      selected: z.enum(["chatgpt-subscription", "openai-api"]).default("chatgpt-subscription"),
      chatgpt: z
        .object({
          model: z.string().min(1).default("gpt-5.4-mini"),
          auth_file: z.string().min(1).default(".data/chatgpt-auth.json"),
        })
        .prefault({}),
      openai: z
        .object({
          model: z.string().min(1).default("gpt-5-mini"),
          fallback_enabled: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  model: z
    .object({
      reasoning_effort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
      fast_mode: z.boolean().default(false),
    })
    .prefault({}),
  tools: z
    .object({
      bash_enabled: z.boolean().default(true),
      firecrawl_url: z.url().optional(),
    })
    .prefault({}),
  google: z
    .object({
      default_account: z.string().min(1).optional(),
      gws_path: z.string().min(1).optional(),
    })
    .prefault({}),
  data_dir: z.string().min(1).default(".data"),
  threads: z
    .object({
      idle_hours: z.number().min(0.1).max(168).default(6),
      debounce_ms: z.number().int().min(0).max(30_000).default(2_500),
    })
    .prefault({}),
  agent: z
    .object({
      max_tool_steps: z.number().int().min(1).max(500).default(64),
      max_history_messages: z.number().int().min(4).max(400).default(40),
    })
    .prefault({}),
  server: z
    .object({
      port: z.number().int().min(1).max(65_535).default(3_000),
      log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function parseSettings(yamlText: string): Settings {
  let document: unknown;
  try {
    document = parseYamlDocument(yamlText);
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = settingsSchema.safeParse(document ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

// --- Seeding and updating the file on disk ---------------------------------
//
// The file is generated, not copied from an example: values come from the zod
// schema defaults above (so the written file can never drift from the code)
// and comments come from the spec below. On every boot, settings the schema
// gained since the file was written are appended in place with their defaults
// and doc comments; the user's values, comments, and ordering are never
// touched.

interface KeySpec {
  key: string;
  /**
   * Comment block rendered above the key. Commented-out optional settings
   * (timezone, reasoning_effort, firecrawl_url) live inside the comment of the
   * nearest concrete key below them, so they ride along whenever that key or
   * its section is inserted into an older file.
   */
  comment?: string;
  children?: KeySpec[];
}

/** Each entry renders as "# entry"; an empty trailing entry leaves a blank line before the key. */
function lines(...text: string[]): string {
  return text.map((line) => (line === "" ? "" : ` ${line}`)).join("\n");
}

const FILE_HEADER = lines(
  "Nudge settings. Secrets stay in .env.",
  "Created by Nudge; new settings are added here with their defaults on boot.",
  "Your values and comments are preserved.",
);

const SPEC: KeySpec[] = [
  {
    key: "owner_handle",
    comment: lines(
      "The one handle allowed to talk to Nudge. Use the exact sender.id Photon sends.",
    ),
  },
  {
    key: "provider",
    comment: lines(
      "IANA timezone for schedules and midnight thread rollover. Defaults to the",
      "machine's timezone when unset.",
      "timezone: America/Los_Angeles",
      "",
    ),
    children: [
      { key: "selected", comment: lines("chatgpt-subscription (default) or openai-api") },
      { key: "chatgpt", children: [{ key: "model" }, { key: "auth_file" }] },
      {
        key: "openai",
        children: [
          { key: "model" },
          {
            key: "fallback_enabled",
            comment: lines(
              "Automatic fallback for subscription auth failures (needs OPENAI_API_KEY in .env).",
            ),
          },
        ],
      },
    ],
  },
  {
    key: "model",
    children: [
      {
        key: "fast_mode",
        comment: lines(
          "Reasoning level for model calls: none, minimal, low, medium, high, xhigh, max.",
          "Unset uses the model's default.",
          "reasoning_effort: medium",
          "",
          "true routes model calls through the priority service tier (faster output).",
        ),
      },
    ],
  },
  {
    key: "tools",
    children: [
      {
        key: "bash_enabled",
        comment: lines(
          "Self-hosted Firecrawl instance for web_search and web_extract (no key needed).",
          "Firecrawl cloud instead needs FIRECRAWL_API_KEY in .env. The tools are hidden",
          "from the model when neither is set.",
          "firecrawl_url: http://localhost:3002",
          "",
          "The bash tool runs shell commands with data_dir as the working directory",
          "(a default, not a sandbox). Set to false to remove the tool entirely.",
        ),
      },
    ],
  },
  {
    key: "google",
    comment: lines(
      "Google accounts for the gws CLI are connected on the console's Connections page.",
      "Credentials live under data_dir/google/, never in this file.",
      "Optional: replace {} below with { default_account: personal } to choose the account",
      "used by bare gws, and add gws_path: /opt/homebrew/bin/gws for a custom binary.",
    ),
    children: [
      { key: "default_account" },
      { key: "gws_path" },
    ],
  },
  {
    key: "data_dir",
    comment: lines("Where Nudge keeps its SQLite database, SYSTEM.md, SCHEDULE.md, and skills/."),
  },
  {
    key: "threads",
    children: [
      {
        key: "idle_hours",
        comment: lines(
          "Threads roll over silently after this many idle hours (and at local midnight).",
        ),
      },
      {
        key: "debounce_ms",
        comment: lines(
          "How long to wait for follow-up texts before replying to a burst as one message.",
        ),
      },
    ],
  },
  {
    key: "agent",
    comment: lines("Agent loop limits."),
    children: [
      {
        key: "max_tool_steps",
        comment: lines(
          "Backstop against runaway tool loops, not a per-task budget. The agent is",
          "asked to wrap up a few steps before the cap; a loop repeating the same call",
          "for the same result (no new information — polling a changing status is",
          "fine) is warned, then stopped; and a cut-off turn still ends with a status",
          "reply. Long-horizon tasks only hit this when genuinely stuck.",
        ),
      },
      { key: "max_history_messages" },
    ],
  },
  { key: "server", children: [{ key: "port" }, { key: "log_level" }] },
];

/**
 * Every seeded value except owner_handle (which the user must fill in) comes
 * from the schema defaults. timezone stays commented out so it keeps tracking
 * the machine's timezone instead of freezing at seed time.
 */
function seedValues(): Record<string, unknown> {
  const defaults = settingsSchema.parse({ owner_handle: "placeholder" });
  return { ...defaults, owner_handle: "", timezone: undefined };
}

function buildPair(doc: Document, spec: KeySpec, value: unknown, topLevel: boolean, first: boolean): Pair {
  const key = doc.createNode(spec.key) as Scalar;
  if (spec.comment) key.commentBefore = spec.comment;
  if (topLevel && !first) key.spaceBefore = true;
  const node = spec.children
    ? buildMap(doc, spec.children, value as Record<string, unknown>, false)
    : doc.createNode(value);
  return new Pair(key, node);
}

function buildMap(
  doc: Document,
  specs: KeySpec[],
  values: Record<string, unknown>,
  topLevel: boolean,
): YAMLMap {
  const map = doc.createNode({}) as YAMLMap;
  for (const spec of specs) {
    const value = values[spec.key];
    if (value === undefined) continue;
    map.items.push(buildPair(doc, spec, value, topLevel, map.items.length === 0));
  }
  return map;
}

/** The full settings file as written on first run. */
export function seedText(): string {
  const doc = new Document();
  doc.commentBefore = FILE_HEADER;
  doc.contents = buildMap(doc, SPEC, seedValues(), true);
  return doc.toString();
}

function keyOf(pair: Pair): string | undefined {
  return pair.key instanceof Scalar && typeof pair.key.value === "string"
    ? pair.key.value
    : undefined;
}

/** Right after the last spec-known sibling that precedes this key, so unknown user keys stay put. */
function insertionIndex(map: YAMLMap, specs: KeySpec[], spec: KeySpec): number {
  const before = new Set(specs.slice(0, specs.indexOf(spec)).map((s) => s.key));
  let index = 0;
  for (const [i, item] of map.items.entries()) {
    const key = keyOf(item);
    if (key !== undefined && before.has(key)) index = i + 1;
  }
  return index;
}

function mergeMissing(
  doc: Document,
  map: YAMLMap,
  specs: KeySpec[],
  values: Record<string, unknown>,
  path: string[],
  added: string[],
): void {
  const topLevel = path.length === 0;
  for (const spec of specs) {
    const value = values[spec.key];
    if (value === undefined) continue;
    const existing = map.items.find((item) => keyOf(item) === spec.key);
    if (existing) {
      // A non-map where a section belongs is left for validation to report.
      if (spec.children && existing.value instanceof YAMLMap) {
        mergeMissing(doc, existing.value, spec.children, value as Record<string, unknown>, [...path, spec.key], added);
      }
      continue;
    }
    const insertAt = insertionIndex(map, specs, spec);
    map.items.splice(insertAt, 0, buildPair(doc, spec, value, topLevel, insertAt === 0));
    added.push([...path, spec.key].join("."));
  }
}

export interface EnsureResult {
  /** The file was missing (or empty) and has been seeded. */
  created: boolean;
  /** Dotted paths of settings appended to an existing file. */
  added: string[];
}

/**
 * Seed CONFIG_FILE if it is missing, or append any settings it lacks. Purely
 * additive: existing values, comments, and ordering are left alone, as are
 * files with invalid YAML (parseSettings reports those with a better message).
 */
export function ensureSettingsFile(path = resolveFromWorkspace(CONFIG_FILE)): EnsureResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    writeFileSync(path, seedText());
    return { created: true, added: [] };
  }
  if (raw.trim() === "") {
    writeFileSync(path, seedText());
    return { created: true, added: [] };
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) return { created: false, added: [] };
  const added: string[] = [];
  if (doc.contents == null) {
    // A comment-only file: keep the comments, add every setting.
    (doc as Document).contents = buildMap(doc, SPEC, seedValues(), true);
    added.push(...SPEC.map((spec) => spec.key));
  } else if (doc.contents instanceof YAMLMap) {
    mergeMissing(doc, doc.contents, SPEC, seedValues(), [], added);
  } else {
    return { created: false, added: [] };
  }
  if (added.length > 0) writeFileSync(path, doc.toString());
  return { created: false, added };
}

export function loadSettings(path = resolveFromWorkspace(CONFIG_FILE)): Settings {
  const ensured = ensureSettingsFile(path);
  if (ensured.created) {
    throw new Error(
      `Created ${CONFIG_FILE} with defaults — set owner_handle (the exact sender.id Photon sends), then start again.`,
    );
  }
  if (ensured.added.length > 0) {
    // Runs before the logger exists (its level comes from this file), so log directly.
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        message: `Added new settings to ${CONFIG_FILE}`,
        added: ensured.added,
      }),
    );
  }
  return parseSettings(readFileSync(path, "utf8"));
}
