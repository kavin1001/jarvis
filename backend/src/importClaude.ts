import { z } from "zod";
import { pool } from "./db.js";

/**
 * Imports chats from a Claude.ai data export (Settings, Privacy, Export data: the
 * conversations.json inside the zip), so Jarvis can search and continue them.
 * Only the text comes across; attachments, artifacts and tool calls are left out.
 */

const ExportMessage = z
  .object({
    sender: z.string(),
    text: z.string().nullish(),
    content: z.array(z.object({ type: z.string(), text: z.string().nullish() }).passthrough()).nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
const ExportChat = z
  .object({
    uuid: z.string().min(1).max(100),
    name: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    chat_messages: z.array(ExportMessage).default([]),
  })
  .passthrough();
export const ClaudeExport = z.array(ExportChat).max(20_000);

interface Turn {
  role: "user" | "assistant";
  text: string;
  created_at: string | null;
}

const MAX_TURN_CHARS = 100_000;
const validDate = (d: string | null | undefined) => (d && !Number.isNaN(Date.parse(d)) ? d : null);

/** A chat's turns in order, as text: consecutive turns from one side merged, and none before the first user turn. */
export function turnsOf(chat: z.infer<typeof ExportChat>): Turn[] {
  const turns: Turn[] = [];
  for (const m of chat.chat_messages) {
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const fromBlocks = (m.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n\n");
    const text = (fromBlocks || m.text || "").trim().slice(0, MAX_TURN_CHARS);
    if (!text) continue;
    const last = turns.at(-1);
    if (last?.role === role) last.text = `${last.text}\n\n${text}`.slice(0, MAX_TURN_CHARS);
    else if (turns.length > 0 || role === "user") turns.push({ role, text, created_at: validDate(m.created_at) });
  }
  return turns;
}

/** Imports each chat once; chats already imported (by their export id) are skipped. */
export async function importClaudeChats(userId: string, chats: z.infer<typeof ClaudeExport>) {
  let imported = 0;
  let skipped = 0;
  let messages = 0;
  for (const chat of chats) {
    const turns = turnsOf(chat);
    if (turns.length === 0) {
      skipped++;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = validDate(chat.created_at) ?? turns[0].created_at ?? new Date().toISOString();
      const updated = validDate(chat.updated_at) ?? turns.at(-1)!.created_at ?? created;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO conversations (user_id, title, created_at, updated_at, import_ref)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, import_ref) WHERE import_ref IS NOT NULL DO NOTHING RETURNING id`,
        [userId, chat.name?.trim().slice(0, 200) || null, created, updated, `claude:${chat.uuid}`],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        skipped++;
        continue;
      }
      // Each turn is stored as the content blocks Claude would see, so the chat can be continued.
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, display_text, source, created_at)
         SELECT $1, r, jsonb_build_array(jsonb_build_object('type', 'text', 'text', t)), t, 'text', COALESCE(c, $5::timestamptz)
         FROM unnest($2::text[], $3::text[], $4::timestamptz[]) WITH ORDINALITY AS u(r, t, c, n) ORDER BY n`,
        [rows[0].id, turns.map((t) => t.role), turns.map((t) => t.text), turns.map((t) => t.created_at), created],
      );
      await client.query("COMMIT");
      imported++;
      messages += turns.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return { imported, skipped, messages };
}
