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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
      response.status,
      Array.isArray(body.issues) ? (body.issues as FieldIssue[]) : [],
    );
  }
  return body as T;
}

// -- shapes -----------------------------------------------------------------

export interface Status {
  workspaceRoot: string;
  dataDir: string;
  settingsValid: boolean;
  settingsError: string | null;
  ownerHandle: string | null;
  serverPort: number;
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
  readOnly: boolean;
  budget: number | null;
}

export interface SchedulePreview {
  errors: string[];
  timeZone: string;
  entries: {
    name: string;
    kind: "cron" | "once";
    pattern: string;
    prompt: string;
    nextRun: string | null;
  }[];
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

export interface Connections {
  chatgpt: {
    selected: "chatgpt-subscription" | "openai-api" | "custom";
    connected: boolean;
    accountId: string | null;
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

// -- mutations --------------------------------------------------------------

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
    body: JSON.stringify({ ...input, origin: window.location.origin }),
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

export const saveFile = (path: string, content: string) =>
  request<{ path: string }>("/api/files/content", {
    method: "PUT",
    body: JSON.stringify({ path, content }),
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
