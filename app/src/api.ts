import { fetch } from "expo/fetch";
import Constants from "expo-constants";
import * as SecureStore from "./storage";
import { Platform } from "react-native";

export interface Settings {
  url: string;
  token: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  kind: "turn" | "task_update";
  text: string;
  source: "text" | "voice" | "system";
}

export interface PendingApproval {
  id: string;
  summary: string;
}

export interface Task {
  id: string;
  status: "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";
  summary: string | null;
  instructions: string;
  result: string | null;
  /** The agent's latest message while it works. */
  last_message: string | null;
  cost_usd: number;
  created_at: string;
  pending_approvals: PendingApproval[];
}

export interface Conversation {
  id: string;
  title: string | null;
  updated_at: string;
}

export interface Reminder {
  id: string;
  text: string;
  action: "notify" | "run";
  due_at: string;
  repeat: "daily" | "weekdays" | "weekly" | null;
}

export interface ServerStatus {
  claude: "ok" | "invalid_key" | "no_access" | "model_not_found" | "unreachable" | "error";
  fast_model: string;
  daily_budget_usd: number | null;
  task_lane: boolean;
  task_vault: boolean;
  google: boolean;
  connector_secret: boolean;
  public_url: boolean;
  push_devices: number;
}

export interface Usage {
  today_usd: number;
  last_7_days_usd: number;
  month_to_date_usd: number;
  chat_turns_today: number;
  tasks_today: number;
  daily_budget_usd: number | null;
}

export interface Fact {
  id: string;
  fact: string;
}

export type StreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "task_started"; taskId: string; summary: string }
  /** What Jarvis is doing while a tool runs, such as "Searching the web…". */
  | { type: "status"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const KEY = "jarvis-settings";

export async function loadSettings(): Promise<Settings | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? (JSON.parse(raw) as Settings) : null;
}

export async function saveSettings(settings: Settings) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(settings));
}

export async function clearSettings() {
  await SecureStore.deleteItemAsync(KEY);
}

export interface SearchHit {
  conversation_id: string;
  title: string | null;
  role: "user" | "assistant";
  created_at: string;
  snippet: string;
}

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  current: boolean;
}

const isDeviceToken = (token: string) => token.startsWith("jvd_");
const PAIRING_CODE = /^[2-9a-z]{4}[-\s]?[2-9a-z]{4}$/i;
export const deviceName = () =>
  Platform.OS === "web" ? browserName(globalThis.navigator?.userAgent ?? "") : Constants.deviceName ?? `Jarvis on ${Platform.OS}`;

/** "Chrome on Mac", so a browser sign-in is recognisable in Settings, Signed-in devices. */
export function browserName(ua: string) {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Signs this phone in. A pairing code from another device, or the master app
 * token, is traded for this device's own token; the master is never stored.
 */
export async function signIn(url: string, secret: string): Promise<Settings> {
  const base = url.trim().replace(/\/$/, "");
  const trimmed = secret.trim();
  const post = async (path: string, body: object, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json().catch(() => ({}))) as { token?: string; error?: string } };
  };
  // Something shaped like a pairing code is tried as one first; a short app token can look the same.
  let pairingError: string | undefined;
  if (PAIRING_CODE.test(trimmed)) {
    const paired = await post("/pair", { code: trimmed, name: deviceName() });
    if (paired.res.ok && paired.body.token) return { url: base, token: paired.body.token };
    if (paired.res.status === 429) throw new Error(paired.body.error ?? "Too many attempts");
    pairingError = paired.body.error;
  }
  const { res, body } = await post("/api/devices", { name: deviceName() }, trimmed);
  if (res.ok && body.token) return { url: base, token: body.token };
  if (res.status === 401) throw new Error(pairingError ?? "Wrong app token");
  throw new Error(body.error ?? `Sign-in failed (${res.status})`);
}

/** Older installs stored the master token; swap it for a device token once. */
export async function upgradeToDeviceToken(settings: Settings): Promise<Settings> {
  if (isDeviceToken(settings.token)) return settings;
  const upgraded = await signIn(settings.url, settings.token);
  await saveSettings(upgraded);
  return upgraded;
}

async function request<T>(s: Settings, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${s.url}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const detail = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
    throw new Error(detail ?? `${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  has_token: boolean;
  /** Signed in with OAuth from the app. */
  signed_in: boolean;
}

export interface Connectors {
  google: { available: boolean; connected: boolean; email: string | null };
}

export const api = {
  addRoutine: (s: Settings, body: { text: string; time: string; repeat: "daily" | "weekdays" | "weekly" | null; action?: "run" | "notify" }) =>
    request<{ id: string; due_at: string }>(s, "/api/reminders", { method: "POST", body }),
  exportData: (s: Settings) => request<unknown>(s, "/api/export"),
  deleteAllData: (s: Settings) => request(s, "/api/data", { method: "DELETE", body: { confirm: "DELETE" } }),
  search: (s: Settings, q: string) => request<SearchHit[]>(s, `/api/search?q=${encodeURIComponent(q)}`),
  devices: (s: Settings) => request<Device[]>(s, "/api/devices"),
  revokeDevice: (s: Settings, id: string) => request(s, `/api/devices/${id}`, { method: "DELETE" }),
  pairingCode: (s: Settings) => request<{ code: string; expires_at: string }>(s, "/api/devices/pair-codes", { method: "POST" }),
  mcpServers: (s: Settings) => request<McpServer[]>(s, "/api/mcp-servers"),
  addMcpServer: (s: Settings, body: { name: string; url: string; token?: string }) =>
    request<{ id: string }>(s, "/api/mcp-servers", { method: "POST", body }),
  setMcpServerEnabled: (s: Settings, id: string, enabled: boolean) =>
    request(s, `/api/mcp-servers/${id}`, { method: "PATCH", body: { enabled } }),
  deleteMcpServer: (s: Settings, id: string) => request(s, `/api/mcp-servers/${id}`, { method: "DELETE" }),
  startMcpSignIn: (s: Settings, id: string) => request<{ url: string }>(s, `/api/mcp-servers/${id}/oauth`, { method: "POST" }),
  connectors: (s: Settings) => request<Connectors>(s, "/api/connectors"),
  startGoogle: (s: Settings) => request<{ url: string }>(s, "/api/connectors/google/start", { method: "POST" }),
  disconnectGoogle: (s: Settings) => request(s, "/api/connectors/google", { method: "DELETE" }),
  conversations: (s: Settings) => request<Conversation[]>(s, "/api/conversations"),
  deleteConversation: (s: Settings, id: string) => request(s, `/api/conversations/${id}`, { method: "DELETE" }),
  renameConversation: (s: Settings, id: string, title: string) =>
    request(s, `/api/conversations/${id}`, { method: "PATCH", body: { title } }),
  usage: (s: Settings) => request<Usage>(s, "/api/usage"),
  status: (s: Settings) => request<ServerStatus>(s, "/api/status"),
  reminders: (s: Settings) => request<Reminder[]>(s, "/api/reminders"),
  cancelReminder: (s: Settings, id: string) => request(s, `/api/reminders/${id}`, { method: "DELETE" }),
  cancelTask: (s: Settings, id: string) => request(s, `/api/tasks/${id}/cancel`, { method: "POST" }),
  stopReply: (s: Settings, conversationId: string) =>
    request<{ stopped: boolean }>(s, `/api/conversations/${conversationId}/stop`, { method: "POST" }),
  snoozeReminder: (s: Settings, id: string, minutes: number) =>
    request<{ id: string }>(s, `/api/reminders/${id}/snooze`, { method: "POST", body: { minutes } }),
  facts: (s: Settings) => request<Fact[]>(s, "/api/facts"),
  addFact: (s: Settings, fact: string) => request<Fact>(s, "/api/facts", { method: "POST", body: { fact } }),
  deleteFact: (s: Settings, id: string) => request(s, `/api/facts/${id}`, { method: "DELETE" }),
  messages: (s: Settings, conversationId: string) =>
    request<ChatMessage[]>(s, `/api/conversations/${conversationId}/messages`),
  tasks: (s: Settings) => request<Task[]>(s, "/api/tasks"),
  decide: (s: Settings, approvalId: string, decision: "allow" | "deny") =>
    request(s, `/api/approvals/${approvalId}`, { method: "POST", body: { decision } }),
  pushToken: (s: Settings, token: string) => request(s, "/api/push-token", { method: "POST", body: { token } }),
};

/** Sends one message and calls onEvent for each server-sent event as it streams in. */
export async function streamChat(
  s: Settings,
  body: {
    conversationId?: string;
    text: string;
    source: "text" | "voice";
    timezone?: string;
    images?: { media_type: string; data: string }[];
    documents?: { name: string; media_type: string; data: string }[];
    location?: { latitude: number; longitude: number; label?: string };
  },
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`${s.url}/api/chat`, {
    signal,
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}
