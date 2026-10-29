import { query } from "./db.js";

export async function savePushToken(userId: string, token: string) {
  await query(
    "INSERT INTO push_tokens (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET user_id = $2",
    [token, userId],
  );
}

/** Sends through Expo's push service, which forwards to APNs and FCM. */
export async function sendPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
) {
  const tokens = await query<{ token: string }>("SELECT token FROM push_tokens WHERE user_id = $1", [
    userId,
  ]);
  if (tokens.length === 0) return;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      tokens.map((t) => ({ to: t.token, title, body: body.slice(0, 180), data, sound: "default" })),
    ),
  });
  if (!response.ok) console.error("push failed", response.status, await response.text());
}
