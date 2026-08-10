import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  ChatGptAuthManager,
  createModelSources,
  DATA_README,
  NudgeAgent,
  syncBundledContent,
} from "@nudge/agent";
import { createPhotonTransport } from "@nudge/photon";
import { NudgeStore } from "@nudge/store";
import { loadBootstrap, loadConfig, settingsFromOverrides } from "./config.js";
import { DeliveryService } from "./delivery.js";
import { loadWorkspaceEnvironment } from "./env.js";
import { buildGwsBashEnv, readGoogleAccounts } from "./google.js";
import { buildConnectionProbes, ConnectionHealthMonitor } from "./health.js";
import { createHttpApp } from "./http.js";
import type { ProviderHealth } from "./http.js";
import { createLogger } from "./logger.js";
import { createReplyHandler } from "./reply.js";
import { Scheduler } from "./scheduler.js";
import { createSystemFileReader } from "./system-file.js";

function ensureDataReadme(dataDir: string, logger: ReturnType<typeof createLogger>): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "README.md");
  if (!existsSync(path)) {
    writeFileSync(path, DATA_README);
    return;
  }
  if (readFileSync(path, "utf8") !== DATA_README) {
    logger.warn("Refreshing the system-managed data README; local edits are not preserved", {
      path,
    });
    writeFileSync(path, DATA_README);
  }
}

async function main(): Promise<void> {
  loadWorkspaceEnvironment();
  const boot = loadBootstrap();
  const logger = createLogger(boot.logLevel);
  const store = new NudgeStore(boot.dbPath);
  const settings = settingsFromOverrides(store.settingsOverrides());
  if (!settings.owner_handle) {
    throw new Error(
      "owner_handle is not set — open the console's Settings page, set your handle, then start again.",
    );
  }
  const config = loadConfig(process.env, settings, boot);
  ensureDataReadme(config.dataDir, logger);
  syncBundledContent({ dataDir: config.dataDir, logger });
  const providerHealth: ProviderHealth = { ok: true, degraded: false, error: null };
  if (config.provider.selected === "chatgpt-subscription") {
    const fallbackEnabled = Boolean(
      config.provider.openAiFallbackEnabled && config.provider.openAiApiKey,
    );
    if (fallbackEnabled) {
      logger.warn("OpenAI API fallback is enabled; subscription auth failures may use API credits");
    }
    try {
      await new ChatGptAuthManager({
        authFile: config.provider.chatGptAuthFile,
      }).credentials();
    } catch (error) {
      providerHealth.ok = fallbackEnabled;
      providerHealth.degraded = fallbackEnabled;
      providerHealth.error = error instanceof Error ? error.message : String(error);
      logger.error(
        fallbackEnabled
          ? "ChatGPT subscription auth failed; API fallback will be used"
          : "ChatGPT subscription auth failed; messages cannot be answered until it is fixed",
        { error: providerHealth.error },
      );
    }
  }
  const sources = createModelSources(config.provider);
  const agent = new NudgeAgent({
    sources,
    store,
    logger,
    timeZone: config.timeZone,
    dataDir: config.dataDir,
    systemFile: createSystemFileReader(config.systemFilePath, logger),
    idleRolloverMs: config.idleRolloverMs,
    compaction: {
      contextWindowTokens: config.contextWindowTokens,
      compactAtFraction: config.compactAtPercent / 100,
      keepRecentTokens: config.keepRecentTokens,
    },
    summarizer: {
      model: config.compactionModel,
      modelOptions: config.compactionModelOptions,
    },
    maxToolSteps: config.maxToolSteps,
    ...(config.firecrawl ? { web: config.firecrawl } : {}),
    bashEnabled: config.bashEnabled,
    bashEnv: buildGwsBashEnv({
      dataDir: config.dataDir,
      defaultAccount: config.google.defaultAccount,
      gwsPath: config.google.gwsPath,
    }),
    googleAccounts: () =>
      readGoogleAccounts(config.dataDir).map(({ label, email }) => ({ label, email })),
    modelOptions: config.modelOptions,
  });

  const transport = await createPhotonTransport({
    ...config.spectrum,
    ownerHandle: config.ownerHandle,
    debounceMs: config.debounceMs,
    logLevel: config.logLevel,
    logger,
    isDuplicate: (messageId) => store.isWebhookProcessed(messageId),
    rememberSpace: (handle, spaceId, platform) => store.rememberSpace(handle, spaceId, platform),
    onBatch: createReplyHandler({ agent, store, logger }),
  });

  const delivery = new DeliveryService(store, transport, logger);
  const scheduler = new Scheduler({
    schedulePath: config.schedulePath,
    ownerHandle: config.ownerHandle,
    timeZone: config.timeZone,
    store,
    agent,
    delivery,
    logger,
  });

  const server = createServer(createHttpApp(transport, logger, providerHealth));
  server.listen(config.port, () => {
    logger.info("Nudge is listening", {
      port: config.port,
      sources: sources.map((source) => source.id),
      webhookPath: "/webhooks/photon",
      timeZone: config.timeZone,
      providerHealth,
    });
  });

  const health = new ConnectionHealthMonitor({
    store,
    delivery,
    ownerHandle: config.ownerHandle,
    logger,
    probes: buildConnectionProbes({
      dataDir: config.dataDir,
      ...(config.provider.selected === "chatgpt-subscription"
        ? { chatGptAuthFile: config.provider.chatGptAuthFile }
        : {}),
    }),
  });

  // Redeliver anything the last process died holding, then start the clocks.
  await delivery.recover();
  scheduler.start();
  health.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    health.stop();
    scheduler.stop();
    server.close();
    await transport.stop();
    store.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Nudge failed to start",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
