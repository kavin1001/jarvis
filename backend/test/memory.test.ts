import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
import * as memory from "../src/memory.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

describe("memory", () => {
  it("returns API history without task updates, in order", async () => {
    const id = await memory.createConversation("me");
    await memory.appendMessage(id, "user", [{ type: "text", text: "hi" }], "hi");
    await memory.appendMessage(id, "assistant", [{ type: "text", text: "hello" }], "hello");
    await memory.appendMessage(id, "assistant", [{ type: "text", text: "done" }], "Task done", "system", "task_update");

    const history = await memory.getApiHistory(id);
    expect(history).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("hands out each pending task update once", async () => {
    const id = await memory.createConversation("me");
    await memory.appendMessage(id, "assistant", [{ type: "text", text: "x" }], "Task finished", "system", "task_update");
    expect(await memory.takePendingTaskUpdates(id)).toEqual(["Task finished"]);
    expect(await memory.takePendingTaskUpdates(id)).toEqual([]);
  });

  it("titles a conversation from its first message", async () => {
    const id = await memory.createConversation("me");
    await memory.appendMessage(id, "user", [{ type: "text", text: "Plan my trip" }], "Plan my trip");
    await memory.appendMessage(id, "user", [{ type: "text", text: "later" }], "later");
    const [conv] = await memory.listConversations("me");
    expect(conv.title).toBe("Plan my trip");
  });

  it("adds and deletes facts per user", async () => {
    const factId = await memory.addFact("me", "Prefers aisle seats");
    expect(await memory.listFacts("me")).toEqual([{ id: factId, fact: "Prefers aisle seats" }]);
    expect(await memory.deleteFact("someone-else", factId)).toBe(false);
    expect(await memory.deleteFact("me", factId)).toBe(true);
    expect(await memory.listFacts("me")).toEqual([]);
  });
});

describe("searchMessages", () => {
  it("finds past messages by keyword and can skip the current chat", async () => {
    const old = await memory.createConversation("me");
    const current = await memory.createConversation("me");
    await memory.appendMessage(old, "user", [{ type: "text", text: "x" }], "Find me a sushi restaurant in Austin", "text");
    await memory.appendMessage(old, "assistant", [{ type: "text", text: "x" }], "Uchi on South Lamar is a great sushi spot.", "text");
    await memory.appendMessage(current, "user", [{ type: "text", text: "x" }], "what was that sushi place?", "text");
    await memory.appendMessage(old, "user", [{ type: "text", text: "x" }], null, "system"); // tool plumbing is skipped

    const all = await memory.searchMessages("me", "sushi");
    expect(all).toHaveLength(3);
    const elsewhere = await memory.searchMessages("me", "sushi", { excludeConversationId: current });
    expect(elsewhere.map((h) => h.conversation_id)).toEqual([old, old]);
    expect(elsewhere.some((h) => h.snippet.includes("«sushi»"))).toBe(true);
    expect(await memory.searchMessages("me", "pizza")).toEqual([]);
    expect(await memory.searchMessages("someone-else", "sushi")).toEqual([]);
  });
});
