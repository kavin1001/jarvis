import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeAction, recentActivity, recordActivity, undoActivity, undoFor, type Undo } from "../src/activity.js";
import { deleteAllData, exportData } from "../src/account.js";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

describe("activity log", () => {
  it("describes actions on the user's accounts and ignores reads", () => {
    expect(describeAction("gmail_create_draft", { to: "ana@example.com", subject: "Notes" })).toBe('Saved a draft to ana@example.com: "Notes"');
    expect(describeAction("gmail_organize", { message_ids: ["a", "b"], action: "archive" })).toBe("Archived 2 emails");
    expect(describeAction("calendar_create_event", { summary: "Dentist", start: "2026-10-30T14:00:00Z" }, "America/New_York")).toBe(
      'Added "Dentist" to your calendar for Fri, Oct 30, 10:00 AM',
    );
    expect(describeAction("calendar_update_event", { event_id: "e", start: "2026-10-30T15:00:00Z" }, "UTC")).toBe("Moved an event to Fri, Oct 30, 3:00 PM");
    expect(describeAction("calendar_update_event", { event_id: "e", location: "Room 2" })).toBe("Changed an event");
    expect(describeAction("start_task", { instructions: "Book a table", summary: "Dinner booking" })).toBe("Started a background task: Dinner booking");
    expect(describeAction("gmail_search", { query: "x" })).toBeNull();
    expect(describeAction("calendar_list_events", {})).toBeNull();
  });

  it("keeps entries newest first, serves them, and includes them in export and erase", async () => {
    await recordActivity("me", null, [{ kind: "gmail_organize", summary: "Archived 1 email" }]);
    await recordActivity("me", null, [
      { kind: "mcp", summary: "Used linear: create issue" },
      { kind: "cancel_task", summary: "Stopped a background task" },
    ]);
    await recordActivity("someone-else", null, [{ kind: "mcp", summary: "theirs" }]);
    await pool.query("INSERT INTO activity (user_id, kind, summary, created_at) VALUES ('me', 'mcp', 'old', now() - interval '100 days')");
    await recordActivity("me", null, []);
    expect((await recentActivity("me")).map((a) => a.summary)).toEqual([
      "Stopped a background task",
      "Used linear: create issue",
      "Archived 1 email",
      "old",
    ]);
    // The next write prunes entries past 90 days.
    await recordActivity("me", null, [{ kind: "mcp", summary: "new" }]);
    const res = await app.request("/api/activity?limit=2", { headers: auth });
    expect(((await res.json()) as { summary: string }[]).map((a) => a.summary)).toEqual(["new", "Stopped a background task"]);
    expect((await recentActivity("me")).map((a) => a.summary)).not.toContain("old");

    expect((await exportData("me")).activity).toHaveLength(4);
    await deleteAllData("me");
    expect(await recentActivity("me")).toEqual([]);
    expect(await recentActivity("someone-else")).toHaveLength(1);
  });

  it("knows how to reverse archiving, an added event and a snooze", () => {
    expect(undoFor("gmail_organize", { message_ids: ["a", "b"], action: "archive" }, "Done")).toEqual({ tool: "gmail_organize", message_ids: ["a", "b"], action: "move_to_inbox" });
    expect(undoFor("gmail_organize", { message_ids: ["a"], action: "star" }, "Done")).toMatchObject({ action: "unstar" });
    expect(undoFor("calendar_create_event", { summary: "x" }, "Event created (id abc123): https://calendar.example/e")).toEqual({ tool: "calendar_delete_event", event_id: "abc123" });
    expect(undoFor("calendar_create_event", { summary: "x" }, "Event created: https://calendar.example/e")).toBeNull();
    const snooze = "0b6f5a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(undoFor("gmail_snooze", {}, `Snoozed ${snooze}: archived 1 email, back Monday.`)).toEqual({ tool: "unsnooze", snooze_id: snooze });
    expect(undoFor("calendar_delete_event", { event_id: "e" }, "Event deleted.")).toBeNull();
    expect(undoFor("calendar_update_event", { event_id: "work@x/ev1", start: "2026-10-29T16:00:00Z" }, "Event updated (it was 2026-10-29T15:00:00.000Z to 2026-10-29T15:30:00.000Z): https://c")).toEqual({
      tool: "calendar_update_event",
      event_id: "work@x/ev1",
      start: "2026-10-29T15:00:00.000Z",
      end: "2026-10-29T15:30:00.000Z",
    });
    expect(undoFor("calendar_update_event", { event_id: "ev1", location: "Room 2" }, "Event updated: https://c")).toBeNull();
  });

  it("undoes an entry once, and lets it be tried again when undoing fails", async () => {
    const undo: Undo = { tool: "gmail_organize", message_ids: ["m1"], action: "move_to_inbox" };
    await recordActivity("me", null, [{ kind: "gmail_organize", summary: "Archived 1 email", undo }, { kind: "gmail_create_draft", summary: "Saved a draft" }]);
    const [draft, archived] = await recentActivity("me");
    expect([archived.can_undo, draft.can_undo]).toEqual([true, false]);

    const ran: Undo[] = [];
    await expect(undoActivity("me", archived.id, async () => Promise.reject(new Error("Google API 500")))).rejects.toThrow(/500/);
    expect((await recentActivity("me")).find((a) => a.id === archived.id)!.can_undo).toBe(true);
    expect(await undoActivity("someone-else", archived.id, async (u) => void ran.push(u))).toBe(false);
    expect(await undoActivity("me", archived.id, async (u) => void ran.push(u))).toBe(true);
    expect(await undoActivity("me", archived.id, async (u) => void ran.push(u))).toBe(false);
    expect(ran).toEqual([undo]);
    const after = await recentActivity("me");
    expect(after[0].summary).toBe("Undid: Archived 1 email");
    expect(after.find((a) => a.id === archived.id)).toMatchObject({ can_undo: false, undone: true });
    expect(await undoActivity("me", draft.id, async () => {})).toBe(false);
    expect(await undoActivity("me", "x; drop", async () => {})).toBe(false);

    // Over the API: a Google failure comes back as an error and leaves Undo available.
    await recordActivity("me", null, [{ kind: "calendar_create_event", summary: "Added an event", undo: { tool: "calendar_delete_event", event_id: "e1" } }]);
    const [added] = await recentActivity("me");
    const res = await app.request(`/api/activity/${added.id}/undo`, { method: "POST", headers: auth });
    expect(res.status).toBe(502);
    expect((await recentActivity("me"))[0].can_undo).toBe(true);
    expect((await app.request(`/api/activity/${archived.id}/undo`, { method: "POST", headers: auth })).status).toBe(404);
  });
});
