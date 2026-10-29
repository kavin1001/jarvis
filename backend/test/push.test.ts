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

describe("notification settings", () => {
  it("skips a kind of notification the user turned off", async () => {
    await savePushToken("me", "ExponentPushToken[live]");
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => (sent.push(...JSON.parse(init.body as string)), Response.json({ data: [] }))));
    const json = { ...auth, "Content-Type": "application/json" };
    expect(await (await app.request("/api/notifications", { headers: auth })).json()).toEqual({ replies: true, tasks: true, spending: true });
    const off = await app.request("/api/notifications", { method: "PATCH", headers: json, body: JSON.stringify({ tasks: false }) });
    expect(await off.json()).toEqual({ replies: true, tasks: false, spending: true });
    expect((await app.request("/api/notifications", { method: "PATCH", headers: json, body: JSON.stringify({ approvals: false }) })).status).toBe(400);

    await sendPush("me", "Jarvis finished a task", "Done", {}, "reply", "tasks");
    expect(sent).toHaveLength(0);
    await sendPush("me", "Jarvis replied", "Hi", {}, "reply", "replies");
    await sendPush("me", "Jarvis needs your OK", "Book it?", {}, "approval");
    expect(sent).toHaveLength(2);
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
