import { fetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";

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
  status: "queued" | "running" | "waiting_approval" | "done" | "failed";
  result: string | null;
  pending_approvals: PendingApproval[];
}

export type StreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "task_started"; taskId: string; summary: string }
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

async function request<T>(s: Settings, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${s.url}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
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
  body: { conversationId?: string; text: string; source: "text" | "voice" },
  onEvent: (e: StreamEvent) => void,
) {
  const res = await fetch(`${s.url}/api/chat`, {
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
