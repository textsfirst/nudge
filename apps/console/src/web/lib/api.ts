import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
    );
  }
  return body as T;
}

// -- shapes -----------------------------------------------------------------

export interface Status {
  workspaceRoot: string;
  dataDir: string;
  configValid: boolean;
  configError: string | null;
  ownerHandle: string | null;
  serverPort: number;
  serverUp: boolean;
  dbExists: boolean;
}

export interface ConfigFile {
  content: string;
  exists: boolean;
  valid: boolean;
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

export interface ThreadDetail {
  session: ThreadSummary & { summary: string | null; carryover: string | null };
  messages: {
    id: number;
    role: "user" | "assistant";
    content: string;
    createdAt: number;
    toolCalls: { tool: string; input: unknown; output: unknown }[] | null;
  }[];
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
    selected: "chatgpt-subscription" | "openai-api";
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

export const useConfig = () =>
  useQuery({ queryKey: ["config"], queryFn: () => request<ConfigFile>("/api/config") });

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
  });

export const useThread = (id: number) =>
  useQuery({
    queryKey: ["thread", id],
    queryFn: () => request<ThreadDetail>(`/api/threads/${id}`),
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

export const validateConfig = (content: string) =>
  request<{ valid: boolean; error: string | null }>("/api/config/validate", {
    method: "POST",
    body: JSON.stringify({ content }),
  });

export const saveConfig = (content: string) =>
  request<{ ok: boolean; note?: string }>("/api/config", {
    method: "PUT",
    body: JSON.stringify({ content }),
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
