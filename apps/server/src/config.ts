import { join } from "node:path";
import { z } from "zod";
import { formatIssues, loadSettings, type Settings } from "./config-file.js";
import { resolveFromWorkspace } from "./paths.js";

export {
  CONFIG_FILE,
  ensureSettingsFile,
  loadSettings,
  parseSettings,
  seedText,
  type EnsureResult,
  type Settings,
} from "./config-file.js";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const secretsSchema = z.object({
  SPECTRUM_PROJECT_ID: z.string().min(1),
  SPECTRUM_PROJECT_SECRET: z.string().min(1),
  SPECTRUM_WEBHOOK_SECRET: z.string().min(1),
  OPENAI_API_KEY: optionalSecret,
  FIRECRAWL_API_KEY: optionalSecret,
  // Not a secret: per-process override of server.port so multiple checkouts
  // (e.g. Conductor's PORT=$CONDUCTOR_PORT run script) can share one config.
  PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65_535).optional(),
  ),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  settings: Settings = loadSettings(),
) {
  const parsed = secretsSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid .env: ${formatIssues(parsed.error)}`);
  }
  const secrets = parsed.data;
  const dataDir = resolveFromWorkspace(settings.data_dir);
  return {
    ownerHandle: settings.owner_handle,
    spectrum: {
      projectId: secrets.SPECTRUM_PROJECT_ID,
      projectSecret: secrets.SPECTRUM_PROJECT_SECRET,
      webhookSecret: secrets.SPECTRUM_WEBHOOK_SECRET,
    },
    provider: {
      selected: settings.provider.selected,
      chatGptModel: settings.provider.chatgpt.model,
      chatGptAuthFile: resolveFromWorkspace(settings.provider.chatgpt.auth_file),
      ...(secrets.OPENAI_API_KEY ? { openAiApiKey: secrets.OPENAI_API_KEY } : {}),
      openAiModel: settings.provider.openai.model,
      openAiFallbackEnabled: settings.provider.openai.fallback_enabled,
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
      ...(settings.model.fast_mode ? { serviceTier: "priority" as const } : {}),
    },
    dataDir,
    dbPath: join(dataDir, "nudge.db"),
    systemFilePath: join(dataDir, "SYSTEM.md"),
    schedulePath: join(dataDir, "SCHEDULE.md"),
    timeZone: settings.timezone,
    idleRolloverMs: Math.round(settings.threads.idle_hours * 60 * 60 * 1000),
    debounceMs: settings.threads.debounce_ms,
    maxToolSteps: settings.agent.max_tool_steps,
    maxHistoryMessages: settings.agent.max_history_messages,
    port: secrets.PORT ?? settings.server.port,
    logLevel: settings.server.log_level,
  };
}
