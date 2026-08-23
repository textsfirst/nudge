import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: FieldIssue[] = [],
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const unsafe = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(unsafe && csrfToken ? { "X-Nudge-CSRF": csrfToken } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      csrfToken = null;
      onUnauthorized?.();
    }
    throw new ApiError(
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
      response.status,
      Array.isArray(body.issues) ? (body.issues as FieldIssue[]) : [],
    );
  }
  return body as T;
}

export interface AuthStatus {
  authenticated: boolean;
  csrfToken: string | null;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const status = await request<AuthStatus>("/api/auth/status");
  csrfToken = status.authenticated ? status.csrfToken : null;
  return status;
}

export async function loginConsole(capability: string): Promise<AuthStatus> {
  const status = await request<AuthStatus>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ capability }),
  });
  csrfToken = status.csrfToken;
  return status;
}

export async function logoutConsole(): Promise<void> {
  await request<{ authenticated: false }>("/api/auth/logout", { method: "POST" });
  csrfToken = null;
}

// -- shapes -----------------------------------------------------------------

export interface Status {
  workspaceRoot: string;
  dataDir: string;
  settingsValid: boolean;
  settingsError: string | null;
  ownerHandle: string | null;
  serverPort: number;
  /** Command that starts the Nudge server for this install (release vs source). */
  serverCommand: string;
  serverUp: boolean;
  serverHealthy: boolean;
  serverError: string | null;
  dbExists: boolean;
}

export interface SettingsField {
  path: string;
  label: string;
  help?: string;
  control: "text" | "number" | "boolean" | "select";
  options?: string[];
  optional?: boolean;
  placeholder?: string;
}

export interface SettingsSection {
  title: string;
  description?: string;
  fields: SettingsField[];
}

export interface SettingsPayload {
  settings: Record<string, unknown>;
  overrides: Record<string, unknown>;
  form: SettingsSection[];
  error: string | null;
}

export interface Secret {
  key: string;
  set: boolean;
  known: boolean;
  required: boolean;
  description: string;
}

export interface FileInfo {
  path: string;
  size: number;
  modifiedAt: number;
  readOnly: boolean;
  budget: number | null;
}

export interface FileContent {
  path: string;
  content: string;
  hash?: string;
  readOnly: boolean;
  budget: number | null;
}

export interface SchedulePreview {
  errors: string[];
  timeZone: string;
  entries: {
    id: string;
    name: string;
    kind: "cron" | "once";
    pattern: string;
    prompt: string;
    agent: string | null;
    check: string | null;
    nextRun: string | null;
  }[];
}

export interface ScheduleEntryState {
  entryId: string;
  lastRunAt: number | null;
  claimedAt: number | null;
  completed: boolean;
  lastCheckHash: string | null;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  checksRun: number;
  wakes: number;
  lastCheckError: string | null;
}

export interface AgentStats {
  id: number;
  handle: string;
  name: string;
  kind: "temp" | "standing";
  description: string;
  status: "active" | "archived" | "done";
  createdAt: number;
  lastActiveAt: number;
  sessionId: number | null;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
}

export type ActivityEvent =
  | {
      type: "dispatch";
      messageId: number;
      createdAt: number;
      agentName: string;
      scheduled: boolean;
      text: string;
    }
  | {
      type: "report";
      messageId: number;
      sessionId: number;
      createdAt: number;
      agentName: string | null;
      text: string;
      outcome: "pending" | "silent" | "delivered";
      reply: string | null;
    };

export interface CostsPayload {
  days: number;
  usage: {
    day: string;
    kind: "conversation" | "execution" | "report";
    turns: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  watcher: { checksRun: number; wakes: number; avoided: number };
}

export interface ThreadSummary {
  id: number;
  handle: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  endReason: string | null;
  messageCount: number;
  preview: string | null;
}

/** One model round trip within a tool-using turn. */
export interface MessageStepTiming {
  step: number;
  modelId: string;
  finishReason: string;
  durationMs: number;
  modelMs: number;
  ttftMs?: number;
  outputTps?: number;
  toolMs?: number;
  toolCalls?: string[];
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Per-turn model metrics; every field is optional — old rows and sparse providers omit some. */
export interface MessageMetrics {
  provider?: string;
  modelId?: string;
  finishReason?: string;
  steps?: number;
  stepTimings?: MessageStepTiming[];
  durationMs?: number;
  modelMs?: number;
  ttftMs?: number;
  outputTps?: number;
  toolMs?: number;
  inputTokensTotal?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  retries?: number;
}

/** One recorded tool call; durationMs is absent on pre-upgrade history. */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  output: unknown;
  durationMs?: number;
}

export interface MessageAttachment {
  id: number;
  kind: "image" | "voice" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: "stored" | "failed";
  transcript: string | null;
  caption: string | null;
  /** False when the transfer failed — there are no bytes to fetch. */
  hasContent: boolean;
}

export interface ThreadMessage {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  createdAt: number;
  toolCalls: ToolCallRecord[] | null;
  /** Model-reported token usage; null on user/error rows and pre-upgrade history. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Turn metrics; null on user/error rows and pre-upgrade history. */
  metrics: MessageMetrics | null;
  attachments: MessageAttachment[];
}

/** The in-flight turn's live tool-step trace; null when no turn is running. */
export interface ThreadProgress {
  startedAt: number;
  updatedAt: number;
  toolCalls: ToolCallRecord[];
}

export interface ThreadDetail {
  session: {
    id: number;
    handle: string;
    startedAt: number;
    lastActivityAt: number;
    endedAt: number | null;
    endReason: string | null;
    summary: string | null;
    carryover: string | null;
    compactedThrough: number;
  };
  messages: ThreadMessage[];
  progress: ThreadProgress | null;
}

export interface GoogleAccount {
  label: string;
  email: string;
  scopes: string[];
  connectedAt: string;
  status: "ok" | "expired" | "unreachable" | "missing";
}

export type ProviderSelected =
  | "chatgpt-subscription"
  | "grok-subscription"
  | "openai-api"
  | "custom";

export interface Connections {
  chatgpt: {
    selected: ProviderSelected;
    connected: boolean;
    accountId: string | null;
    updatedAt: string | null;
  };
  grok: {
    selected: ProviderSelected;
    connected: boolean;
    account: string | null;
    updatedAt: string | null;
  };
  google: {
    clientConfigured: boolean;
    clientId: string | null;
    defaultAccount: string | null;
    gws: { installed: boolean; version?: string; path?: string };
    services: { id: string; name: string; api: string }[];
    accounts: GoogleAccount[];
  };
}

export interface ChatGptFlow {
  status: "pending" | "done" | "error";
  verificationUrl: string;
  userCode: string;
  accountId?: string;
  error?: string;
}

export interface GrokFlow {
  status: "pending" | "done" | "error";
  verificationUrl: string;
  userCode: string;
  account?: string;
  error?: string;
}

export type McpServerConfig =
  | { transport: "http"; url: string; headers?: Record<string, string>; enabled: boolean }
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
      enabled: boolean;
    };

export interface McpServerView {
  name: string;
  config: McpServerConfig;
  /** Hash of the stored entry; sent back as baseHash to detect concurrent edits. */
  hash: string;
  envRefs: { name: string; set: boolean }[];
}

export interface McpOverview {
  path: string;
  exists: boolean;
  error: string | null;
  servers: McpServerView[];
}

export interface McpTestResult {
  ok: boolean;
  error?: string;
  tools?: { name: string; description: string }[];
  truncated?: boolean;
}

export type SkillProvenance =
  | "bundled"
  | "bundled-customized"
  | "registry"
  | "registry-customized"
  | "local";

export interface SkillEntry {
  name: string;
  description: string;
  version: string;
  provenance: SkillProvenance;
  source: string | null;
  installedAt: string | null;
  restorable: boolean;
  files: string[];
  problem: string | null;
}

export interface SkillsOverview {
  skills: SkillEntry[];
  restorable: { name: string; description: string }[];
}

export interface SkillUpdateStatus {
  name: string;
  source: string;
  customized: boolean;
  updateAvailable: boolean;
  error: string | null;
}

export interface SearchHit {
  id: number;
  sessionId: number;
  role: string;
  content: string;
  createdAt: number;
}

// -- queries ----------------------------------------------------------------

export const useStatus = () =>
  useQuery({
    queryKey: ["status"],
    queryFn: () => request<Status>("/api/status"),
    refetchInterval: 15_000,
  });

export const useSettings = () =>
  useQuery({ queryKey: ["settings"], queryFn: () => request<SettingsPayload>("/api/settings") });

export const useSecrets = () =>
  useQuery({
    queryKey: ["secrets"],
    queryFn: () => request<{ secrets: Secret[] }>("/api/secrets"),
  });

export const useFiles = () =>
  useQuery({ queryKey: ["files"], queryFn: () => request<{ files: FileInfo[] }>("/api/files") });

export const useFileContent = (path: string | null) =>
  useQuery({
    queryKey: ["file", path],
    queryFn: () => request<FileContent>(`/api/files/content?path=${encodeURIComponent(path!)}`),
    enabled: path !== null,
  });

export const useThreads = (offset: number, limit = 25) =>
  useQuery({
    queryKey: ["threads", offset, limit],
    queryFn: () =>
      request<{ sessions: ThreadSummary[]; total: number }>(
        `/api/threads?limit=${limit}&offset=${offset}`,
      ),
    refetchInterval: 10_000,
  });

export const useThread = (id: number) =>
  useQuery({
    queryKey: ["thread", id],
    queryFn: () => request<ThreadDetail>(`/api/threads/${id}`),
    // Live-follow active threads (faster while a turn is in flight); ended
    // ones are immutable so a single fetch does.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.session.endedAt !== null) return false;
      return data.progress ? 1_000 : 2_500;
    },
  });

export const useSearch = (query: string) =>
  useQuery({
    queryKey: ["search", query],
    queryFn: () => request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length > 1,
  });

export const useConnections = () =>
  useQuery({
    queryKey: ["connections"],
    queryFn: () => request<Connections>("/api/connections"),
    refetchInterval: 60_000,
  });

export const useMcp = () =>
  useQuery({ queryKey: ["mcp"], queryFn: () => request<McpOverview>("/api/mcp") });

export const useSkills = () =>
  useQuery({ queryKey: ["skills"], queryFn: () => request<SkillsOverview>("/api/skills") });

export const useAgents = () =>
  useQuery({
    queryKey: ["agents"],
    queryFn: () => request<{ agents: AgentStats[] }>("/api/agents"),
    refetchInterval: 10_000,
  });

export const useActivity = (limit = 50) =>
  useQuery({
    queryKey: ["activity", limit],
    queryFn: () => request<{ events: ActivityEvent[] }>(`/api/activity?limit=${limit}`),
    refetchInterval: 10_000,
  });

export const useCosts = (days = 14) =>
  useQuery({
    queryKey: ["costs", days],
    queryFn: () => request<CostsPayload>(`/api/costs?days=${days}`),
    refetchInterval: 60_000,
  });

export const useScheduleState = () =>
  useQuery({
    queryKey: ["schedule-state"],
    queryFn: () => request<{ states: ScheduleEntryState[] }>("/api/schedule/state"),
    refetchInterval: 15_000,
  });

// -- mutations --------------------------------------------------------------

export const saveMcpServer = (name: string, server: McpServerConfig, baseHash: string | null) =>
  request<McpServerView>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ server, baseHash }),
  });

export const deleteMcpServer = (name: string) =>
  request<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });

export const testMcpServer = (name: string) =>
  request<McpTestResult>(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST" });

export const installSkill = (source: string) =>
  request<{ name: string; source: string }>("/api/skills/install", {
    method: "POST",
    body: JSON.stringify({ source }),
  });

export const updateSkill = (name: string, force: boolean) =>
  request<{ name: string; source: string }>(`/api/skills/${encodeURIComponent(name)}/update`, {
    method: "POST",
    body: JSON.stringify({ force }),
  });

export const restoreSkill = (name: string) =>
  request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/restore`, { method: "POST" });

export const deleteSkill = (name: string) =>
  request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });

export const checkSkillUpdates = () =>
  request<SkillUpdateStatus[]>("/api/skills/check", { method: "POST" });

export const saveGoogleClient = (input: { json?: string; client_id?: string; client_secret?: string }) =>
  request<{ clientId: string }>("/api/connections/google/client", {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const startGoogleConnect = (input: {
  label: string;
  services: { id: string; access: "readonly" | "full" }[];
}) =>
  request<{ authUrl: string; redirectUri: string }>("/api/connections/google/start", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const disconnectGoogle = (label: string) =>
  request<{ ok: boolean }>(`/api/connections/google/${encodeURIComponent(label)}`, {
    method: "DELETE",
  });

export const startChatGptConnect = () =>
  request<{ flowId: string; verificationUrl: string; userCode: string }>(
    "/api/connections/chatgpt/start",
    { method: "POST" },
  );

export const getChatGptFlow = (flowId: string) =>
  request<ChatGptFlow>(`/api/connections/chatgpt/flow/${encodeURIComponent(flowId)}`);

export const startGrokConnect = () =>
  request<{ flowId: string; verificationUrl: string; userCode: string }>(
    "/api/connections/grok/start",
    { method: "POST" },
  );

export const getGrokFlow = (flowId: string) =>
  request<GrokFlow>(`/api/connections/grok/flow/${encodeURIComponent(flowId)}`);

export function useInvalidate() {
  const client = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
  };
}

export const saveSettings = (settings: Record<string, unknown>) =>
  request<{ ok: boolean; note?: string }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });

export const setSecret = (key: string, value: string) =>
  request<{ ok: boolean; note?: string }>(`/api/secrets/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });

export const deleteSecret = (key: string) =>
  request<{ ok: boolean }>(`/api/secrets/${encodeURIComponent(key)}`, { method: "DELETE" });

export const getFileContent = (path: string) =>
  request<FileContent>(`/api/files/content?path=${encodeURIComponent(path)}`);

export const saveFile = (path: string, content: string, hash?: string) =>
  request<{ path: string }>("/api/files/content", {
    method: "PUT",
    body: JSON.stringify({ path, content, ...(hash ? { hash } : {}) }),
  });

export const deleteFile = (path: string) =>
  request<{ path: string }>(`/api/files/content?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });

export const previewSchedule = (content: string) =>
  request<SchedulePreview>("/api/schedule/preview", {
    method: "POST",
    body: JSON.stringify({ content }),
  });

export const deleteThread = (id: number) =>
  request<{ ok: boolean }>(`/api/threads/${id}`, { method: "DELETE" });

export const endThread = (id: number) =>
  request<{ ok: boolean }>(`/api/threads/${id}/end`, { method: "POST" });

export const deleteMessage = (threadId: number, messageId: number) =>
  request<{ ok: boolean }>(`/api/threads/${threadId}/messages/${messageId}`, {
    method: "DELETE",
  });

export { useMutation };
