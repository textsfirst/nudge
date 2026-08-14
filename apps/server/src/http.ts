import express, { type Express } from "express";
import type { Logger } from "@nudge/agent";
import type { PhotonTransport } from "@nudge/photon";

export interface ProviderHealth {
  ok: boolean;
  error: string | null;
}

export function createHttpApp(
  transport: PhotonTransport,
  logger: Logger,
  providerHealth: ProviderHealth = { ok: true, error: null },
): Express {
  const app = express();

  app.get("/healthz", (_request, response) => {
    response.status(providerHealth.ok ? 200 : 503).json({
      ok: providerHealth.ok,
      provider: providerHealth,
    });
  });

  app.post(
    "/webhooks/photon",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (request, response) => {
      try {
        if (!Buffer.isBuffer(request.body)) {
          response.status(400).send("expected raw request body");
          return;
        }
        const result = await transport.webhook({
          body: request.body,
          headers: request.headers,
        });
        response.status(result.status).set(result.headers).send(Buffer.from(result.body));
      } catch (error) {
        logger.error("Photon webhook handling failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        response.status(500).send("webhook failed");
      }
    },
  );

  return app;
}
