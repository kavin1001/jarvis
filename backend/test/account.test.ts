import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

describe("export and delete", () => {
  it("exports conversations and facts, then erases them on confirm", async () => {
    const id = await memory.createConversation("me");
    await memory.appendMessage(id, "user", [{ type: "text", text: "hi" }], "hi");
    await memory.appendMessage(id, "user", [{ type: "text", text: "x" }], null, "system");
    await memory.addFact("me", "Likes tea");
    process.env.CONNECTOR_SECRET = "s";
    await app.request("/api/mcp-servers", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gh", url: "https://mcp.example.com", token: "secret-token-value" }),
    });

    const res = await app.request("/api/export", { headers: auth });
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="jarvis-export-/);
    const data = await res.json();
    expect(data.conversations[0].messages).toMatchObject([{ role: "user", text: "hi" }]);
    expect(data.facts).toMatchObject([{ fact: "Likes tea" }]);
    expect(JSON.stringify(data)).not.toContain("secret-token-value");

    const refused = await app.request("/api/data", { method: "DELETE", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(400);
    const del = await app.request("/api/data", {
      method: "DELETE",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(await del.json()).toEqual({ deleted: true });
    for (const table of ["conversations", "messages", "facts", "mcp_servers"]) {
      expect(await query(`SELECT 1 FROM ${table}`)).toHaveLength(0);
    }
  });
});
