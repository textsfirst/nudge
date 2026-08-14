import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  buildImageCaptioner,
  ChatGptAuthManager,
  createModelSources,
  GrokAuthManager,
  DATA_README,
  listEnabledMcpServers,
  MediaIngest,
  NudgeAgent,
  supportsVision,
  syncBundledContent,
  TranscriptionClient,
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
import { buildMcpBashEnv } from "./mcp/env.js";
import { buildSkillsBashEnv } from "./skills/env.js";
import { seedMcpSkill } from "./mcp/skill.js";
import { createReplyHandler } from "./reply.js";
import { buildCheckRunner, Scheduler } from "./scheduler.js";
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
  const providerHealth: ProviderHealth = { ok: true, error: null };
  const subscriptionAuth =
    config.provider.selected === "chatgpt-subscription"
      ? new ChatGptAuthManager({ authFile: config.provider.chatGptAuthFile })
      : config.provider.selected === "grok-subscription"
        ? new GrokAuthManager({
            authFile: config.provider.grokAuthFile,
            ...(config.provider.grokClientVersion
              ? { clientVersion: config.provider.grokClientVersion }
              : {}),
          })
        : undefined;
  if (subscriptionAuth) {
    try {
      await subscriptionAuth.credentials();
    } catch (error) {
      providerHealth.ok = false;
      providerHealth.error = error instanceof Error ? error.message : String(error);
      logger.error("Subscription auth failed; messages cannot be answered until it is fixed", {
        provider: config.provider.selected,
        error: providerHealth.error,
      });
    }
  }
  const sources = createModelSources(config.provider);
  // Shared by the agent's bash tool and the scheduler's watcher checks, so a
  // check: command sees the same gws/mcp/skills CLIs and secrets the agent does.
  const bashEnv = {
    ...buildGwsBashEnv({
      dataDir: config.dataDir,
      defaultAccount: config.google.defaultAccount,
      gwsPath: config.google.gwsPath,
    }),
    ...buildMcpBashEnv({ dataDir: config.dataDir }),
    ...buildSkillsBashEnv({ dataDir: config.dataDir }),
  };
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
    multimodal: {
      vision: config.multimodal.enabled ? config.multimodal.vision : "off",
      maxImagesPerPrompt: config.multimodal.maxImagesPerPrompt,
    },
    ...(config.firecrawl ? { web: config.firecrawl } : {}),
    bashEnabled: config.bashEnabled,
    bashEnv,
    googleAccounts: () =>
      readGoogleAccounts(config.dataDir).map(({ label, email }) => ({ label, email })),
    mcpServers: () => {
      const servers = listEnabledMcpServers(config.dataDir);
      // Seed on first sight (write-if-missing), so a registry the agent
      // creates mid-thread gets its skill without a restart. A failed write
      // must not hide the servers from the prompt.
      if (servers.length > 0) {
        try {
          seedMcpSkill(config.dataDir);
        } catch (error) {
          logger.warn("Could not seed the mcp skill", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return servers;
    },
    modelOptions: config.modelOptions,
  });

  // Captions need a vision-capable path: the effective flag mirrors the
  // agent's own auto/on/off resolution over the same sources.
  const visionEnabled =
    config.multimodal.enabled &&
    (config.multimodal.vision === "on" ||
      (config.multimodal.vision === "auto" &&
        sources.every((source) => supportsVision(source.modelId))));
  const mediaIngest = config.multimodal.enabled
    ? new MediaIngest({
        store,
        dataDir: config.dataDir,
        logger,
        maxAttachmentBytes: config.multimodal.maxAttachmentBytes,
        ...(config.multimodal.transcription
          ? { transcription: new TranscriptionClient(config.multimodal.transcription) }
          : {}),
        ...(visionEnabled
          ? {
              caption: buildImageCaptioner({
                sources,
                ...(config.multimodal.captionModel
                  ? { model: config.multimodal.captionModel }
                  : {}),
                logger,
              }),
            }
          : {}),
        ...(config.multimodal.ffmpegPath ? { ffmpegPath: config.multimodal.ffmpegPath } : {}),
      })
    : undefined;

  const transport = await createPhotonTransport({
    ...config.spectrum,
    ownerHandle: config.ownerHandle,
    debounceMs: config.debounceMs,
    readReceipts: config.texting.readReceipts,
    typingDelayMs: config.texting.typingDelayMs,
    chunkDelayMs: config.texting.chunkDelayMs,
    logLevel: config.logLevel,
    logger,
    isDuplicate: (messageId) => store.isWebhookProcessed(messageId),
    rememberSpace: (handle, spaceId, platform) => store.rememberSpace(handle, spaceId, platform),
    onBatch: createReplyHandler({
      agent,
      store,
      logger,
      ...(mediaIngest ? { media: mediaIngest } : {}),
    }),
  });

  const delivery = new DeliveryService(store, transport, logger);
  // Execution-agent reports run a fresh interaction turn whose reply, when
  // not [SILENT], reaches the owner through the ledger like any nudge.
  agent.setReportDelivery(async (handle, text) => {
    await delivery.deliver(handle, text, "nudge");
  });
  const scheduler = new Scheduler({
    schedulePath: config.schedulePath,
    ownerHandle: config.ownerHandle,
    timeZone: config.timeZone,
    store,
    agent,
    delivery,
    logger,
    runCheck: buildCheckRunner({ cwd: config.dataDir, env: bashEnv }),
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
      ...(config.provider.selected === "grok-subscription"
        ? { grokAuthFile: config.provider.grokAuthFile }
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
