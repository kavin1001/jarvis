import { query } from "./db.js";

/**
 * A record of what Jarvis did on the user's accounts: drafts saved, mail organized,
 * calendar changes, background tasks and calls to their connected apps. Shown in Settings
 * so the user can see what an agent with access to their accounts has been doing.
 */

export interface Activity {
  id: string;
  conversation_id: string | null;
  kind: string;
  summary: string;
  created_at: string;
  can_undo: boolean;
  undone: boolean;
}

/** How to reverse an action: the tool call that puts things back. */
export type Undo =
  | { tool: "gmail_organize"; message_ids: string[]; action: string; label?: string }
  | { tool: "calendar_delete_event"; event_id: string }
  | { tool: "calendar_update_event"; event_id: string; start: string; end: string }
  | { tool: "unsnooze"; snooze_id: string }
  | { tool: "gmail_delete_draft"; draft_id: string }
  | { tool: "delete_contact"; contact_id: string }
  | { tool: "restore_event"; copy_id: string }
  | { tool: "trash_drive_file"; file_id: string };

const KEEP_DAYS = 90;
// Undo is offered for a week; after that the mail or event has likely moved on.
const UNDO_DAYS = 7;

type Input = Record<string, unknown>;
const str = (v: unknown, max = 80) => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
const when = (v: unknown, timeZone: string) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(t);
};

// An all-day event's date, as the user wrote it: no time zone shift.
const day = (v: unknown) => {
  const t = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T12:00:00Z`) : NaN;
  return Number.isNaN(t) ? "" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(t);
};

const ORGANIZE: Record<string, string> = {
  archive: "Archived",
  move_to_inbox: "Moved back to the inbox",
  mark_read: "Marked as read",
  mark_unread: "Marked as unread",
  star: "Starred",
  unstar: "Unstarred",
};

/** A one-line description of a tool call that acts on the user's accounts, or null for one that only reads or is internal. */
export function describeAction(name: string, input: Input, timeZone = "UTC"): string | null {
  switch (name) {
    case "gmail_create_draft":
      return `Saved a draft to ${str(input.to, 60)}${str(input.subject) ? `: "${str(input.subject)}"` : ""}`;
    case "gmail_organize": {
      const n = Array.isArray(input.message_ids) ? input.message_ids.length : 0;
      const emails = `${n} email${n === 1 ? "" : "s"}`;
      if (input.action === "add_label") return `Labelled ${emails} "${str(input.label)}"`;
      if (input.action === "remove_label") return `Removed the label "${str(input.label)}" from ${emails}`;
      return `${ORGANIZE[String(input.action)] ?? "Changed"} ${emails}`;
    }
    case "drive_create_doc":
      return `Made the Google Doc "${str(input.title)}"`;
    case "contacts_save":
      return input.contact_id ? "Updated a contact" : `Saved ${str(input.name)} to your contacts`;
    case "calendar_create_event": {
      const on = input.all_day ? day(input.start) : when(input.start, timeZone);
      const freq = (input.repeat as { frequency?: unknown } | undefined)?.frequency;
      const repeats = typeof freq === "string" && ["daily", "weekly", "monthly", "yearly"].includes(freq) ? `, repeating ${freq}` : "";
      return `Added "${str(input.summary)}" to your calendar${on ? ` for ${on}` : ""}${repeats}`;
    }
    case "calendar_update_event":
      return input.start
        ? `Moved ${input.summary ? `"${str(input.summary)}"` : "an event"} to ${when(input.start, timeZone)}`
        : `Changed ${input.summary ? `an event to "${str(input.summary)}"` : "an event"}`;
    case "calendar_delete_event":
      return "Deleted an event from your calendar";
    case "calendar_respond_to_event":
      return `Replied ${input.response === "accepted" ? "yes" : input.response === "declined" ? "no" : "maybe"} to an invitation`;
    case "gmail_snooze": {
      const n = Array.isArray(input.message_ids) ? input.message_ids.length : 0;
      return `Snoozed ${n} email${n === 1 ? "" : "s"}${when(input.until, timeZone) ? ` until ${when(input.until, timeZone)}` : ""}`;
    }
    case "start_task":
      return `Started a background task: ${str(input.summary) || str(input.instructions)}`;
    case "continue_task":
      return `Sent a background task more instructions: ${str(input.instructions)}`;
    case "cancel_task":
      return "Stopped a background task";
    default:
      return null;
  }
}

const INVERSE: Record<string, string> = {
  archive: "move_to_inbox",
  move_to_inbox: "archive",
  mark_read: "mark_unread",
  mark_unread: "mark_read",
  star: "unstar",
  unstar: "star",
  add_label: "remove_label",
  remove_label: "add_label",
};

/** The reverse of an account action, from its input and the tool's answer; null when it can't be undone from here. */
export function undoFor(name: string, input: Input, result: string): Undo | null {
  switch (name) {
    case "gmail_organize": {
      const ids = Array.isArray(input.message_ids) ? input.message_ids.filter((x): x is string => typeof x === "string") : [];
      const action = INVERSE[String(input.action)];
      if (!ids.length || !action) return null;
      if (!action.endsWith("_label")) return { tool: "gmail_organize", message_ids: ids, action };
      return typeof input.label === "string" ? { tool: "gmail_organize", message_ids: ids, action, label: input.label } : null;
    }
    case "calendar_delete_event": {
      const id = result.match(/^Event deleted \(undo ([0-9a-f-]{36})\)/)?.[1];
      return id ? { tool: "restore_event", copy_id: id } : null;
    }
    case "drive_create_doc": {
      const id = result.match(/^Created the Google Doc \(id ([\w-]{10,200})\)/)?.[1];
      return id ? { tool: "trash_drive_file", file_id: id } : null;
    }
    case "contacts_save": {
      const id = result.match(/^Saved a new contact \(id (people\/c?\d+)\)/)?.[1];
      return id ? { tool: "delete_contact", contact_id: id } : null;
    }
    case "gmail_create_draft": {
      const id = result.match(/^Draft (\S+) saved in Gmail/)?.[1];
      return id ? { tool: "gmail_delete_draft", draft_id: id } : null;
    }
    case "calendar_create_event": {
      const id = result.match(/^Event created \(id ([^)\s]+)\)/)?.[1];
      return id ? { tool: "calendar_delete_event", event_id: id } : null;
    }
    case "calendar_update_event": {
      const was = result.match(/^Event updated \(it was (\S+) to (\S+)\)/);
      return was && typeof input.event_id === "string" ? { tool: "calendar_update_event", event_id: input.event_id, start: was[1], end: was[2] } : null;
    }
    case "calendar_update_event": {
      const was = result.match(/^Event updated \(it was (\S+) to (\S+)\)/);
      return was && typeof input.event_id === "string" ? { tool: "calendar_update_event", event_id: input.event_id, start: was[1], end: was[2] } : null;
    }
    case "gmail_snooze": {
      const id = result.match(/^Snoozed ([0-9a-f-]{36}):/)?.[1];
      return id ? { tool: "unsnooze", snooze_id: id } : null;
    }
    default:
      return null;
  }
}

export async function recordActivity(userId: string, conversationId: string | null, entries: { kind: string; summary: string; undo?: Undo | null }[]) {
  if (entries.length === 0) return;
  await query(
    `INSERT INTO activity (user_id, conversation_id, kind, summary, undo)
     SELECT $1, $2, k, s, u::jsonb FROM unnest($3::text[], $4::text[], $5::text[]) AS e(k, s, u)`,
    [userId, conversationId, entries.map((e) => e.kind), entries.map((e) => e.summary), entries.map((e) => (e.undo ? JSON.stringify(e.undo) : null))],
  );
  await query(`DELETE FROM activity WHERE user_id = $1 AND created_at < now() - interval '${KEEP_DAYS} days'`, [userId]);
}

export async function recentActivity(userId: string, limit = 50): Promise<Activity[]> {
  return query<Activity>(
    `SELECT id::text, conversation_id, kind, summary, created_at,
       (undo IS NOT NULL AND undone_at IS NULL AND created_at > now() - interval '${UNDO_DAYS} days') AS can_undo,
       undone_at IS NOT NULL AS undone
     FROM activity WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit],
  );
}

/**
 * Reverses an entry with `run`, once. Returns false when there's nothing to undo (unknown,
 * already undone, too old). If `run` fails, the entry can be undone again later.
 */
export async function undoActivity(userId: string, id: string, run: (undo: Undo) => Promise<void>) {
  if (!/^\d{1,18}$/.test(id)) return false;
  const [entry] = await query<{ summary: string; undo: Undo; conversation_id: string | null }>(
    `UPDATE activity SET undone_at = now()
     WHERE id = $1 AND user_id = $2 AND undo IS NOT NULL AND undone_at IS NULL AND created_at > now() - interval '${UNDO_DAYS} days'
     RETURNING summary, undo, conversation_id`,
    [id, userId],
  );
  if (!entry) return false;
  try {
    await run(entry.undo);
  } catch (err) {
    await query("UPDATE activity SET undone_at = NULL WHERE id = $1", [id]);
    throw err;
  }
  await recordActivity(userId, entry.conversation_id, [{ kind: "undo", summary: `Undid: ${entry.summary}` }]);
  return true;
}
