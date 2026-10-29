import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import { countOldChats, getChatRetention, setChatRetention, sweepOldChats } from "../src/retention.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const ageChat = (id: string, days: number) => query("UPDATE conversations SET updated_at = now() - make_interval(days => $2) WHERE id = $1", [id, days]);

describe("chat retention", () => {
  it("keeps chats for good until a retention is set, then deletes old ones except pinned and busy chats", async () => {
    const recent = await memory.createConversation("me");
    const old = await memory.createConversation("me");
    const pinned = await memory.createConversation("me");
    const busy = await memory.createConversation("me");
    const theirs = await memory.createConversation("someone-else");
    await memory.appendMessage(old, "user", [{ type: "text", text: "old news" }], "old news");
    for (const id of [old, pinned, busy, theirs]) await ageChat(id, 120);
    await query("UPDATE conversations SET pinned = true WHERE id = $1", [pinned]);
    await query("INSERT INTO tasks (user_id, conversation_id, instructions, status) VALUES ('me', $1, 'x', 'running')", [busy]);

    expect(await getChatRetention("me")).toBeNull();
    expect(await sweepOldChats()).toBe(0);
    expect(await countOldChats("me", 90)).toBe(1);
    expect(await countOldChats("me", 365)).toBe(0);

    await setChatRetention("me", 90);
    expect(await sweepOldChats()).toBe(1);
    const left = (await memory.listConversations("me")).map((c) => c.id).sort();
    expect(left).toEqual([recent, pinned, busy].sort());
    expect((await query("SELECT 1 FROM messages WHERE conversation_id = $1", [old])).length).toBe(0);
    expect(await memory.listConversations("someone-else")).toHaveLength(1);
  });

  it("previews and changes the setting over the API", async () => {
    const old = await memory.createConversation("me");
    await ageChat(old, 40);
    const json = { ...auth, "Content-Type": "application/json" };
    expect(await (await app.request("/api/privacy?preview=30", { headers: auth })).json()).toEqual({ chat_retention_days: null, would_delete: 1 });
    expect((await app.request("/api/privacy", { method: "PATCH", headers: json, body: JSON.stringify({ chat_retention_days: 7 }) })).status).toBe(400);
    const set = await app.request("/api/privacy", { method: "PATCH", headers: json, body: JSON.stringify({ chat_retention_days: 30 }) });
    expect(await set.json()).toEqual({ chat_retention_days: 30, deleted: 1 });
    const off = await app.request("/api/privacy", { method: "PATCH", headers: json, body: JSON.stringify({ chat_retention_days: null }) });
    expect(await off.json()).toEqual({ chat_retention_days: null, deleted: 0 });
  });
});
