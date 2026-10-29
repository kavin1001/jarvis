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
}

const KEEP_DAYS = 90;

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
      return `${ORGANIZE[String(input.action)] ?? "Changed"} ${n} email${n === 1 ? "" : "s"}`;
    }
    case "calendar_create_event":
      return `Added "${str(input.summary)}" to your calendar${when(input.start, timeZone) ? ` for ${when(input.start, timeZone)}` : ""}`;
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

export async function recordActivity(userId: string, conversationId: string | null, entries: { kind: string; summary: string }[]) {
  if (entries.length === 0) return;
  await query(
    `INSERT INTO activity (user_id, conversation_id, kind, summary)
     SELECT $1, $2, k, s FROM unnest($3::text[], $4::text[]) AS u(k, s)`,
    [userId, conversationId, entries.map((e) => e.kind), entries.map((e) => e.summary)],
  );
  await query(`DELETE FROM activity WHERE user_id = $1 AND created_at < now() - interval '${KEEP_DAYS} days'`, [userId]);
}

export async function recentActivity(userId: string, limit = 50): Promise<Activity[]> {
  return query<Activity>(
    "SELECT id::text, conversation_id, kind, summary, created_at FROM activity WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [userId, limit],
  );
}
