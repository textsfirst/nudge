import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runChatGptDeviceLogin } from "@nudge/agent";
import {
  exchangeGoogleCode,
  findGwsBinary,
  GOOGLE_SERVICES,
  googleAuthUrl,
  LABEL_PATTERN,
  newOAuthState,
  parseGoogleClientInput,
  probeGoogleAccount,
  readGoogleAccounts,
  readGoogleClient,
  removeGoogleAccount,
  saveGoogleAccount,
  saveGoogleClient,
  type GoogleAccountStatus,
} from "@nudge/server/google";
import type { ConsoleContext } from "./context.js";

/**
 * Connection management for the Connections page: the Google OAuth
 * authorization-code flow (console-owned, so consent works from any browser
 * that can reach the console — headless server included) and the ChatGPT
 * subscription device-code flow.
 *
 * Flow state is in-memory: a console restart mid-consent just means starting
 * the flow again, and nothing secret ever waits in the map.
 */

const STATE_TTL_MS = 15 * 60 * 1000;
export const GOOGLE_CALLBACK_PATH = "/api/connections/google/callback";

interface PendingGoogleFlow {
  label: string;
  redirectUri: string;
  createdAt: number;
}

export interface ChatGptFlow {
  status: "pending" | "done" | "error";
  verificationUrl: string;
  userCode: string;
  accountId?: string;
  error?: string;
}

export interface ConnectionsOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class ConnectionsService {
  readonly #context: ConsoleContext;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #googleFlows = new Map<string, PendingGoogleFlow>();
  readonly #chatGptFlows = new Map<string, ChatGptFlow>();

  constructor(context: ConsoleContext, options: ConnectionsOptions = {}) {
    this.#context = context;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Everything the Connections page renders, statuses probed live. */
  async overview() {
    const settings = this.#context.settings().settings;
    const dataDir = this.#context.dataDir(settings);
    const client = readGoogleClient(dataDir);
    const accounts = readGoogleAccounts(dataDir);
    const statuses = await Promise.all(
      accounts.map((account) => probeGoogleAccount(dataDir, account.label, this.#fetch)),
    );
    const gws = await findGwsBinary(settings?.google.gws_path);
    return {
      chatgpt: {
        selected: settings?.provider.selected ?? "chatgpt-subscription",
        ...this.#chatGptStatus(),
      },
      google: {
        clientConfigured: client !== undefined,
        clientId: client?.clientId ?? null,
        defaultAccount: settings?.google.default_account ?? null,
        gws: gws ? { installed: true, version: gws.version, path: gws.path } : { installed: false },
        services: GOOGLE_SERVICES.map((service) => ({
          id: service.id,
          name: service.name,
          api: service.api,
        })),
        accounts: accounts.map((account, index) => ({
          ...account,
          status: statuses[index] as GoogleAccountStatus,
        })),
      },
    };
  }

  saveClient(body: Record<string, unknown>): { clientId: string } {
    const client = parseGoogleClientInput({
      ...(typeof body.client_id === "string" ? { client_id: body.client_id } : {}),
      ...(typeof body.client_secret === "string" ? { client_secret: body.client_secret } : {}),
      ...(typeof body.json === "string" ? { json: body.json } : {}),
    });
    saveGoogleClient(this.#context.dataDir(), client);
    return { clientId: client.clientId };
  }

  /**
   * Begin a connect (or reconnect / scope edit — same flow). The browser's own
   * origin becomes the redirect URI, which is why this works through any
   * tunnel: Google sends the user back to the console they were already using.
   */
  startGoogle(body: Record<string, unknown>): { authUrl: string; redirectUri: string } {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!LABEL_PATTERN.test(label)) {
      throw new ApiProblem(422, "Account labels are short slugs: lowercase letters, digits, dashes (e.g. personal, work).");
    }
    const origin = typeof body.origin === "string" ? body.origin.replace(/\/+$/, "") : "";
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) {
      throw new ApiProblem(422, "Missing the console origin — reload the page and try again.");
    }
    const services = Array.isArray(body.services) ? body.services : [];
    const scopes: string[] = [];
    for (const entry of services) {
      const record = entry as Record<string, unknown>;
      const service = GOOGLE_SERVICES.find((candidate) => candidate.id === record.id);
      if (!service) throw new ApiProblem(422, `Unknown Google service "${String(record.id)}".`);
      scopes.push(record.access === "full" ? service.fullScope : service.readonlyScope);
    }
    if (scopes.length === 0) {
      throw new ApiProblem(422, "Pick at least one service.");
    }
    const client = readGoogleClient(this.#context.dataDir());
    if (!client) {
      throw new ApiProblem(409, "Set up the Google Cloud OAuth client first.");
    }

    const state = newOAuthState();
    const redirectUri = `${origin}${GOOGLE_CALLBACK_PATH}`;
    this.#googleFlows.set(state, { label, redirectUri, createdAt: this.#now() });
    return {
      authUrl: googleAuthUrl({ client, redirectUri, scopes, state }),
      redirectUri,
    };
  }

  /** OAuth redirect target. Always answers with a redirect back to /connections. */
  async googleCallback(query: Record<string, string | undefined>): Promise<Response> {
    const back = (params: Record<string, string>) =>
      redirectTo(`/connections?${new URLSearchParams(params).toString()}`);

    const flow = query.state ? this.#googleFlows.get(query.state) : undefined;
    if (query.state) this.#googleFlows.delete(query.state);
    if (!flow || this.#now() - flow.createdAt > STATE_TTL_MS) {
      return back({ error: "This sign-in link expired or was already used — start again." });
    }
    if (query.error || !query.code) {
      return back({
        error:
          query.error === "access_denied"
            ? "Google sign-in was cancelled."
            : `Google sign-in failed (${query.error ?? "no code returned"}).`,
      });
    }
    const client = readGoogleClient(this.#context.dataDir());
    if (!client) {
      return back({ error: "The Google OAuth client is gone — set it up again." });
    }
    try {
      const tokens = await exchangeGoogleCode({
        code: query.code,
        redirectUri: flow.redirectUri,
        client,
        fetch: this.#fetch,
      });
      const account = saveGoogleAccount(this.#context.dataDir(), {
        label: flow.label,
        client,
        tokens,
      });
      return back({ connected: account.label });
    } catch (error) {
      return back({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async disconnectGoogle(label: string): Promise<boolean> {
    return removeGoogleAccount(this.#context.dataDir(), label, this.#fetch);
  }

  /**
   * Start the ChatGPT device-code login. Resolves once the code exists so the
   * UI can show it; the exchange keeps polling in the background and the UI
   * follows along via chatGptFlow().
   */
  async startChatGpt(): Promise<{ flowId: string; verificationUrl: string; userCode: string }> {
    const flowId = newOAuthState();
    const prompt = await new Promise<{ verificationUrl: string; userCode: string }>(
      (resolvePrompt, rejectPrompt) => {
        runChatGptDeviceLogin({
          authFile: this.#chatGptAuthFile(),
          fetch: this.#fetch,
          onPrompt: (details) => {
            this.#chatGptFlows.set(flowId, { status: "pending", ...details });
            resolvePrompt(details);
          },
        })
          .then((tokens) => {
            const flow = this.#chatGptFlows.get(flowId);
            if (flow) {
              this.#chatGptFlows.set(flowId, {
                ...flow,
                status: "done",
                accountId: tokens.accountId,
              });
            }
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const flow = this.#chatGptFlows.get(flowId);
            if (flow) {
              this.#chatGptFlows.set(flowId, { ...flow, status: "error", error: message });
            } else {
              rejectPrompt(new Error(message));
            }
          });
      },
    );
    return { flowId, ...prompt };
  }

  chatGptFlow(flowId: string): ChatGptFlow | undefined {
    return this.#chatGptFlows.get(flowId);
  }

  #chatGptAuthFile(): string {
    const settings = this.#context.settings().settings;
    return resolve(
      this.#context.root,
      settings?.provider.chatgpt.auth_file ?? ".data/chatgpt-auth.json",
    );
  }

  #chatGptStatus(): { connected: boolean; accountId: string | null; updatedAt: string | null } {
    const path = this.#chatGptAuthFile();
    if (!existsSync(path)) return { connected: false, accountId: null, updatedAt: null };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const record = parsed as Record<string, unknown>;
      const accountId = typeof record.accountId === "string" ? record.accountId : null;
      return {
        connected: accountId !== null && typeof record.refreshToken === "string",
        accountId,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
      };
    } catch {
      return { connected: false, accountId: null, updatedAt: null };
    }
  }
}

/** Error with an HTTP status the route layer can map. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
