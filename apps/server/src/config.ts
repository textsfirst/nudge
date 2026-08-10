import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYamlDocument } from "yaml";
import { z } from "zod";
import { resolveFromWorkspace } from "./paths.js";

export const CONFIG_FILE = "nudge.config.yaml";

const settingsSchema = z.object({
  owner_handle: z.string().min(1),
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

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

export type Settings = z.infer<typeof settingsSchema>;

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

export function loadSettings(path = resolveFromWorkspace(CONFIG_FILE)): Settings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Missing ${CONFIG_FILE} — copy nudge.config.example.yaml to ${CONFIG_FILE} and edit it.`,
    );
  }
  return parseSettings(raw);
}

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
