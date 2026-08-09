import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createModelSources, DATA_README, NudgeAgent, syncBundledContent } from "@nudge/agent";
import { createPhotonTransport } from "@nudge/photon";
import { NudgeStore } from "@nudge/store";
import { loadConfig } from "./config.js";
import { DeliveryService } from "./delivery.js";
import { loadWorkspaceEnvironment } from "./env.js";
import { createHttpApp } from "./http.js";
import { createLogger } from "./logger.js";
import { Scheduler } from "./scheduler.js";
import { createSystemFileReader } from "./system-file.js";

const APOLOGY = "Sorry — something went wrong on my end. Mind sending that again?";

function ensureDataReadme(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "README.md");
  if (!existsSync(path) || readFileSync(path, "utf8") !== DATA_README) {
    writeFileSync(path, DATA_README);
  }
}

async function main(): Promise<void> {
  loadWorkspaceEnvironment();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  ensureDataReadme(config.dataDir);
  syncBundledContent({ dataDir: config.dataDir, logger });
  const store = new NudgeStore(config.dbPath);
  const sources = createModelSources(config.provider);
  const agent = new NudgeAgent({
    sources,
    store,
    logger,
    timeZone: config.timeZone,
    dataDir: config.dataDir,
    systemFile: createSystemFileReader(config.systemFilePath, logger),
    idleRolloverMs: config.idleRolloverMs,
    compactAfterMessages: config.maxHistoryMessages,
    maxToolSteps: config.maxToolSteps,
    ...(config.firecrawl ? { web: config.firecrawl } : {}),
    bashEnabled: config.bashEnabled,
  });

  const transport = await createPhotonTransport({
    ...config.spectrum,
    ownerHandle: config.ownerHandle,
    debounceMs: config.debounceMs,
    logLevel: config.logLevel,
    logger,
    isDuplicate: (messageId) => store.isWebhookProcessed(messageId),
    rememberSpace: (handle, spaceId, platform) => store.rememberSpace(handle, spaceId, platform),
    onBatch: async (batch, send) => {
      try {
        const reply = await agent.reply(batch.handle, batch.texts.join("\n"));
        if (reply) {
          const ledgerId = store.enqueueOutbound(batch.handle, reply, "reply");
          store.markOutbound(ledgerId, "sending");
          await send(reply);
          store.markOutbound(ledgerId, "sent");
        }
      } catch (error) {
        logger.error("Reply generation failed", {
          messageIds: batch.messageIds,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await send(APOLOGY);
        } catch {
          logger.error("Even the apology failed to send", { messageIds: batch.messageIds });
        }
      } finally {
        for (const messageId of batch.messageIds) {
          store.markWebhookProcessed(messageId);
        }
      }
    },
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

  const server = createServer(createHttpApp(transport, logger));
  server.listen(config.port, () => {
    logger.info("Nudge is listening", {
      port: config.port,
      sources: sources.map((source) => source.id),
      webhookPath: "/webhooks/photon",
      timeZone: config.timeZone,
    });
  });

  // Redeliver anything the last process died holding, then start the clock.
  await delivery.recover();
  scheduler.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
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
