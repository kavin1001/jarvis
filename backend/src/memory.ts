import type Anthropic from "@anthropic-ai/sdk";
import { query } from "./db.js";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type Source = "text" | "voice" | "system";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  kind: "turn" | "task_update";
  content: Anthropic.Beta.BetaMessageContentParam;
  display_text: string | null;
  source: Source;
  consumed: boolean;
  created_at: string;
}

export async function createConversation(userId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    "INSERT INTO conversations (user_id) VALUES ($1) RETURNING id",
    [userId],
  );
  return row.id;
}

export async function listConversations(userId: string) {
  return query<{ id: string; title: string | null; updated_at: string }>(
    "SELECT id, title, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50",
    [userId],
  );
}

export async function conversationBelongsTo(conversationId: string, userId: string) {
  const rows = await query("SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2", [
    conversationId,
    userId,
  ]);
  return rows.length > 0;
}

export async function deleteConversation(conversationId: string, userId: string) {
  const rows = await query("DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id", [
    conversationId,
    userId,
  ]);
  return rows.length > 0;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  return query<StoredMessage>(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id",
    [conversationId],
  );
}

export async function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: Anthropic.Beta.BetaMessageContentParam,
  displayText: string | null,
  source: Source = "text",
  kind: "turn" | "task_update" = "turn",
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, kind, content, display_text, source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [conversationId, role, kind, JSON.stringify(content), displayText, source],
  );
  await query(
    "UPDATE conversations SET updated_at = now(), title = COALESCE(title, left($2, 60)) WHERE id = $1",
    [conversationId, displayText ?? ""],
  );
  return row.id;
}

/**
 * Task updates arrive between turns. History sent to Claude must stay
 * append-only, so instead of inserting them mid-history they are folded
 * into the next user turn as text and marked consumed.
 */
export async function takePendingTaskUpdates(conversationId: string): Promise<string[]> {
  const rows = await query<{ display_text: string }>(
    `UPDATE messages SET consumed = true
     WHERE conversation_id = $1 AND kind = 'task_update' AND NOT consumed
     RETURNING display_text`,
    [conversationId],
  );
  return rows.map((r) => r.display_text);
}

/** The history exactly as Claude saw it: API turns only, in order. */
export async function getApiHistory(conversationId: string): Promise<BetaMessageParam[]> {
  const rows = await getMessages(conversationId);
  return rows
    .filter((r) => r.kind === "turn")
    .map((r) => ({ role: r.role, content: r.content }) as BetaMessageParam);
}

export async function listFacts(userId: string) {
  return query<{ id: string; fact: string }>(
    "SELECT id, fact FROM facts WHERE user_id = $1 ORDER BY id",
    [userId],
  );
}

export async function addFact(userId: string, fact: string) {
  const [row] = await query<{ id: string }>(
    "INSERT INTO facts (user_id, fact) VALUES ($1, $2) RETURNING id",
    [userId, fact],
  );
  return row.id;
}

export async function deleteFact(userId: string, factId: string) {
  const rows = await query("DELETE FROM facts WHERE user_id = $1 AND id = $2 RETURNING id", [
    userId,
    factId,
  ]);
  return rows.length > 0;
}
