import { join, resolve } from "node:path";
import { z } from "zod";
import { findWorkspaceRoot, resolveFromWorkspace } from "./paths.js";
import { formatIssues, type Settings } from "./settings.js";

export {
  defaultSettings,
  formatIssues,
  overridesFromSettings,
  SETTINGS_FORM,
  settingsFromOverrides,
  settingsSchema,
  type Settings,
  type SettingsField,
  type SettingsSection,
} from "./settings.js";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

/** Single source of truth for secret validation, console display, and docs tests. */
export const SECRET_SPECS = [
  {
    key: "SPECTRUM_PROJECT_ID",
    required: true,
    description: "Photon Cloud project id (app.photon.codes)",
  },
  {
    key: "SPECTRUM_PROJECT_SECRET",
    required: true,
    description: "Photon Cloud project secret",
  },
  {
    key: "OPENAI_API_KEY",
    required: false,
    description: "OpenAI API key for the openai-api provider (transcription falls back to it too)",
  },
  {
    key: "CUSTOM_API_KEY",
    required: false,
    description: "API key for the custom provider endpoint (omit for keyless local servers)",
  },
  {
    key: "FIRECRAWL_API_KEY",
    required: false,
    description: "Enables the web_search / web_extract tools",
  },
  {
    key: "TRANSCRIPTION_API_KEY",
    required: false,
    description: "Speech-to-text API key for voice memos (falls back to OPENAI_API_KEY)",
  },
] as const;

type SecretValues = {
  [Spec in (typeof SECRET_SPECS)[number] as Spec["key"]]: Spec["required"] extends true
    ? string
    : string | undefined;
};

const secretShape = Object.fromEntries(
  SECRET_SPECS.map((spec) => [spec.key, spec.required ? z.string().min(1) : optionalSecret]),
);

const secretsSchema = z.object(secretShape);

/**
 * Compaction-summarizer defaults by provider, applied when
 * agent.compaction_model is unset; providers not listed fall back to the
 * reply model (no override reaches the agent).
 */
const COMPACTION_MODEL_DEFAULTS: Partial<Record<Settings["provider"]["selected"], string>> = {
  "chatgpt-subscription": "gpt-5.6-luna",
  // Luna is the public API's cost tier for exactly this kind of work.
  "openai-api": "gpt-5.6-luna",
  "grok-subscription": "grok-4.6",
};

const blankAsDefault = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

/**
 * The values needed before the settings database can be opened, so they live
 * in the environment (.env or the process) rather than in the database:
 * NUDGE_DATA_DIR locates it, PORT is where the server (and its health probe)
 * listens, and LOG_LEVEL applies from the first log line.
 */
const bootstrapSchema = z.object({
  NUDGE_DATA_DIR: blankAsDefault(z.string().default(".data")),
  PORT: blankAsDefault(z.coerce.number().int().min(1).max(65_535).default(3_000)),
  LOG_LEVEL: blankAsDefault(z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export interface Bootstrap {
  dataDir: string;
  dbPath: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  root = findWorkspaceRoot(),
): Bootstrap {
  const parsed = bootstrapSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid .env: ${formatIssues(parsed.error)}`);
  }
  const dataDir = resolve(root, parsed.data.NUDGE_DATA_DIR);
  return {
    dataDir,
    dbPath: join(dataDir, "nudge.db"),
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(
  environment: NodeJS.ProcessEnv,
  settings: Settings,
  boot: Bootstrap = loadBootstrap(environment),
) {
  const parsed = secretsSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid .env: ${formatIssues(parsed.error)}`);
  }
  const secrets = parsed.data as SecretValues;
  // Priority processing is an OpenAI API feature; the subscription backends
  // and custom endpoints have no service tiers, so fast mode is openai-api only.
  const priorityTierAvailable = settings.provider.selected === "openai-api";
  const compactionModel =
    settings.agent.compaction_model ?? COMPACTION_MODEL_DEFAULTS[settings.provider.selected];
  return {
    ownerHandle: settings.owner_handle,
    spectrum: {
      projectId: secrets.SPECTRUM_PROJECT_ID,
      projectSecret: secrets.SPECTRUM_PROJECT_SECRET,
    },
    provider: {
      selected: settings.provider.selected,
      chatGptModel: settings.provider.chatgpt.model,
      chatGptAuthFile: resolveFromWorkspace(settings.provider.chatgpt.auth_file),
      grokModel: settings.provider.grok.model,
      grokAuthFile: resolveFromWorkspace(settings.provider.grok.auth_file),
      ...(settings.provider.grok.client_version
        ? { grokClientVersion: settings.provider.grok.client_version }
        : {}),
      ...(secrets.OPENAI_API_KEY ? { openAiApiKey: secrets.OPENAI_API_KEY } : {}),
      openAiModel: settings.provider.openai.model,
      ...(settings.provider.custom.base_url
        ? { customBaseUrl: settings.provider.custom.base_url }
        : {}),
      ...(settings.provider.custom.model ? { customModel: settings.provider.custom.model } : {}),
      customApi: settings.provider.custom.api,
      ...(secrets.CUSTOM_API_KEY ? { customApiKey: secrets.CUSTOM_API_KEY } : {}),
    },
    ...(secrets.FIRECRAWL_API_KEY || settings.tools.firecrawl_url
      ? {
          firecrawl: {
            ...(secrets.FIRECRAWL_API_KEY ? { apiKey: secrets.FIRECRAWL_API_KEY } : {}),
            ...(settings.tools.firecrawl_url ? { apiUrl: settings.tools.firecrawl_url } : {}),
          },
        }
      : {}),
    bashEnabled: settings.tools.bash_enabled,
    google: {
      ...(settings.google.default_account
        ? { defaultAccount: settings.google.default_account }
        : {}),
      ...(settings.google.gws_path ? { gwsPath: settings.google.gws_path } : {}),
    },
    modelOptions: {
      ...(settings.model.reasoning_effort
        ? { reasoningEffort: settings.model.reasoning_effort }
        : {}),
      ...(settings.model.fast_mode && priorityTierAvailable
        ? { serviceTier: "priority" as const }
        : {}),
    },
    multimodal: {
      enabled: settings.multimodal.enabled,
      vision: settings.multimodal.vision,
      maxAttachmentBytes: Math.round(settings.multimodal.max_attachment_mb * 1024 * 1024),
      maxImagesPerPrompt: settings.multimodal.max_images_per_prompt,
      ...(settings.multimodal.transcription_enabled &&
      (secrets.TRANSCRIPTION_API_KEY || secrets.OPENAI_API_KEY)
        ? {
            transcription: {
              apiKey: (secrets.TRANSCRIPTION_API_KEY ?? secrets.OPENAI_API_KEY) as string,
              model: settings.multimodal.transcription_model,
              ...(settings.multimodal.transcription_base_url
                ? { baseUrl: settings.multimodal.transcription_base_url }
                : {}),
            },
          }
        : {}),
      ...(settings.multimodal.caption_model
        ? { captionModel: settings.multimodal.caption_model }
        : {}),
      ...(settings.multimodal.ffmpeg_path ? { ffmpegPath: settings.multimodal.ffmpeg_path } : {}),
    },
    ...(compactionModel ? { compactionModel } : {}),
    compactionModelOptions: {
      reasoningEffort: settings.agent.compaction_reasoning_effort,
      ...(settings.agent.compaction_fast_mode && priorityTierAvailable
        ? { serviceTier: "priority" as const }
        : {}),
    },
    dataDir: boot.dataDir,
    dbPath: boot.dbPath,
    systemFilePath: join(boot.dataDir, "SYSTEM.md"),
    schedulePath: join(boot.dataDir, "SCHEDULE.md"),
    timeZone: settings.timezone,
    idleRolloverMs: Math.round(settings.threads.idle_hours * 60 * 60 * 1000),
    debounceMs: settings.threads.debounce_ms,
    texting: {
      readReceipts: settings.texting.read_receipts,
      typingDelayMs: settings.texting.typing_delay_ms,
      chunkDelayMs: settings.texting.chunk_delay_ms,
    },
    maxToolSteps: settings.agent.max_tool_steps,
    contextWindowTokens: settings.agent.context_window_tokens,
    compactAtPercent: settings.agent.compact_at_percent,
    keepRecentTokens: settings.agent.keep_recent_tokens,
    port: boot.port,
    logLevel: boot.logLevel,
  };
}
