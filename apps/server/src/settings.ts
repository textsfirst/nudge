import { z } from "zod";

/**
 * Settings live in the SQLite database as explicit overrides (dotted schema
 * paths mapped to JSON values); everything unset falls back to the defaults
 * below at read time, so new settings appear automatically after an upgrade.
 * The console's Settings page is the only editing surface. Secrets stay in
 * .env, and the bootstrap values needed before the database can be opened
 * (NUDGE_DATA_DIR, PORT, LOG_LEVEL) come from the environment — see config.ts.
 */
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
      selected: z
        .enum(["chatgpt-subscription", "openai-api", "custom"])
        .default("chatgpt-subscription"),
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
      custom: z
        .object({
          base_url: z.url().optional(),
          model: z.string().min(1).optional(),
          api: z.enum(["chat-completions", "responses"]).default("chat-completions"),
        })
        .prefault({}),
    })
    .prefault({}),
  model: z
    .object({
      reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
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
      debounce_ms: z.number().int().min(0).max(30_000).default(250),
    })
    .prefault({}),
  texting: z
    .object({
      read_receipts: z.boolean().default(true),
      typing_delay_ms: z.number().int().min(0).max(10_000).default(1100),
      chunk_delay_ms: z.number().int().min(0).max(5_000).default(500),
    })
    .prefault({}),
  multimodal: z
    .object({
      // Off restores the old behavior: inbound media is ignored entirely.
      enabled: z.boolean().default(true),
      // auto consults the model-id registry; on forces image parts for custom
      // endpoints serving vision models the registry doesn't know.
      vision: z.enum(["auto", "on", "off"]).default("auto"),
      max_attachment_mb: z.number().min(1).max(64).default(8),
      max_images_per_prompt: z.number().int().min(1).max(20).default(6),
      transcription_enabled: z.boolean().default(true),
      transcription_model: z.string().min(1).default("whisper-1"),
      transcription_base_url: z.url().optional(),
      // Empty falls back to the reply model.
      caption_model: z.string().min(1).optional(),
      ffmpeg_path: z.string().min(1).optional(),
    })
    .prefault({}),
  agent: z
    .object({
      max_tool_steps: z.number().int().min(1).max(2000).default(256),
      // Compaction budget: 0 auto-detects the window from the model id.
      context_window_tokens: z.number().int().min(0).max(2_000_000).default(0),
      compact_at_percent: z.number().min(20).max(95).default(80),
      keep_recent_tokens: z.number().int().min(1_000).max(100_000).default(20_000),
      // The dedicated summarizer: same provider and auth as replies, its own model.
      compaction_model: z.string().min(1).default("gpt-5.6-luna"),
      compaction_reasoning_effort: z.enum(REASONING_EFFORTS).default("high"),
      compaction_fast_mode: z.boolean().default(true),
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
        options: ["chatgpt-subscription", "openai-api", "custom"],
        help: "chatgpt-subscription signs in on the Connections page; openai-api needs OPENAI_API_KEY in Secrets; custom talks to any OpenAI-compatible endpoint configured below.",
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
      {
        path: "provider.custom.base_url",
        label: "Custom base URL",
        control: "text",
        optional: true,
        placeholder: "http://localhost:11434/v1",
        help: "Base URL of an OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, a proxy). If it needs a key, set CUSTOM_API_KEY in Secrets.",
      },
      {
        path: "provider.custom.model",
        label: "Custom model",
        control: "text",
        optional: true,
        placeholder: "llama3.3:70b",
        help: "Model id the endpoint expects. For unrecognized models, set the Agent section's context window explicitly.",
      },
      {
        path: "provider.custom.api",
        label: "Custom API flavor",
        control: "select",
        options: ["chat-completions", "responses"],
        help: "Which OpenAI API the endpoint implements. Most compatible servers only support chat-completions.",
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
        options: [...REASONING_EFFORTS],
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
        help: "Short coalescing window for near-simultaneous deliveries. Later texts steer the active reply.",
      },
    ],
  },
  {
    title: "Texting feel",
    description:
      "Choreography of read receipts, the typing indicator, and bubble pacing — perception only; generation speed is unaffected.",
    fields: [
      {
        path: "texting.read_receipts",
        label: "Read receipts",
        control: "boolean",
        help: "Mark the owner's texts read a moment after they arrive, so \"seen\" precedes \"typing\".",
      },
      {
        path: "texting.typing_delay_ms",
        label: "Typing delay (ms)",
        control: "number",
        help: "Pause (jittered) before the typing indicator appears — a human takes a beat to see a text. 0 shows it instantly.",
      },
      {
        path: "texting.chunk_delay_ms",
        label: "Bubble gap (ms)",
        control: "number",
        help: "Base pause between the bubbles of a multi-bubble reply; each gap grows with the next bubble's length. 0 sends bubbles back-to-back.",
      },
    ],
  },
  {
    title: "Multimodal",
    description:
      "Photos and voice memos the owner sends. Voice memos are transcribed via an OpenAI-compatible speech-to-text API (needs ffmpeg for iMessage's CAF format). Nudge never sends voice messages.",
    fields: [
      {
        path: "multimodal.enabled",
        label: "Multimodal",
        control: "boolean",
        help: "Ingest photos, voice memos, and files the owner sends. Off ignores them entirely, like before.",
      },
      {
        path: "multimodal.vision",
        label: "Vision",
        control: "select",
        options: ["auto", "on", "off"],
        help: "Whether recent photos are shown to the reply model as images. auto detects support from the model id; on forces it for custom endpoints; off keeps prompts text-only (captions still describe the photos).",
      },
      {
        path: "multimodal.max_attachment_mb",
        label: "Max attachment (MB)",
        control: "number",
        help: "Larger attachments are noted in the thread but not stored.",
      },
      {
        path: "multimodal.max_images_per_prompt",
        label: "Max images per prompt",
        control: "number",
        help: "Newest photos beyond this stay in the thread as text descriptions only.",
      },
      {
        path: "multimodal.transcription_enabled",
        label: "Voice transcription",
        control: "boolean",
        help: "Transcribe the owner's voice memos so the agent can read them. Needs TRANSCRIPTION_API_KEY (or OPENAI_API_KEY) in Secrets.",
      },
      {
        path: "multimodal.transcription_model",
        label: "Transcription model",
        control: "text",
        help: "Speech-to-text model id at the transcription endpoint.",
      },
      {
        path: "multimodal.transcription_base_url",
        label: "Transcription base URL",
        control: "text",
        optional: true,
        placeholder: "https://api.openai.com/v1",
        help: "OpenAI-compatible API root for /audio/transcriptions. Empty uses OpenAI.",
      },
      {
        path: "multimodal.caption_model",
        label: "Caption model",
        control: "text",
        optional: true,
        placeholder: "reply model",
        help: "Vision model that writes the one-line photo descriptions kept in the thread. Empty uses the reply model.",
      },
      {
        path: "multimodal.ffmpeg_path",
        label: "ffmpeg binary",
        control: "text",
        optional: true,
        placeholder: "ffmpeg on PATH",
        help: "Full path to ffmpeg, used to convert voice memos for transcription (and HEIC photos where sips is unavailable).",
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
        path: "agent.context_window_tokens",
        label: "Context window (tokens)",
        control: "number",
        help: "Model context window the compaction budget is computed from. 0 auto-detects from the model id.",
      },
      {
        path: "agent.compact_at_percent",
        label: "Compact at (%)",
        control: "number",
        help: "Older turns fold into the thread summary when the estimated context reaches this share of the usable window.",
      },
      {
        path: "agent.keep_recent_tokens",
        label: "Recent tokens kept",
        control: "number",
        help: "How much recent conversation stays verbatim when older turns are compacted.",
      },
      {
        path: "agent.compaction_model",
        label: "Compaction model",
        control: "text",
        help: "Model that writes compaction and carryover summaries, on the same provider and auth as replies. For the custom provider, pick a model the endpoint serves.",
      },
      {
        path: "agent.compaction_reasoning_effort",
        label: "Compaction reasoning effort",
        control: "select",
        options: [...REASONING_EFFORTS],
        help: "Reasoning level for summary calls — high keeps folds faithful.",
      },
      {
        path: "agent.compaction_fast_mode",
        label: "Compaction fast mode",
        control: "boolean",
        help: "Run summary calls on the priority service tier so folds don't delay replies.",
      },
    ],
  },
];
