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

export const PAGE_SIZE = 50;

/**
 * Pinned chats, then the newest 50 others. With `before` (the last chat of the
 * previous page), the next 50 unpinned chats older than it. Times are compared to
 * the millisecond, as the app sees them, with the id breaking ties.
 */
export async function listConversations(userId: string, before?: { updated_at: string; id: string }) {
  const cols = "id, title, updated_at, pinned";
  const order = "ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC";
  type Row = { id: string; title: string | null; updated_at: string; pinned: boolean };
  if (before) {
    return query<Row>(
      `SELECT ${cols} FROM conversations WHERE user_id = $1 AND NOT pinned
         AND (date_trunc('milliseconds', updated_at), id) < ($2::timestamptz, $3::uuid) ${order} LIMIT ${PAGE_SIZE}`,
      [userId, before.updated_at, before.id],
    );
  }
  const [pinned, rest] = await Promise.all([
    query<Row>(`SELECT ${cols} FROM conversations WHERE user_id = $1 AND pinned ${order}`, [userId]),
    query<Row>(`SELECT ${cols} FROM conversations WHERE user_id = $1 AND NOT pinned ${order} LIMIT ${PAGE_SIZE}`, [userId]),
  ]);
  return [...pinned, ...rest];
}

export async function setTitle(conversationId: string, title: string) {
  await query("UPDATE conversations SET title = $2 WHERE id = $1", [conversationId, title]);
}

export async function setPinned(conversationId: string, pinned: boolean) {
  await query("UPDATE conversations SET pinned = $2 WHERE id = $1", [conversationId, pinned]);
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
    "UPDATE conversations SET updated_at = now(), title = COALESCE(title, NULLIF(left($2, 60), '')) WHERE id = $1",
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

// Fact ids are integers; anything else matches nothing instead of failing the query.
const factIdOk = (id: string) => /^\d{1,18}$/.test(id);

export async function updateFact(userId: string, factId: string, fact: string) {
  if (!factIdOk(factId)) return false;
  const rows = await query("UPDATE facts SET fact = $3 WHERE user_id = $1 AND id = $2 RETURNING id", [userId, factId, fact]);
  return rows.length > 0;
}

export async function deleteFact(userId: string, factId: string) {
  if (!factIdOk(factId)) return false;
  const rows = await query("DELETE FROM facts WHERE user_id = $1 AND id = $2 RETURNING id", [
    userId,
    factId,
  ]);
  return rows.length > 0;
}

export interface SearchHit {
  conversation_id: string;
  title: string | null;
  role: "user" | "assistant";
  created_at: string;
  snippet: string;
}

/** Full-text search over what the user and Jarvis said, newest and best matches first. */
export async function searchMessages(
  userId: string,
  q: string,
  opts: { limit?: number; excludeConversationId?: string } = {},
): Promise<SearchHit[]> {
  return query<SearchHit>(
    `WITH q AS (SELECT websearch_to_tsquery('english', $2) AS query)
     SELECT m.conversation_id, c.title, m.role, m.created_at,
            ts_headline('english', m.display_text, q.query,
                        'MaxWords=30, MinWords=10, MaxFragments=2, StartSel=«, StopSel=»') AS snippet
     FROM messages m JOIN conversations c ON c.id = m.conversation_id, q
     WHERE c.user_id = $1
       AND m.display_text IS NOT NULL
       AND to_tsvector('english', coalesce(m.display_text, '')) @@ q.query
       AND ($4::uuid IS NULL OR m.conversation_id <> $4::uuid)
     ORDER BY ts_rank(to_tsvector('english', coalesce(m.display_text, '')), q.query) * 0.5
              + 1.0 / (1 + extract(epoch FROM now() - m.created_at) / 86400 / 30) DESC
     LIMIT $3`,
    [userId, q, Math.min(opts.limit ?? 8, 25), opts.excludeConversationId ?? null],
  );
}

/** The user's own "how to reply" instructions ("keep it short", "metric units"), or null. */
export const MAX_INSTRUCTIONS = 1500;
export async function getInstructions(userId: string): Promise<string | null> {
  const [row] = await query<{ custom_instructions: string | null }>("SELECT custom_instructions FROM user_settings WHERE user_id = $1", [userId]);
  return row?.custom_instructions ?? null;
}

export async function setInstructions(userId: string, text: string | null) {
  const value = text?.trim() ? text.trim().slice(0, MAX_INSTRUCTIONS) : null;
  await query(
    `INSERT INTO user_settings (user_id, custom_instructions) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET custom_instructions = $2, updated_at = now()`,
    [userId, value],
  );
  return value;
}
