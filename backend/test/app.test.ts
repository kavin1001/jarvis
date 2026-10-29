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
    expect(await added.json()).toMatchObject({ fact: "Vegetarian" });

    const { createConversation, listConversations } = await import("../src/memory.js");
    const id = await createConversation("me");
    const res = await app.request(`/api/conversations/${id}`, { method: "DELETE", headers: auth });
    expect(await res.json()).toEqual({ deleted: true });
    expect(await listConversations("me")).toEqual([]);
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
