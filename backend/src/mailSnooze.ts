import { query } from "./db.js";
import * as memory from "./memory.js";
import { sendPush } from "./push.js";

/**
 * "Snooze this until Monday": Gmail has no snooze in its API, so Jarvis archives the emails
 * now and puts them back in the inbox, unread, when the time comes, with a notification.
 */

export interface MailSnooze {
  id: string;
  user_id: string;
  conversation_id: string | null;
  message_ids: string[];
  about: string;
  due_at: string;
  status: "snoozed" | "back" | "failed";
  created_at: string;
}

/** Moves emails between labels: the Gmail call, injected so tests and the sweep share it. */
export type Modify = (userId: string, ids: string[], add: string[], remove: string[]) => Promise<void>;

export async function snoozeMail(
  s: { userId: string; conversationId: string | null; messageIds: string[]; about: string; dueAt: Date },
  modify: Modify,
) {
  await modify(s.userId, s.messageIds, [], ["INBOX"]);
  const [row] = await query<{ id: string }>(
    "INSERT INTO mail_snoozes (user_id, conversation_id, message_ids, about, due_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [s.userId, s.conversationId, s.messageIds, s.about, s.dueAt],
  );
  return row.id;
}

export async function listSnoozes(userId: string) {
  return query<MailSnooze>("SELECT * FROM mail_snoozes WHERE user_id = $1 AND status = 'snoozed' ORDER BY due_at", [userId]);
}

/** Puts snoozed emails back now ("unsnooze"). False when there's no such snooze. */
export async function unsnooze(userId: string, id: string, modify: Modify) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [s] = await query<MailSnooze>("UPDATE mail_snoozes SET status = 'back' WHERE id = $1 AND user_id = $2 AND status = 'snoozed' RETURNING *", [id, userId]);
  if (!s) return false;
  try {
    await modify(userId, s.message_ids, ["INBOX", "UNREAD"], []);
  } catch (err) {
    await query("UPDATE mail_snoozes SET status = 'snoozed' WHERE id = $1", [id]);
    throw err;
  }
  return true;
}

export const describeSnooze = (s: Pick<MailSnooze, "about" | "message_ids">) =>
  `snoozed ${s.message_ids.length === 1 ? "email" : `${s.message_ids.length} emails`}: ${s.about}`;

/** Brings back every snooze that is due. Each is claimed in one UPDATE, so it comes back once. */
export async function returnDueSnoozes(modify: Modify, now = new Date()) {
  const due = await query<MailSnooze>(
    "UPDATE mail_snoozes SET status = 'back' WHERE id IN (SELECT id FROM mail_snoozes WHERE status = 'snoozed' AND due_at <= $1 ORDER BY due_at LIMIT 20) RETURNING *",
    [now],
  );
  for (const s of due) {
    try {
      await modify(s.user_id, s.message_ids, ["INBOX", "UNREAD"], []);
    } catch (err) {
      // Google disconnected, say: tell the user, so the emails aren't lost in the archive.
      await query("UPDATE mail_snoozes SET status = 'failed' WHERE id = $1", [s.id]);
      await tell(s, `Couldn't put your snoozed email back in the inbox (${s.about}): ${(err as Error).message}. It's in All Mail.`, "Snoozed email");
      continue;
    }
    await tell(s, `Back in your inbox: ${s.about}.`, "Back in your inbox");
  }
}

async function tell(s: MailSnooze, text: string, title: string) {
  const conversationId = s.conversation_id ?? (await memory.createConversation(s.user_id));
  await memory.appendMessage(conversationId, "assistant", [{ type: "text", text }], text, "system", "task_update");
  await sendPush(s.user_id, title, s.about, { conversationId }, "reply");
}
