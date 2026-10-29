import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import { createReminder, fireDueReminders, listReminders, setTimezone, snoozeReminder } from "../src/reminders.js";
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
});
