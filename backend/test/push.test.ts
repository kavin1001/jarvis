import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { query, pool } from "../src/db.js";
import { savePushToken, sendPush } from "../src/push.js";
import { setTimezone } from "../src/reminders.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

describe("push", () => {
  it("sends the category and forgets uninstalled phones", async () => {
    await savePushToken("me", "ExponentPushToken[live]");
    await savePushToken("me", "ExponentPushToken[gone]");
    let sent: { to: string; categoryId?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string);
        return Response.json({
          data: sent.map((m) =>
            m.to.includes("gone") ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "t" },
          ),
        });
      }),
    );
    await sendPush("me", "Jarvis needs your OK", "Book it?", { approvalId: "a" }, "approval");
    expect(sent.every((m) => m.categoryId === "approval")).toBe(true);
    expect((await query<{ token: string }>("SELECT token FROM push_tokens")).map((r) => r.token)).toEqual(["ExponentPushToken[live]"]);
  });
});

describe("POST /api/reminders", () => {
  it("creates a routine at the next local time", async () => {
    await setTimezone("me", "America/New_York");
    const res = await app.request("/api/reminders", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Brief me on my day", time: "08:00", repeat: "weekdays" }),
    });
    const { due_at } = await res.json();
    expect(new Date(due_at).getTime()).toBeGreaterThan(Date.now());
    const [row] = await query<{ action: string; repeat: string }>("SELECT action, repeat FROM reminders");
    expect(row).toEqual({ action: "run", repeat: "weekdays" });

    const bad = await app.request("/api/reminders", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", time: "25:00" }),
    });
    expect(bad.status).toBe(400);
  });
});
