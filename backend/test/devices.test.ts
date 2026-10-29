import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("device tokens", () => {
  it("swaps the app token for a device token that can be revoked", async () => {
    const res = await post("/api/devices", { name: "Kavin's iPhone" }, auth);
    const { id, token } = await res.json();
    expect(token).toMatch(/^jvd_/);

    const list = await (await app.request("/api/devices", { headers: bearer(token) })).json();
    expect(list).toMatchObject([{ id, name: "Kavin's iPhone", current: true }]);

    // Devices can't mint more devices directly.
    expect((await post("/api/devices", { name: "x" }, bearer(token))).status).toBe(403);

    await app.request(`/api/devices/${id}`, { method: "DELETE", headers: auth });
    expect((await app.request("/api/facts", { headers: bearer(token) })).status).toBe(401);
  });

  it("pairs a new device with a one-time code", async () => {
    const { code } = await (await post("/api/devices/pair-codes", {}, auth)).json();
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    const paired = await post("/pair", { code: code.toLowerCase().replace("-", " "), name: "iPad" });
    expect(paired.status).toBe(200);
    const { token } = await paired.json();
    expect((await app.request("/api/facts", { headers: bearer(token) })).status).toBe(200);

    // Single use.
    expect((await post("/pair", { code, name: "iPad 2" })).status).toBe(400);
  });

  it("rate limits pairing attempts", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post("/pair", { code: "AAAA-AAAA", name: "x" }, headers)).status;
    expect(last).toBe(429);
  });
});
