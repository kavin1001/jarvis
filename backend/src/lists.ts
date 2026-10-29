import { query } from "./db.js";

/** Lists the user keeps by voice or in the app ("add milk to my shopping list"). */

export interface ListItem {
  id: string;
  list: string;
  text: string;
  done: boolean;
  created_at: string;
}

const MAX_ITEMS = 500;

/** "Shopping list", " shopping " and "Shopping" are the same list. */
export function listName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+list$/, "")
    .replace(/\s+/g, " ");
}

const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/** Adds items, skipping any already on the list and not yet checked off. Returns the new ones. */
export async function addItems(userId: string, list: string, texts: string[]): Promise<ListItem[]> {
  const name = listName(list);
  const [{ count }] = await query<{ count: number }>("SELECT count(*)::int AS count FROM list_items WHERE user_id = $1", [userId]);
  const open = await query<{ text: string }>("SELECT text FROM list_items WHERE user_id = $1 AND list = $2 AND NOT done", [userId, name]);
  const seen = new Set(open.map((r) => r.text.toLowerCase()));
  const fresh: string[] = [];
  for (const t of texts.map((t) => t.trim()).filter(Boolean)) {
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    fresh.push(t);
  }
  if (count + fresh.length > MAX_ITEMS) throw new Error(`Lists are limited to ${MAX_ITEMS} items in all. Clear some checked-off items first.`);
  if (fresh.length === 0) return [];
  // One statement, with created_at spaced by the order given, so items keep the order they were said in.
  return query<ListItem>(
    `INSERT INTO list_items (user_id, list, text, created_at)
     SELECT $1, $2, t, now() + (n * interval '1 microsecond') FROM unnest($3::text[]) WITH ORDINALITY AS u(t, n)
     RETURNING id, list, text, done, created_at`,
    [userId, name, fresh],
  );
}

/** Every list with its items, unchecked first, each in the order added. */
export async function allLists(userId: string): Promise<{ name: string; items: ListItem[] }[]> {
  const rows = await query<ListItem>(
    "SELECT id, list, text, done, created_at FROM list_items WHERE user_id = $1 ORDER BY list, done, created_at",
    [userId],
  );
  const lists = new Map<string, ListItem[]>();
  for (const r of rows) lists.set(r.list, [...(lists.get(r.list) ?? []), r]);
  return [...lists].map(([name, items]) => ({ name, items }));
}

export async function listItems(userId: string, list: string): Promise<ListItem[]> {
  return query<ListItem>(
    "SELECT id, list, text, done, created_at FROM list_items WHERE user_id = $1 AND list = $2 ORDER BY done, created_at",
    [userId, listName(list)],
  );
}

export async function updateItem(userId: string, id: string, change: { done?: boolean; text?: string }): Promise<ListItem | null> {
  if (!idOk(id)) return null;
  const [row] = await query<ListItem>(
    `UPDATE list_items SET done = COALESCE($3, done), text = COALESCE($4, text)
     WHERE user_id = $1 AND id = $2 RETURNING id, list, text, done, created_at`,
    [userId, id, change.done ?? null, change.text?.trim() ?? null],
  );
  return row ?? null;
}

export async function setDone(userId: string, ids: string[], done: boolean): Promise<number> {
  const valid = ids.filter(idOk);
  if (valid.length === 0) return 0;
  const rows = await query("UPDATE list_items SET done = $3 WHERE user_id = $1 AND id = ANY($2::uuid[]) RETURNING id", [userId, valid, done]);
  return rows.length;
}

export async function removeItems(userId: string, ids: string[]): Promise<number> {
  const valid = ids.filter(idOk);
  if (valid.length === 0) return 0;
  const rows = await query("DELETE FROM list_items WHERE user_id = $1 AND id = ANY($2::uuid[]) RETURNING id", [userId, valid]);
  return rows.length;
}

/** Clears checked-off items from a list, or the whole list when everything is true. */
export async function clearList(userId: string, list: string, everything = false): Promise<number> {
  const rows = await query(
    `DELETE FROM list_items WHERE user_id = $1 AND list = $2 ${everything ? "" : "AND done"} RETURNING id`,
    [userId, listName(list)],
  );
  return rows.length;
}

/** A list as text for Claude: one line per item, with ids to check off or remove. */
export function describeList(name: string, items: ListItem[]) {
  if (items.length === 0) return `The ${name} list is empty.`;
  return `${name}:\n` + items.map((i) => `- [${i.id}] ${i.done ? "(done) " : ""}${i.text}`).join("\n");
}
