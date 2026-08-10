import { z } from "zod";

/**
 * Settings live in the SQLite database as explicit overrides (dotted schema
 * paths mapped to JSON values); everything unset falls back to the defaults
 * below at read time, so new settings appear automatically after an upgrade.
 * The console's Settings page is the only editing surface. Secrets stay in
 * .env, and the bootstrap values needed before the database can be opened
 * (NUDGE_DATA_DIR, PORT, LOG_LEVEL) come from the environment — see config.ts.
 */
export const settingsSchema = z.object({
  // Empty until the owner sets it in the console; the server refuses to start
  // without it (config.ts) so it can point at the Settings page.
  owner_handle: z.string().default(""),
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
          fallback_enabled: z.boolean().default(false),
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
  threads: z
    .object({
      idle_hours: z.number().min(0.1).max(168).default(6),
      debounce_ms: z.number().int().min(0).max(30_000).default(2_500),
    })
    .prefault({}),
  agent: z
    .object({
      max_tool_steps: z.number().int().min(1).max(2000).default(256),
      max_history_messages: z.number().int().min(4).max(400).default(40),
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

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** Effective settings from stored overrides. Throws when an override no longer fits the schema. */
export function settingsFromOverrides(overrides: Record<string, unknown>): Settings {
  const parsed = settingsSchema.safeParse(unflatten(overrides));
  if (!parsed.success) {
    throw new Error(
      `Invalid settings: ${formatIssues(parsed.error)}. Fix them on the console's Settings page.`,
    );
  }
  return parsed.data;
}

/** The leaves where a validated settings object differs from the defaults — all that gets stored. */
export function overridesFromSettings(settings: Settings): Record<string, unknown> {
  const values = flatten(settings);
  const defaults = flatten(defaultSettings());
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (JSON.stringify(value) !== JSON.stringify(defaults[key])) overrides[key] = value;
  }
  return overrides;
}

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out[prefix] = value;
  return out;
}

function unflatten(overrides: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      node =
        next !== null && typeof next === "object"
          ? (next as Record<string, unknown>)
          : ((node[part] = {}) as Record<string, unknown>);
    }
    node[parts.at(-1) ?? path] = value;
  }
  return root;
}

// --- Console form spec ------------------------------------------------------
//
// The Settings page renders straight from this: one control per schema leaf,
// grouped into sections. Kept next to the schema so the two cannot drift — a
// test asserts every leaf has exactly one field.

export interface SettingsField {
  /** Dotted schema path; doubles as the form's field key and error anchor. */
  path: string;
  label: string;
  help?: string;
  control: "text" | "number" | "boolean" | "select";
  options?: string[];
  /** Empty input clears the override so the schema default applies. */
  optional?: boolean;
  placeholder?: string;
}

export interface SettingsSection {
  title: string;
  description?: string;
  fields: SettingsField[];
}

export const SETTINGS_FORM: SettingsSection[] = [
  {
    title: "Owner",
    fields: [
      {
        path: "owner_handle",
        label: "Owner handle",
        control: "text",
        placeholder: "+15551234567",
        help: "The one handle allowed to talk to Nudge — the exact sender.id Photon sends.",
      },
      {
        path: "timezone",
        label: "Timezone",
        control: "text",
        optional: true,
        placeholder: "machine timezone",
        help: "IANA timezone (like America/Los_Angeles) for schedules and midnight thread rollover. Empty follows the machine's timezone.",
      },
    ],
  },
  {
    title: "Provider",
    fields: [
      {
        path: "provider.selected",
        label: "Provider",
        control: "select",
        options: ["chatgpt-subscription", "openai-api"],
        help: "chatgpt-subscription signs in on the Connections page; openai-api needs OPENAI_API_KEY in Secrets.",
      },
      { path: "provider.chatgpt.model", label: "ChatGPT model", control: "text" },
      {
        path: "provider.chatgpt.auth_file",
        label: "ChatGPT auth file",
        control: "text",
        help: "Where the subscription sign-in from the Connections page is stored.",
      },
      { path: "provider.openai.model", label: "OpenAI API model", control: "text" },
      {
        path: "provider.openai.fallback_enabled",
        label: "API-credit fallback",
        control: "boolean",
        help: "Answer with the OpenAI API when subscription auth fails. Needs OPENAI_API_KEY in Secrets and can spend API credits.",
      },
    ],
  },
  {
    title: "Model",
    fields: [
      {
        path: "model.reasoning_effort",
        label: "Reasoning effort",
        control: "select",
        optional: true,
        options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        help: "Reasoning level for model calls. Empty uses the model's default.",
      },
      {
        path: "model.fast_mode",
        label: "Fast mode",
        control: "boolean",
        help: "Route model calls through the priority service tier (faster output).",
      },
    ],
  },
  {
    title: "Tools",
    fields: [
      {
        path: "tools.bash_enabled",
        label: "Bash tool",
        control: "boolean",
        help: "Runs shell commands with the data directory as the working directory (a default, not a sandbox). Off removes the tool entirely.",
      },
      {
        path: "tools.firecrawl_url",
        label: "Firecrawl URL",
        control: "text",
        optional: true,
        placeholder: "http://localhost:3002",
        help: "Self-hosted Firecrawl for web_search and web_extract (no key needed). Firecrawl cloud instead needs FIRECRAWL_API_KEY in Secrets; the tools are hidden from the model when neither is set.",
      },
    ],
  },
  {
    title: "Google",
    description:
      "Google accounts are connected on the Connections page; credentials live under the data directory, never in settings.",
    fields: [
      {
        path: "google.default_account",
        label: "Default account",
        control: "text",
        optional: true,
        help: "Account label used by bare gws calls when several accounts are connected.",
      },
      {
        path: "google.gws_path",
        label: "gws binary",
        control: "text",
        optional: true,
        placeholder: "auto-detected",
        help: "Full path to a custom gws binary.",
      },
    ],
  },
  {
    title: "Threads",
    fields: [
      {
        path: "threads.idle_hours",
        label: "Idle rollover (hours)",
        control: "number",
        help: "Threads roll over silently after this many idle hours (and at local midnight).",
      },
      {
        path: "threads.debounce_ms",
        label: "Debounce (ms)",
        control: "number",
        help: "How long to wait for follow-up texts before replying to a burst as one message.",
      },
    ],
  },
  {
    title: "Agent",
    fields: [
      {
        path: "agent.max_tool_steps",
        label: "Max tool steps",
        control: "number",
        help: "Backstop against runaway tool loops, not a per-task budget — set it well above any real task.",
      },
      {
        path: "agent.max_history_messages",
        label: "History before compaction",
        control: "number",
        help: "Messages kept verbatim in context before older turns are compacted into a summary.",
      },
    ],
  },
];
