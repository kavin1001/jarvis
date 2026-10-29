import { query } from "./db.js";
import * as memory from "./memory.js";
import { sendPush } from "./push.js";
import { isValidTimeZone, monthDayFor, nextOccurrence, type Repeat } from "./time.js";

export type { Repeat };

export interface Reminder {
  id: string;
  user_id: string;
  conversation_id: string | null;
  text: string;
  action: "notify" | "run";
  due_at: Date;
  repeat: Repeat | null;
  month_day: number | null;
  timezone: string;
  status: "scheduled" | "done" | "cancelled";
  nag_minutes: number | null;
  nag_of: string | null;
  nags_left: number | null;
}

/** A nagging reminder comes back at most this many times after it first goes off. */
export const MAX_NAGS = 12;

export async function getTimezone(userId: string): Promise<string> {
  const [row] = await query<{ timezone: string }>("SELECT timezone FROM user_settings WHERE user_id = $1", [userId]);
  return row?.timezone ?? "UTC";
}

export async function setTimezone(userId: string, timezone: string) {
  if (!isValidTimeZone(timezone)) return;
  await query(
    `INSERT INTO user_settings (user_id, timezone) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET timezone = $2, updated_at = now()`,
    [userId, timezone],
  );
}

export async function createReminder(r: {
  userId: string;
  conversationId: string | null;
  text: string;
  action: "notify" | "run";
  dueAt: Date;
  repeat: Repeat | null;
  /** Comes back every this many minutes after going off, until marked done. Notify reminders only. */
  nagMinutes?: number | null;
}) {
  const timezone = await getTimezone(r.userId);
  const [row] = await query<{ id: string }>(
    `INSERT INTO reminders (user_id, conversation_id, text, action, due_at, repeat, timezone, month_day, nag_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [r.userId, r.conversationId, r.text, r.action, r.dueAt, r.repeat, timezone, monthDayFor(r.dueAt, r.repeat, timezone), r.action === "notify" ? (r.nagMinutes ?? null) : null],
  );
  return row.id;
}

export async function listReminders(userId: string) {
  return query<Reminder>(
    "SELECT * FROM reminders WHERE user_id = $1 AND status = 'scheduled' ORDER BY due_at",
    [userId],
  );
}

export async function cancelReminder(userId: string, id: string) {
  const rows = await query(
    "UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'scheduled' RETURNING id",
    [id, userId],
  );
  return rows.length > 0;
}

/**
 * "Remind me again in N minutes": a one-off copy of the reminder, so a
 * repeating schedule keeps its own times. Returns the new reminder's id.
 */
export async function snoozeReminder(userId: string, id: string, minutes: number, now = new Date()) {
  const [r] = await query<Reminder>("SELECT * FROM reminders WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!r) return null;
  // A snooze replaces the nag that was coming; the snoozed copy carries on nagging after it.
  if (r.nag_minutes) await stopNagging(userId, r);
  const [row] = await query<{ id: string }>(
    `INSERT INTO reminders (user_id, conversation_id, text, action, due_at, repeat, timezone, nag_minutes, nag_of, nags_left)
     VALUES ($1, $2, $3, 'notify', $4, NULL, $5, $6, $7, $8) RETURNING id`,
    [userId, r.conversation_id, r.text, new Date(now.getTime() + minutes * 60_000), r.timezone, r.nag_minutes, r.nag_minutes ? (r.nag_of ?? r.id) : null, r.nags_left],
  );
  return row.id;
}

async function stopNagging(userId: string, r: Pick<Reminder, "id" | "nag_of">) {
  return query("UPDATE reminders SET status = 'cancelled' WHERE user_id = $1 AND nag_of = $2 AND status = 'scheduled' RETURNING id", [userId, r.nag_of ?? r.id]);
}

/**
 * "Done" on a reminder that keeps coming back: stops the copies still to come. A repeating
 * reminder stays on its schedule. Returns false for an unknown id.
 */
export async function markReminderDone(userId: string, id: string) {
  const [r] = await query<Reminder>("SELECT * FROM reminders WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!r) return false;
  await stopNagging(userId, r);
  if (r.nag_of) await query("UPDATE reminders SET status = 'done' WHERE id = $1 AND status = 'scheduled'", [r.id]);
  return true;
}

/** Runs a scheduled prompt as a Jarvis turn and returns the answer. Injected to avoid an import cycle. */
/** Moves an upcoming reminder. A repeating one keeps repeating from its new time. */
export async function rescheduleReminder(userId: string, id: string, dueAt: Date) {
  // A monthly reminder moved to the 15th repeats on the 15th from then on.
  const rows = await query(
    `UPDATE reminders SET due_at = $3,
       month_day = CASE WHEN repeat = 'monthly' THEN extract(day FROM $3::timestamptz AT TIME ZONE timezone)::smallint END
     WHERE id = $1 AND user_id = $2 AND status = 'scheduled' RETURNING id`,
    [id, userId, dueAt],
  );
  return rows.length > 0;
}

/** Skips the next run of a repeating reminder. Returns the new due time, or null. */
export async function skipReminder(userId: string, id: string): Promise<Date | null> {
  const [r] = await query<Reminder>("SELECT * FROM reminders WHERE id = $1 AND user_id = $2 AND status = 'scheduled' AND repeat IS NOT NULL", [id, userId]);
  if (!r) return null;
  const next = nextOccurrence(new Date(r.due_at), r.repeat!, r.timezone, r.month_day);
  const rows = await query("UPDATE reminders SET due_at = $3 WHERE id = $1 AND due_at = $2 AND status = 'scheduled' RETURNING id", [id, r.due_at, next]);
  return rows.length > 0 ? next : null;
}

/**
 * Runs a scheduled job once now ("try my morning briefing"), leaving its schedule as it is.
 * Resolves once it has started; the answer arrives by notification like a scheduled run.
 */
export async function runReminderNow(userId: string, id: string, runPrompt: RunPrompt) {
  const [r] = await query<Reminder>("SELECT * FROM reminders WHERE id = $1 AND user_id = $2 AND status = 'scheduled'", [id, userId]);
  if (!r) return false;
  fire(r, runPrompt).catch((err) => console.error(`reminder ${r.id} failed`, err));
  return true;
}

export type RunPrompt = (conversationId: string, text: string) => Promise<string>;

/**
 * Fires every reminder that is due. Each is claimed by moving its due time
 * forward (or closing it) in the same statement, so two servers or two
 * overlapping sweeps can't fire it twice.
 */
export async function fireDueReminders(runPrompt: RunPrompt, now = new Date()) {
  const due = await query<Reminder>(
    "SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= $1 ORDER BY due_at LIMIT 20",
    [now],
  );
  for (const r of due) {
    const next = r.repeat ? nextOccurrence(new Date(r.due_at), r.repeat, r.timezone, r.month_day) : null;
    // A long outage shouldn't fire a daily reminder once per missed day.
    let upcoming = next;
    while (upcoming && upcoming <= now) upcoming = nextOccurrence(upcoming, r.repeat!, r.timezone, r.month_day);
    const claimed = await query(
      `UPDATE reminders SET last_fired_at = now(), due_at = COALESCE($3, due_at), status = CASE WHEN $3::timestamptz IS NULL THEN 'done' ELSE status END
       WHERE id = $1 AND due_at = $2 AND status = 'scheduled' RETURNING id`,
      [r.id, r.due_at, upcoming],
    );
    if (claimed.length === 0) continue;
    try {
      await fire(r, runPrompt, now);
    } catch (err) {
      console.error(`reminder ${r.id} failed`, err);
    }
  }
}

async function fire(r: Reminder, runPrompt: RunPrompt, now = new Date()) {
  const conversationId = r.conversation_id ?? (await memory.createConversation(r.user_id));
  if (r.action === "notify") {
    const text = `Reminder: ${r.text}`;
    // A nag repeats the same reminder; the chat only needs it once.
    if (!r.nag_of) await memory.appendMessage(conversationId, "assistant", [{ type: "text", text }], text, "system", "task_update");
    const nagsLeft = r.nag_of ? (r.nags_left ?? 0) : MAX_NAGS;
    if (r.nag_minutes && nagsLeft > 0) {
      await stopNagging(r.user_id, r);
      await query(
        `INSERT INTO reminders (user_id, conversation_id, text, action, due_at, repeat, timezone, nag_minutes, nag_of, nags_left)
         VALUES ($1, $2, $3, 'notify', $4, NULL, $5, $6, $7, $8)`,
        [r.user_id, conversationId, r.text, new Date(now.getTime() + r.nag_minutes * 60_000), r.timezone, r.nag_minutes, r.nag_of ?? r.id, nagsLeft - 1],
      );
    }
    await sendPush(r.user_id, "Reminder", r.text, { conversationId, reminderId: r.id }, r.nag_minutes ? "nag" : "reminder");
    return;
  }
  const answer = await runPrompt(conversationId, r.text);
  await sendPush(r.user_id, "Jarvis", answer || r.text, { conversationId, reminderId: r.id }, "reply");
}
