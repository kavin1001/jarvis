import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { query, pool } from "../src/db.js";
import { isQuiet, savePushToken, sendPush } from "../src/push.js";
import { setTimezone } from "../src/reminders.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

describe("push", () => {
  it("sends the category and forgets uninstalled phones", async () => {
    await savePushToken("me", "ExponentPushToken[live]");
    await savePushToken("me", "ExponentPushToken[gone]");
    let sent: { to: string; categoryId?: string; badge?: number }[] = [];
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
    expect(sent.every((m) => !("badge" in m))).toBe(true);
    await sendPush("me", "Jarvis needs your OK", "Book it?", {}, "approval", undefined, 2);
    expect(sent.map((m) => m.badge)).toEqual([2]);
    expect((await query<{ token: string }>("SELECT token FROM push_tokens")).map((r) => r.token)).toEqual(["ExponentPushToken[live]"]);
  });
});

describe("notification settings", () => {
  it("skips a kind of notification the user turned off", async () => {
    await savePushToken("me", "ExponentPushToken[live]");
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => (sent.push(...JSON.parse(init.body as string)), Response.json({ data: [] }))));
    const json = { ...auth, "Content-Type": "application/json" };
    expect(await (await app.request("/api/notifications", { headers: auth })).json()).toEqual({ replies: true, tasks: true, spending: true, quiet_start: null, quiet_end: null });
    const off = await app.request("/api/notifications", { method: "PATCH", headers: json, body: JSON.stringify({ tasks: false }) });
    expect(await off.json()).toEqual({ replies: true, tasks: false, spending: true, quiet_start: null, quiet_end: null });
    expect((await app.request("/api/notifications", { method: "PATCH", headers: json, body: JSON.stringify({ approvals: false }) })).status).toBe(400);

    await sendPush("me", "Jarvis finished a task", "Done", {}, "reply", "tasks");
    expect(sent).toHaveLength(0);
    await sendPush("me", "Jarvis replied", "Hi", {}, "reply", "replies");
    await sendPush("me", "Jarvis needs your OK", "Book it?", {}, "approval");
    expect(sent).toHaveLength(2);
  });
});

describe("quiet hours", () => {
  it("knows when it's quiet, across midnight and in the user's time zone", () => {
    const night = { quiet_start: 22 * 60, quiet_end: 7 * 60 };
    expect(isQuiet(night, "UTC", new Date("2026-10-29T23:30:00Z"))).toBe(true);
    expect(isQuiet(night, "UTC", new Date("2026-10-29T06:59:00Z"))).toBe(true);
    expect(isQuiet(night, "UTC", new Date("2026-10-29T07:00:00Z"))).toBe(false);
    expect(isQuiet(night, "UTC", new Date("2026-10-29T12:00:00Z"))).toBe(false);
    // 03:00 UTC is 23:00 the evening before in New York.
    expect(isQuiet(night, "America/New_York", new Date("2026-10-29T03:00:00Z"))).toBe(true);
    expect(isQuiet(night, "America/New_York", new Date("2026-10-29T14:00:00Z"))).toBe(false);
    expect(isQuiet({ quiet_start: 13 * 60, quiet_end: 14 * 60 }, "UTC", new Date("2026-10-29T13:15:00Z"))).toBe(true);
    expect(isQuiet({ quiet_start: null, quiet_end: null }, "UTC", new Date("2026-10-29T23:30:00Z"))).toBe(false);
  });

  it("sends silently in quiet hours, except reminders the user set", async () => {
    await savePushToken("me", "ExponentPushToken[live]");
    let sent: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => ((sent = JSON.parse(init.body as string)), Response.json({ data: [] }))));
    const json = { ...auth, "Content-Type": "application/json" };
    // Quiet all day except the last minute, so the test doesn't depend on the clock.
    const res = await app.request("/api/notifications", { method: "PATCH", headers: json, body: JSON.stringify({ quiet_start: 0, quiet_end: 1439 }) });
    expect(await res.json()).toMatchObject({ quiet_start: 0, quiet_end: 1439 });
    expect((await app.request("/api/notifications", { method: "PATCH", headers: json, body: JSON.stringify({ quiet_start: 1440 }) })).status).toBe(400);
    const lastMinute = new Date().getUTCHours() === 23 && new Date().getUTCMinutes() === 59;
    if (lastMinute) return;

    await sendPush("me", "Jarvis replied", "Hi", {}, "reply", "replies");
    expect(sent[0]).toMatchObject({ interruptionLevel: "passive", channelId: "quiet" });
    expect(sent[0]).not.toHaveProperty("sound");
    await sendPush("me", "Reminder", "Pills", {}, "reminder", undefined, undefined, true);
    expect(sent[0]).toMatchObject({ sound: "default" });
    expect(sent[0]).not.toHaveProperty("interruptionLevel");
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

  it("starts a weekly routine on the day asked for", async () => {
    await setTimezone("me", "Europe/London");
    const res = await app.request("/api/reminders", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Plan my week", time: "18:00", repeat: "weekly", weekday: 0 }),
    });
    const { due_at } = await res.json();
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(due_at));
    expect(local).toBe("Sun 18:00");
  });
});
