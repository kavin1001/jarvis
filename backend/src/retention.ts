import { query } from "./db.js";

/**
 * "Keep chats for 90 days": chats not used for longer are deleted, messages and all.
 * Pinned chats, and chats with a background task still running, are kept.
 */

export const RETENTION_CHOICES = [30, 90, 365] as const;

export async function getChatRetention(userId: string): Promise<number | null> {
  const [row] = await query<{ chat_retention_days: number | null }>("SELECT chat_retention_days FROM user_settings WHERE user_id = $1", [userId]);
  return row?.chat_retention_days ?? null;
}

export async function setChatRetention(userId: string, days: number | null) {
  await query(
    `INSERT INTO user_settings (user_id, chat_retention_days) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET chat_retention_days = $2, updated_at = now()`,
    [userId, days],
  );
}

const OLD = `c.updated_at < $1::timestamptz - make_interval(days => $2::int)
       AND NOT c.pinned
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id = c.id AND t.status IN ('queued', 'running', 'waiting_approval'))`;

/** How many chats a retention of `days` would delete now, to show before the user picks it. */
export async function countOldChats(userId: string, days: number, now = new Date()): Promise<number> {
  const [row] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations c WHERE c.user_id = $3 AND ${OLD}`, [now, days, userId]);
  return row.n;
}

/** Deletes chats past each user's retention. Returns how many went. */
export async function sweepOldChats(now = new Date()): Promise<number> {
  const rows = await query(
    `DELETE FROM conversations c USING user_settings s
     WHERE c.user_id = s.user_id AND s.chat_retention_days IS NOT NULL
       AND ${OLD.replace("$2::int", "s.chat_retention_days")}
     RETURNING c.id`,
    [now],
  );
  return rows.length;
}
