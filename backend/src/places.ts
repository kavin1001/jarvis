import { query } from "./db.js";
import * as memory from "./memory.js";
import { sendPush } from "./push.js";

/**
 * Saved places and reminders that go off on arriving at or leaving one. The phone
 * does the watching (geofences); the server keeps the list and sends the reminder.
 */

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
}

// The app sends a precise spot; chat only has the approximate location (about 1 km).
export const PRECISE_RADIUS_M = 150;
export const APPROXIMATE_RADIUS_M = 1000;

export interface PlaceReminder {
  id: string;
  conversation_id: string | null;
  text: string;
  place_name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  on_event: "arrive" | "leave";
  every_time: boolean;
  status: "active" | "done" | "cancelled";
  last_fired_at: string | null;
  created_at: string;
}

// Phones watch a limited number of areas at once (iOS: 20 for each app).
export const MAX_ACTIVE = 20;
// Geofences can flicker at the edge; don't repeat an every-time reminder within this window.
const REFIRE_MS = 10 * 60_000;
const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export const placeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

export async function savePlace(userId: string, place: Place) {
  await query(
    `INSERT INTO places (user_id, name, latitude, longitude, radius_m) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, name) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, radius_m = EXCLUDED.radius_m, created_at = now()`,
    [userId, placeName(place.name), place.latitude, place.longitude, place.radius_m],
  );
}

export async function listPlaces(userId: string) {
  return query<Place>("SELECT name, latitude, longitude, radius_m FROM places WHERE user_id = $1 ORDER BY name", [userId]);
}

export async function getPlace(userId: string, name: string) {
  const [p] = await query<Place>("SELECT name, latitude, longitude, radius_m FROM places WHERE user_id = $1 AND name = $2", [userId, placeName(name)]);
  return p ?? null;
}

export async function deletePlace(userId: string, name: string) {
  return (await query("DELETE FROM places WHERE user_id = $1 AND name = $2 RETURNING name", [userId, placeName(name)])).length > 0;
}

export async function createPlaceReminder(r: {
  userId: string;
  conversationId: string | null;
  text: string;
  place: Place;
  on: "arrive" | "leave";
  everyTime: boolean;
}) {
  const [{ count }] = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM place_reminders WHERE user_id = $1 AND status = 'active'",
    [r.userId],
  );
  if (count >= MAX_ACTIVE) throw new Error(`A phone can watch at most ${MAX_ACTIVE} places at once. Cancel a place reminder first.`);
  const [row] = await query<{ id: string }>(
    `INSERT INTO place_reminders (user_id, conversation_id, text, place_name, latitude, longitude, radius_m, on_event, every_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [r.userId, r.conversationId, r.text, placeName(r.place.name), r.place.latitude, r.place.longitude, r.place.radius_m, r.on, r.everyTime],
  );
  return row.id;
}

export async function listPlaceReminders(userId: string) {
  return query<PlaceReminder>(
    "SELECT * FROM place_reminders WHERE user_id = $1 AND status = 'active' ORDER BY created_at",
    [userId],
  );
}

export async function cancelPlaceReminder(userId: string, id: string) {
  if (!idOk(id)) return false;
  const rows = await query(
    "UPDATE place_reminders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id",
    [id, userId],
  );
  return rows.length > 0;
}

/** "when you get home", "when you leave work". */
export function describePlaceReminder(r: Pick<PlaceReminder, "on_event" | "place_name" | "every_time">) {
  const arrive = r.place_name === "home" ? "get home" : `get to ${r.place_name}`;
  return `${r.every_time ? "every time" : "when"} you ${r.on_event === "arrive" ? arrive : `leave ${r.place_name}`}`;
}

/**
 * The phone saw the user arrive at or leave a watched area. Sends the reminder if the
 * event is the one it waits for; a one-off one is claimed in the same statement, so a
 * repeated event from the phone can't send it twice.
 */
export async function triggerPlaceReminder(userId: string, id: string, event: "arrive" | "leave", now = new Date()) {
  if (!idOk(id)) return "not_found" as const;
  const [r] = await query<PlaceReminder>(
    `UPDATE place_reminders SET last_fired_at = $4, status = CASE WHEN every_time THEN status ELSE 'done' END
     WHERE id = $1 AND user_id = $2 AND status = 'active' AND on_event = $3
       AND (last_fired_at IS NULL OR last_fired_at < $5)
     RETURNING *`,
    [id, userId, event, now, new Date(now.getTime() - REFIRE_MS)],
  );
  if (!r) {
    const exists = await query("SELECT 1 FROM place_reminders WHERE id = $1 AND user_id = $2", [id, userId]);
    return exists.length ? ("ignored" as const) : ("not_found" as const);
  }
  const conversationId = r.conversation_id ?? (await memory.createConversation(userId));
  const text = `Reminder: ${r.text}`;
  await memory.appendMessage(conversationId, "assistant", [{ type: "text", text }], text, "system", "task_update");
  const where = r.place_name === "home" ? "home" : r.place_name;
  const title = r.on_event === "arrive" ? `Arrived ${r.place_name === "home" ? "home" : `at ${where}`}` : `Leaving ${where}`;
  await sendPush(userId, title, r.text, { conversationId }, undefined, undefined, undefined, true);
  return "sent" as const;
}
