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
export type NotifySettings = Record<Topic, boolean>;

export async function getNotifySettings(userId: string): Promise<NotifySettings> {
  const [row] = await query<NotifySettings>("SELECT replies, tasks, spending FROM notify_settings WHERE user_id = $1", [userId]);
  return row ?? { replies: true, tasks: true, spending: true };
}

export async function setNotifySettings(userId: string, change: Partial<NotifySettings>) {
  const next = { ...(await getNotifySettings(userId)), ...change };
  await query(
    `INSERT INTO notify_settings (user_id, replies, tasks, spending) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET replies = $2, tasks = $3, spending = $4`,
    [userId, next.replies, next.tasks, next.spending],
  );
  return next;
}

/** Sends through Expo's push service, which forwards to APNs and FCM. */
export async function sendPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  /**
   * An app-registered category: "approval" (Approve/Deny), "reminder" (Snooze) or
   * "reply" (answer Jarvis from the notification).
   */
  categoryId?: string,
  /** Skipped when the user turned this kind of notification off in Settings. */
  topic?: Topic,
) {
  if (topic && !(await getNotifySettings(userId))[topic]) return;
  const tokens = await query<{ token: string }>("SELECT token FROM push_tokens WHERE user_id = $1", [
    userId,
  ]);
  if (tokens.length === 0) return;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      tokens.map((t) => ({ to: t.token, title, body: body.slice(0, 180), data, sound: "default", ...(categoryId ? { categoryId } : {}) })),
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
