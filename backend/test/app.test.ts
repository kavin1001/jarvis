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
