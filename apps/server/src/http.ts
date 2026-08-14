import express, { type Express } from "express";

export interface ProviderHealth {
  ok: boolean;
  degraded: boolean;
  error: string | null;
}

/**
 * The server's only HTTP surface: a liveness probe. Inbound messages arrive
 * over the Photon transport's outbound gRPC stream, not HTTP.
 */
export function createHttpApp(
  providerHealth: ProviderHealth = { ok: true, degraded: false, error: null },
): Express {
  const app = express();

  app.get("/healthz", (_request, response) => {
    response.status(providerHealth.ok ? 200 : 503).json({
      ok: providerHealth.ok,
      provider: providerHealth,
    });
  });

  return app;
}
