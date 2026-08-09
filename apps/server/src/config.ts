import { join } from "node:path";
import { z } from "zod";
import { resolveFromWorkspace } from "./paths.js";

const booleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  OWNER_IMESSAGE_HANDLE: z.string().min(1),
  SPECTRUM_PROJECT_ID: z.string().min(1),
  SPECTRUM_PROJECT_SECRET: z.string().min(1),
  SPECTRUM_WEBHOOK_SECRET: z.string().min(1),
  MODEL_PROVIDER: z
    .enum(["chatgpt-subscription", "openai-api"])
    .default("chatgpt-subscription"),
  CHATGPT_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  CHATGPT_AUTH_FILE: z.string().min(1).default(".data/chatgpt-auth.json"),
  OPENAI_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  OPENAI_FALLBACK_ENABLED: booleanString,
  BASH_TOOL_ENABLED: booleanString,
  FIRECRAWL_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  FIRECRAWL_API_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().optional(),
  ),
  DATA_DIR: z.string().min(1).default(".data"),
  OWNER_TIMEZONE: z
    .string()
    .min(1)
    .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    .refine(isValidTimeZone, { message: "must be an IANA timezone like America/Los_Angeles" }),
  IDLE_THREAD_HOURS: z.coerce.number().min(0.1).max(168).default(6),
  DEBOUNCE_MS: z.coerce.number().int().min(0).max(30_000).default(2_500),
  MAX_TOOL_STEPS: z.coerce.number().int().min(1).max(32).default(8),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(4).max(400).default(40),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  const env = parsed.data;
  const dataDir = resolveFromWorkspace(env.DATA_DIR);
  return {
    ownerHandle: env.OWNER_IMESSAGE_HANDLE,
    spectrum: {
      projectId: env.SPECTRUM_PROJECT_ID,
      projectSecret: env.SPECTRUM_PROJECT_SECRET,
      webhookSecret: env.SPECTRUM_WEBHOOK_SECRET,
    },
    provider: {
      selected: env.MODEL_PROVIDER,
      chatGptModel: env.CHATGPT_MODEL,
      chatGptAuthFile: resolveFromWorkspace(env.CHATGPT_AUTH_FILE),
      ...(env.OPENAI_API_KEY ? { openAiApiKey: env.OPENAI_API_KEY } : {}),
      openAiModel: env.OPENAI_MODEL,
      openAiFallbackEnabled: env.OPENAI_FALLBACK_ENABLED,
    },
    ...(env.FIRECRAWL_API_KEY || env.FIRECRAWL_API_URL
      ? {
          firecrawl: {
            ...(env.FIRECRAWL_API_KEY ? { apiKey: env.FIRECRAWL_API_KEY } : {}),
            ...(env.FIRECRAWL_API_URL ? { apiUrl: env.FIRECRAWL_API_URL } : {}),
          },
        }
      : {}),
    bashEnabled: env.BASH_TOOL_ENABLED,
    dataDir,
    dbPath: join(dataDir, "nudge.db"),
    systemFilePath: join(dataDir, "SYSTEM.md"),
    schedulePath: join(dataDir, "SCHEDULE.md"),
    timeZone: env.OWNER_TIMEZONE,
    idleRolloverMs: Math.round(env.IDLE_THREAD_HOURS * 60 * 60 * 1000),
    debounceMs: env.DEBOUNCE_MS,
    maxToolSteps: env.MAX_TOOL_STEPS,
    maxHistoryMessages: env.MAX_HISTORY_MESSAGES,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
  };
}
