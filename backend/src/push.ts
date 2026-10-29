import { query } from "./db.js";

export async function savePushToken(userId: string, token: string) {
  await query(
    "INSERT INTO push_tokens (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET user_id = $2",
    [token, userId],
  );
}

/** Notifications the user can turn off. Approvals and reminders can't be, since they're the point. */
export const TOPICS = ["replies", "tasks", "spending"] as const;
export type Topic = (typeof TOPICS)[number];
export type NotifySettings = Record<Topic, boolean> & {
  /** Quiet hours in minutes after local midnight, or null when off. They can wrap past midnight (22:00 to 07:00). */
  quiet_start: number | null;
  quiet_end: number | null;
};

export async function getNotifySettings(userId: string): Promise<NotifySettings> {
  const [row] = await query<NotifySettings>("SELECT replies, tasks, spending, quiet_start, quiet_end FROM notify_settings WHERE user_id = $1", [userId]);
  return row ?? { replies: true, tasks: true, spending: true, quiet_start: null, quiet_end: null };
}

export async function setNotifySettings(userId: string, change: Partial<NotifySettings>) {
  const next = { ...(await getNotifySettings(userId)), ...change };
  await query(
    `INSERT INTO notify_settings (user_id, replies, tasks, spending, quiet_start, quiet_end) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET replies = $2, tasks = $3, spending = $4, quiet_start = $5, quiet_end = $6`,
    [userId, next.replies, next.tasks, next.spending, next.quiet_start, next.quiet_end],
  );
  return next;
}

/** Whether `now` falls in the user's quiet hours, in their time zone. */
export function isQuiet(s: Pick<NotifySettings, "quiet_start" | "quiet_end">, timeZone: string, now = new Date()) {
  const { quiet_start: start, quiet_end: end } = s;
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const minutes = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Sends through Expo's push service, which forwards to APNs and FCM. */
export async function sendPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  /**
   * An app-registered category: "approval" (Approve/Deny), "reminder" (Snooze), "nag" (Done and Snooze) or
   * "reply" (answer Jarvis from the notification).
   */
  categoryId?: string,
  /** Skipped when the user turned this kind of notification off in Settings. */
  topic?: Topic,
  /** The number on the app icon (iOS); left as it is when not given. */
  badge?: number,
  /** Plays a sound even in quiet hours: reminders and routines the user set for that time. */
  ring = false,
) {
  const prefs = await getNotifySettings(userId);
  if (topic && !prefs[topic]) return;
  const tokens = await query<{ token: string }>("SELECT token FROM push_tokens WHERE user_id = $1", [
    userId,
  ]);
  if (tokens.length === 0) return;
  let quiet = false;
  if (!ring && prefs.quiet_start !== null) {
    const [row] = await query<{ timezone: string }>("SELECT timezone FROM user_settings WHERE user_id = $1", [userId]);
    quiet = isQuiet(prefs, row?.timezone ?? "UTC");
  }
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      tokens.map((t) => ({
        to: t.token,
        title,
        body: body.slice(0, 180),
        data,
        // In quiet hours it still arrives, just silently: without lighting up the screen on iOS, and on the app's
        // silent channel on Android.
        ...(quiet ? { interruptionLevel: "passive", channelId: "quiet" } : { sound: "default" }),
        ...(categoryId ? { categoryId } : {}),
        ...(badge === undefined ? {} : { badge }),
      })),
    ),
  });
  if (!response.ok) return console.error("push failed", response.status, await response.text());
  // Tickets come back in the same order; forget phones that uninstalled the app.
  const { data: tickets = [] } = (await response.json().catch(() => ({}))) as {
    data?: { status: string; details?: { error?: string } }[];
  };
  const dead = tokens.filter((_, i) => tickets[i]?.details?.error === "DeviceNotRegistered").map((t) => t.token);
  if (dead.length) await query("DELETE FROM push_tokens WHERE token = ANY($1)", [dead]);
}
