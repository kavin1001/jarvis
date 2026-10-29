import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeAction, recentActivity, recordActivity } from "../src/activity.js";
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
});
