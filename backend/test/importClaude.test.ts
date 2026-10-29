import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import { turnsOf } from "../src/importClaude.js";
import * as memory from "../src/memory.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const json = { ...auth, "Content-Type": "application/json" };
const exported = [
  {
    uuid: "c-1",
    name: "Sourdough starter",
    created_at: "2025-03-01T10:00:00Z",
    updated_at: "2025-03-01T10:05:00Z",
    chat_messages: [
      { sender: "assistant", text: "stray greeting", created_at: "2025-03-01T09:59:00Z" },
      { sender: "human", text: "How do I feed a sourdough starter?", content: [{ type: "text", text: "How do I feed a sourdough starter?" }], created_at: "2025-03-01T10:00:00Z" },
      { sender: "assistant", text: "", content: [{ type: "text", text: "Equal parts flour and water" }, { type: "tool_use", name: "x" }, { type: "text", text: "once a day." }], created_at: "2025-03-01T10:01:00Z" },
      { sender: "assistant", text: "Keep it warm.", created_at: "2025-03-01T10:02:00Z" },
      { sender: "human", text: "   ", created_at: "2025-03-01T10:03:00Z" },
    ],
  },
  { uuid: "c-2", name: "", chat_messages: [] },
];

describe("Claude.ai import", () => {
  it("turns an exported chat into alternating text turns", () => {
    const turns = turnsOf(exported[0] as never);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "How do I feed a sourdough starter?"],
      ["assistant", "Equal parts flour and water\n\nonce a day.\n\nKeep it warm."],
    ]);
  });

  it("imports once, keeps dates, and makes the chats searchable and continuable", async () => {
    const post = () => app.request("/api/import/claude", { method: "POST", headers: json, body: JSON.stringify(exported) });
    expect(await (await post()).json()).toEqual({ imported: 1, skipped: 1, messages: 2 });
    expect(await (await post()).json()).toEqual({ imported: 0, skipped: 2, messages: 0 });

    const [chat] = await memory.listConversations("me");
    expect(chat).toMatchObject({ title: "Sourdough starter" });
    expect(new Date(chat.updated_at).toISOString()).toBe("2025-03-01T10:05:00.000Z");
    const history = await memory.getApiHistory(chat.id);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[1].content).toEqual([{ type: "text", text: "Equal parts flour and water\n\nonce a day.\n\nKeep it warm." }]);
    expect((await memory.searchMessages("me", "sourdough", { limit: 5 })).length).toBeGreaterThan(0);

    const bad = await app.request("/api/import/claude", { method: "POST", headers: json, body: JSON.stringify({ not: "an export" }) });
    expect(bad.status).toBe(400);
  });
});
