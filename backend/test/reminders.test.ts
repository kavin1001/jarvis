import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import { app } from "../src/app.js";
import { createReminder, fireDueReminders, listReminders, rescheduleReminder, runReminderNow, setTimezone, skipReminder, snoozeReminder } from "../src/reminders.js";
import { auth } from "./helpers.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

describe("reminders", () => {
  it("fires a one-off notify reminder once and closes it", async () => {
    const conv = await memory.createConversation("me");
    await createReminder({ userId: "me", conversationId: conv, text: "Call mom", action: "notify", dueAt: new Date(Date.now() - 1000), repeat: null });
    const prompts: string[] = [];
    await fireDueReminders(async (_c, t) => (prompts.push(t), "ok"));
    await fireDueReminders(async (_c, t) => (prompts.push(t), "ok"));

    expect(prompts).toEqual([]);
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(["Reminder: Call mom"]);
    expect(await listReminders("me")).toEqual([]);
  });

  it("runs a recurring job and moves it to the next day", async () => {
    await setTimezone("me", "America/New_York");
    const due = new Date("2026-10-29T12:00:00Z"); // 8am EDT
    await createReminder({ userId: "me", conversationId: null, text: "Brief me", action: "run", dueAt: due, repeat: "daily" });
    const prompts: string[] = [];
    await fireDueReminders(async (_c, t) => (prompts.push(t), "Here is your day"), new Date("2026-10-29T12:00:30Z"));

    expect(prompts).toEqual(["Brief me"]);
    const [r] = await listReminders("me");
    expect(new Date(r.due_at).toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(r.timezone).toBe("America/New_York");
  });

  it("skips missed days after an outage instead of firing each one", async () => {
    await createReminder({ userId: "me", conversationId: null, text: "Water plants", action: "notify", dueAt: new Date("2026-10-01T09:00:00Z"), repeat: "daily" });
    await fireDueReminders(async () => "", new Date("2026-10-05T10:00:00Z"));
    const [r] = await listReminders("me");
    expect(new Date(r.due_at).toISOString()).toBe("2026-10-06T09:00:00.000Z");
    const fired = await query<{ n: string }>("SELECT count(*) AS n FROM reminders WHERE last_fired_at IS NOT NULL");
    expect(fired[0].n).toBe("1");
  });

  it("snoozes a reminder as a one-off copy and leaves a repeating one on schedule", async () => {
    const dueAt = new Date("2026-10-30T08:00:00Z");
    const id = await createReminder({ userId: "me", conversationId: null, text: "Stretch", action: "run", dueAt, repeat: "daily" });
    const now = new Date("2026-10-29T12:00:00Z");
    const copy = await snoozeReminder("me", id, 10, now);
    const all = await listReminders("me");
    expect(all.map((r) => [r.text, r.action, r.repeat, new Date(r.due_at).toISOString()])).toEqual([
      ["Stretch", "notify", null, "2026-10-29T12:10:00.000Z"],
      ["Stretch", "run", "daily", dueAt.toISOString()],
    ]);
    expect(all[0].id).toBe(copy);
    expect(await snoozeReminder("someone-else", id, 10)).toBeNull();
  });

  it("moves an upcoming reminder, and a repeating one keeps repeating from the new time", async () => {
    await setTimezone("me", "UTC");
    const id = await createReminder({ userId: "me", conversationId: null, text: "Stretch", action: "notify", dueAt: new Date("2026-10-29T12:00:00Z"), repeat: "daily" });
    expect(await rescheduleReminder("me", id, new Date("2026-10-29T15:00:00Z"))).toBe(true);
    expect(await rescheduleReminder("someone-else", id, new Date("2026-10-29T16:00:00Z"))).toBe(false);
    await fireDueReminders(async () => "", new Date("2026-10-29T15:00:10Z"));
    expect(new Date((await listReminders("me"))[0].due_at).toISOString()).toBe("2026-10-30T15:00:00.000Z");

    const json = { ...auth, "Content-Type": "application/json" };
    const patch = (rid: string, body: unknown) => app.request(`/api/reminders/${rid}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
    const later = new Date(Date.now() + 3600_000).toISOString();
    expect(await (await patch(id, { due_at: later })).json()).toEqual({ id, due_at: later });
    expect((await patch(id, { due_at: "2020-01-01T00:00:00Z" })).status).toBe(400);
    expect((await patch(id, { due_at: "tomorrow" })).status).toBe(400);
    expect((await patch("00000000-0000-0000-0000-000000000000", { due_at: later })).status).toBe(404);
    expect((await patch("nope", { due_at: later })).status).toBe(404);
  });

  it("skips the next run of a routine, and only of repeating ones", async () => {
    await setTimezone("me", "America/New_York");
    // Friday 8am EDT; the next weekday is Monday.
    const id = await createReminder({ userId: "me", conversationId: null, text: "Brief me", action: "run", dueAt: new Date("2026-10-30T12:00:00Z"), repeat: "weekdays" });
    expect((await skipReminder("me", id))?.toISOString()).toBe("2026-11-02T13:00:00.000Z");
    const once = await createReminder({ userId: "me", conversationId: null, text: "Call", action: "notify", dueAt: new Date(Date.now() + 3600_000), repeat: null });
    expect(await skipReminder("me", once)).toBeNull();
    expect((await app.request(`/api/reminders/${once}/skip`, { method: "POST", headers: auth })).status).toBe(404);
    expect(await (await app.request(`/api/reminders/${id}/skip`, { method: "POST", headers: auth })).json()).toEqual({ id, due_at: "2026-11-03T13:00:00.000Z" });
  });

  it("runs a routine now without touching its schedule", async () => {
    const due = new Date(Date.now() + 86400_000);
    const id = await createReminder({ userId: "me", conversationId: null, text: "Brief me", action: "run", dueAt: due, repeat: "weekdays" });
    const prompts: string[] = [];
    expect(await runReminderNow("me", id, async (_c, t) => (prompts.push(t), "Your day"))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts).toEqual(["Brief me"]);
    expect(new Date((await listReminders("me"))[0].due_at).getTime()).toBe(due.getTime());
    expect(await runReminderNow("someone-else", id, async () => "")).toBe(false);
    expect((await app.request("/api/reminders/00000000-0000-0000-0000-000000000000/run", { method: "POST", headers: auth })).status).toBe(404);
  });
});
