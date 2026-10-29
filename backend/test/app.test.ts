import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

describe("HTTP API", () => {
  it("serves health without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("rejects requests without the app token", async () => {
    expect((await app.request("/api/facts")).status).toBe(401);
    expect((await app.request("/api/facts", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("limits failed sign-ins per address, counting the address the proxy added", async () => {
    const from = (xff: string, token = "wrong") => app.request("/api/facts", { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": xff } });
    // A client-supplied first entry doesn't give a fresh address each time.
    for (let i = 0; i < 20; i++) expect((await from(`10.0.0.${i}, 203.0.113.7`)).status).toBe(401);
    expect((await from("10.9.9.9, 203.0.113.7")).status).toBe(429);
    expect((await from("203.0.113.7", "test-token")).status).toBe(429);
    expect((await from("198.51.100.1", "test-token")).status).toBe(200);
  });

  it("sends security headers", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("validates chat bodies", async () => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown conversation", async () => {
    const res = await app.request("/api/conversations/00000000-0000-0000-0000-000000000000/messages", {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("404s an unknown approval", async () => {
    const res = await app.request("/api/approvals/00000000-0000-0000-0000-000000000000", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("facts and conversations", () => {
  it("adds a fact by hand and deletes a conversation", async () => {
    const json = { ...auth, "Content-Type": "application/json" };
    const added = await app.request("/api/facts", { method: "POST", headers: json, body: JSON.stringify({ fact: "Vegetarian" }) });
    const { id: factId } = (await added.json()) as { id: string };
    const edit = (id: string, fact: string) =>
      app.request(`/api/facts/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ fact }) });
    expect((await edit(factId, "Vegan")).status).toBe(200);
    expect(await (await app.request("/api/facts", { headers: auth })).json()).toMatchObject([{ id: factId, fact: "Vegan" }]);
    expect((await edit(factId, "")).status).toBe(400);
    expect((await edit("999999", "Vegan")).status).toBe(404);
    expect((await edit("not-a-number", "Vegan")).status).toBe(404);
    expect(await (await app.request("/api/facts/nope", { method: "DELETE", headers: auth })).json()).toEqual({ deleted: false });

    const { createConversation, listConversations } = await import("../src/memory.js");
    const id = await createConversation("me");
    const res = await app.request(`/api/conversations/${id}`, { method: "DELETE", headers: auth });
    expect(await res.json()).toEqual({ deleted: true });
    expect(await listConversations("me")).toEqual([]);
  });
});

describe("snoozing a reminder", () => {
  const json = { ...auth, "Content-Type": "application/json" };
  it("validates minutes and 404s unknown ids", async () => {
    const snooze = (id: string, minutes: unknown) =>
      app.request(`/api/reminders/${id}/snooze`, { method: "POST", headers: json, body: JSON.stringify({ minutes }) });
    expect((await snooze("00000000-0000-0000-0000-000000000000", 10)).status).toBe(404);
    expect((await snooze("not-a-uuid", 10)).status).toBe(404);
    expect((await snooze("00000000-0000-0000-0000-000000000000", 0)).status).toBe(400);
  });
});

describe("renaming a conversation", () => {
  const json = { ...auth, "Content-Type": "application/json" };
  it("sets the title, rejects an empty one, and 404s for unknown ids", async () => {
    const { createConversation, listConversations } = await import("../src/memory.js");
    const id = await createConversation("me");
    const rename = (cid: string, title: string) =>
      app.request(`/api/conversations/${cid}`, { method: "PATCH", headers: json, body: JSON.stringify({ title }) });
    expect(await (await rename(id, "  Trip to Lisbon ")).json()).toEqual({ id, title: "Trip to Lisbon" });
    expect((await listConversations("me"))[0].title).toBe("Trip to Lisbon");
    expect((await rename(id, "   ")).status).toBe(400);
    expect((await rename("00000000-0000-0000-0000-000000000000", "x")).status).toBe(404);
  });

  it("pages through older chats and 404s malformed ids", async () => {
    const { createConversation } = await import("../src/memory.js");
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) ids.push(await createConversation("me"));
    // Same timestamp for a run of chats, so the id has to break the tie.
    await pool.query("UPDATE conversations SET updated_at = '2026-01-01T00:00:00.123456Z' WHERE id = ANY($1)", [ids.slice(0, 5)]);
    const list = async (qs = "") => (await (await app.request(`/api/conversations${qs}`, { headers: auth })).json()) as { id: string; updated_at: string }[];
    const first = await list();
    expect(first).toHaveLength(50);
    const last = first.at(-1)!;
    const second = await list(`?before=${encodeURIComponent(last.updated_at)}&before_id=${last.id}`);
    expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map((c) => c.id)).size).toBe(53);
    expect((await app.request("/api/conversations?before=yesterday&before_id=x", { headers: auth })).status).toBe(400);

    expect((await app.request("/api/conversations/not-a-uuid/messages", { headers: auth })).status).toBe(404);
    const bad = await app.request("/api/facts", { method: "POST", headers: json, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("pins a chat to the top of the list", async () => {
    const { createConversation, listConversations } = await import("../src/memory.js");
    const older = await createConversation("me");
    await createConversation("me");
    // Two chats made in the same millisecond would otherwise sort by id.
    await pool.query("UPDATE conversations SET updated_at = now() - interval '1 hour' WHERE id = $1", [older]);
    const change = (body: unknown) =>
      app.request(`/api/conversations/${older}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
    expect((await listConversations("me"))[0].id).not.toBe(older);
    expect((await change({ pinned: true })).status).toBe(200);
    expect((await listConversations("me"))[0]).toMatchObject({ id: older, pinned: true });
    expect((await change({})).status).toBe(400);
    await change({ pinned: false });
    expect((await listConversations("me"))[1]).toMatchObject({ id: older, pinned: false });
  });
});

describe("MCP servers API", () => {
  const json = { ...auth, "Content-Type": "application/json" };
  it("adds, lists without the token, toggles and deletes", async () => {
    process.env.CONNECTOR_SECRET = "s";
    const bad = await app.request("/api/mcp-servers", { method: "POST", headers: json, body: JSON.stringify({ name: "Bad Name", url: "http://x" }) });
    expect(bad.status).toBe(400);

    const add = await app.request("/api/mcp-servers", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "notion", url: "https://mcp.notion.example/mcp", token: "secret-token" }),
    });
    const { id } = await add.json();
    const list = await (await app.request("/api/mcp-servers", { headers: auth })).json();
    expect(list).toMatchObject([{ id, name: "notion", enabled: true, has_token: true }]);
    expect(JSON.stringify(list)).not.toContain("secret-token");

    const off = await app.request(`/api/mcp-servers/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect((await app.request("/api/mcp-servers/nope", { method: "PATCH", headers: json, body: JSON.stringify({ enabled: true }) })).status).toBe(404);
    const del = await app.request(`/api/mcp-servers/${id}`, { method: "DELETE", headers: auth });
    expect(await del.json()).toEqual({ deleted: true });
  });
});

describe("hardening", () => {
  it("reports database health", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects oversized bodies and returns JSON for unknown routes", async () => {
    const big = await app.request("/api/facts", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024) },
      body: JSON.stringify({ fact: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(big.status).toBe(413);
    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
  });
});
