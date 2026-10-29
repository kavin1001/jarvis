import { query } from "./db.js";
import type { MailHit } from "./google.js";
import * as memory from "./memory.js";
import { sendPush } from "./push.js";

/**
 * "Tell me when Sam replies": a Gmail search Jarvis runs every few minutes, sending a
 * notification for each new match. Polling, because Gmail's push needs a Pub/Sub project.
 */

export interface MailWatch {
  id: string;
  conversation_id: string | null;
  query: string;
  about: string;
  once: boolean;
  status: "active" | "done" | "cancelled" | "expired";
  seen_ids: string[];
  checked_at: string;
  expires_at: string;
  created_at: string;
}

export const MAX_ACTIVE = 10;
export const CHECK_EVERY_MS = 5 * 60_000;
// Gmail's after: works in whole seconds and indexes new mail with a little delay, so look back a bit.
const OVERLAP_S = 10 * 60;
const KEEP_SEEN = 200;

/** seenIds: matches already in the inbox, so the first check doesn't announce them. */
export async function createMailWatch(w: {
  userId: string;
  conversationId: string | null;
  query: string;
  about: string;
  once: boolean;
  days: number;
  seenIds?: string[];
}) {
  const [{ count }] = await query<{ count: number }>("SELECT count(*)::int AS count FROM mail_watches WHERE user_id = $1 AND status = 'active'", [w.userId]);
  if (count >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} email watches at once. Cancel one first (list_reminders shows them).`);
  const [row] = await query<{ id: string }>(
    `INSERT INTO mail_watches (user_id, conversation_id, query, about, once, expires_at, seen_ids)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7) RETURNING id`,
    [w.userId, w.conversationId, w.query, w.about, w.once, w.days, w.seenIds ?? []],
  );
  return row.id;
}

export async function listMailWatches(userId: string) {
  return query<MailWatch>("SELECT * FROM mail_watches WHERE user_id = $1 AND status = 'active' AND expires_at > now() ORDER BY created_at", [userId]);
}

export async function cancelMailWatch(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return (await query("UPDATE mail_watches SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id", [id, userId])).length > 0;
}

export function describeMailWatch(w: Pick<MailWatch, "about" | "query" | "once" | "expires_at">, timeZone = "UTC") {
  const until = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(w.expires_at));
  return `watching email for ${w.about} (${w.query})${w.once ? ", once" : ", every match"} until ${until}`;
}

export type Search = (userId: string, q: string) => Promise<MailHit[]>;

/** The sender's name without the address: "Sam Lee <sam@example.com>" is "Sam Lee". */
const senderName = (from: string) => from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || from;

/**
 * Runs each watch that is due a check. Each is claimed by moving its checked_at in one
 * statement, so overlapping sweeps (or two servers) don't notify twice.
 */
export async function checkMailWatches(search: Search, now = new Date()) {
  await query("UPDATE mail_watches SET status = 'expired' WHERE status = 'active' AND expires_at <= $1", [now]);
  const dueBy = new Date(now.getTime() - CHECK_EVERY_MS);
  const due = await query<MailWatch & { user_id: string }>(
    "SELECT * FROM mail_watches WHERE status = 'active' AND checked_at <= $1 ORDER BY checked_at LIMIT 20",
    [dueBy],
  );
  for (const w of due) {
    const claimed = await query("UPDATE mail_watches SET checked_at = $3 WHERE id = $1 AND checked_at <= $2 AND status = 'active' RETURNING id", [
      w.id,
      dueBy,
      now,
    ]);
    if (claimed.length === 0) continue;
    try {
      const since = Math.floor(new Date(w.checked_at).getTime() / 1000) - OVERLAP_S;
      const hits = (await search(w.user_id, `(${w.query}) -from:me after:${since}`)).filter((h) => !w.seen_ids.includes(h.id));
      if (hits.length === 0) continue;
      const fresh = w.once ? hits.slice(0, 1) : hits;
      await query(
        "UPDATE mail_watches SET seen_ids = (ARRAY(SELECT unnest($2::text[] || seen_ids)))[1:$3], status = CASE WHEN once THEN 'done' ELSE status END WHERE id = $1",
        [w.id, fresh.map((h) => h.id), KEEP_SEEN],
      );
      await notify(w, fresh);
    } catch (err) {
      console.warn(`mail watch ${w.id} failed`, err instanceof Error ? err.message : err);
    }
  }
}

async function notify(w: MailWatch & { user_id: string }, hits: MailHit[]) {
  const conversationId = w.conversation_id ?? (await memory.createConversation(w.user_id));
  const lines = hits.map((h) => `- From ${h.from}: "${h.subject || "(no subject)"}" [${h.id}]`);
  const text = `New email for ${w.about}:\n${lines.join("\n")}${w.once ? "" : "\n(Still watching.)"}`;
  await memory.appendMessage(conversationId, "assistant", [{ type: "text", text }], text, "system", "task_update");
  const first = hits[0];
  const title = hits.length === 1 ? `Email from ${senderName(first.from)}` : `${hits.length} emails for ${w.about}`;
  await sendPush(w.user_id, title, hits.length === 1 ? first.subject || w.about : hits.map((h) => senderName(h.from)).join(", "), { conversationId }, "reply");
}
