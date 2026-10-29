import { query } from "./db.js";
import { disconnectGoogle } from "./google.js";
import { deleteTaskFiles } from "./tasks.js";

/** Everything Jarvis keeps about the user, as plain JSON. Secrets (tokens, keys) are left out. */
export async function exportData(userId: string) {
  const conversations = await query<{ id: string; title: string | null; created_at: string }>(
    "SELECT id, title, created_at FROM conversations WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  const messages = await query<{ conversation_id: string; role: string; kind: string; text: string; source: string; created_at: string }>(
    `SELECT m.conversation_id, m.role, m.kind, m.display_text AS text, m.source, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1 AND m.display_text IS NOT NULL ORDER BY m.id`,
    [userId],
  );
  const byConversation = new Map<string, typeof messages>();
  for (const m of messages) byConversation.set(m.conversation_id, [...(byConversation.get(m.conversation_id) ?? []), m]);

  return {
    exported_at: new Date().toISOString(),
    conversations: conversations.map((c) => ({
      ...c,
      messages: (byConversation.get(c.id) ?? []).map(({ conversation_id: _, ...m }) => m),
    })),
    facts: await query("SELECT fact, created_at FROM facts WHERE user_id = $1 ORDER BY created_at", [userId]),
    reminders: await query("SELECT text, action, due_at, repeat, status FROM reminders WHERE user_id = $1 ORDER BY due_at", [userId]),
    places: await query("SELECT name, latitude, longitude FROM places WHERE user_id = $1 ORDER BY name", [userId]),
    place_reminders: await query(
      "SELECT text, place_name, on_event, every_time, status, created_at FROM place_reminders WHERE user_id = $1 ORDER BY created_at",
      [userId],
    ),
    notes: await query("SELECT title, body, created_at, updated_at FROM notes WHERE user_id = $1 ORDER BY created_at", [userId]),
    lists: await query("SELECT list, text, done, created_at FROM list_items WHERE user_id = $1 ORDER BY list, created_at", [userId]),
    tasks: await query(
      "SELECT summary, instructions, status, result, cost_usd::float AS cost_usd, created_at FROM tasks WHERE user_id = $1 ORDER BY created_at",
      [userId],
    ),
    connected_apps: await query("SELECT name, url, enabled FROM mcp_servers WHERE user_id = $1 ORDER BY name", [userId]),
    google: (await query<{ account_email: string | null }>("SELECT account_email FROM connectors WHERE user_id = $1 AND provider = 'google'", [userId]))[0] ?? null,
  };
}

/**
 * Deletes conversations, memory, lists, places, reminders, tasks and their files, and connectors (revoking Google).
 * Devices, push tokens and usage history stay, so the phone stays signed in and spend stays accurate.
 */
export async function deleteAllData(userId: string) {
  await disconnectGoogle(userId).catch(() => {});
  await deleteTaskFiles(userId).catch(() => {});
  await query("DELETE FROM reminders WHERE user_id = $1", [userId]);
  await query("DELETE FROM conversations WHERE user_id = $1", [userId]); // cascades to messages, tasks, approvals
  await query("DELETE FROM facts WHERE user_id = $1", [userId]);
  await query("DELETE FROM list_items WHERE user_id = $1", [userId]);
  await query("DELETE FROM notes WHERE user_id = $1", [userId]);
  await query("DELETE FROM place_reminders WHERE user_id = $1", [userId]);
  await query("DELETE FROM places WHERE user_id = $1", [userId]);
  await query("DELETE FROM mcp_servers WHERE user_id = $1", [userId]);
  await query("DELETE FROM connectors WHERE user_id = $1", [userId]);
}
