import { query } from "./db.js";

/** Notes the user takes by voice ("take a note: the wifi password is …") or saves from a reply. */

export interface Note {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const MAX_NOTES = 1000;
export const MAX_BODY = 20_000;

const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/** The first line of the body, shortened, when no title is given. */
export function titleFor(body: string) {
  const first = body.trim().split("\n")[0].replace(/^#+\s*/, "").trim();
  // "Gate code 4821. Parking on level 2." is titled by its first sentence.
  const sentence = first.match(/^(.{8,}?[.!?])\s/)?.[1];
  const line = sentence ?? first;
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line || "Note";
}

export async function createNote(userId: string, body: string, title?: string): Promise<Note> {
  const [{ count }] = await query<{ count: number }>("SELECT count(*)::int AS count FROM notes WHERE user_id = $1", [userId]);
  if (count >= MAX_NOTES) throw new Error(`Notes are limited to ${MAX_NOTES}. Delete some old ones first.`);
  const [row] = await query<Note>(
    "INSERT INTO notes (user_id, title, body) VALUES ($1, $2, $3) RETURNING id, title, body, created_at, updated_at",
    [userId, title?.trim() || titleFor(body), body.trim()],
  );
  return row;
}

/** Changes the title or body; with append, adds the text on a new line instead of replacing the body. */
export async function updateNote(
  userId: string,
  id: string,
  change: { title?: string; body?: string; append?: boolean },
): Promise<Note | null> {
  if (!idOk(id)) return null;
  const body = change.body?.trim() ?? null;
  const [row] = await query<Note>(
    `UPDATE notes SET
       title = COALESCE($3, title),
       body = CASE WHEN $4::text IS NULL THEN body WHEN $5 THEN left(body || E'\\n' || $4, ${MAX_BODY}) ELSE $4 END,
       updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING id, title, body, created_at, updated_at`,
    [userId, id, change.title?.trim() || null, body, change.append ?? false],
  );
  return row ?? null;
}

export async function deleteNote(userId: string, id: string): Promise<boolean> {
  if (!idOk(id)) return false;
  return (await query("DELETE FROM notes WHERE user_id = $1 AND id = $2 RETURNING id", [userId, id])).length > 0;
}

export async function getNote(userId: string, id: string): Promise<Note | null> {
  if (!idOk(id)) return null;
  const [row] = await query<Note>("SELECT id, title, body, created_at, updated_at FROM notes WHERE user_id = $1 AND id = $2", [userId, id]);
  return row ?? null;
}

/**
 * Newest first. With a search, notes whose title or body contains every word,
 * titles that match ranked above bodies that do.
 */
export async function findNotes(userId: string, search = "", limit = 100): Promise<Note[]> {
  const words = search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((w) => `%${w.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`);
  return query<Note>(
    `SELECT id, title, body, created_at, updated_at FROM notes
     WHERE user_id = $1 AND (SELECT bool_and(lower(title || ' ' || body) LIKE w) FROM unnest($2::text[]) AS w) IS NOT FALSE
     ORDER BY (SELECT count(*) FROM unnest($2::text[]) AS w WHERE lower(title) LIKE w) DESC, updated_at DESC
     LIMIT $3`,
    [userId, words, limit],
  );
}

/** One line per note for Claude, with a snippet of the body. */
export function describeNotes(notes: Note[]) {
  return notes
    .map((n) => {
      const snippet = n.body.replace(/\s+/g, " ").slice(0, 160);
      return `- [${n.id}] ${n.title} (${new Date(n.updated_at).toISOString().slice(0, 10)}): ${snippet}${n.body.length > 160 ? "…" : ""}`;
    })
    .join("\n");
}
