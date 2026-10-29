import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteAllData, exportData } from "../src/account.js";
import { describeAction } from "../src/activity.js";
import { pool, query } from "../src/db.js";
import * as mailSnooze from "../src/mailSnooze.js";
import * as memory from "../src/memory.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

function gmail() {
  const calls: [string[], string[], string[]][] = [];
  let failing = false;
  const modify: mailSnooze.Modify = async (_userId, ids, add, remove) => {
    if (failing) throw new Error("Google API 401");
    calls.push([ids, add, remove]);
  };
  return { calls, modify, fail: () => (failing = true) };
}

describe("email snooze", () => {
  it("archives now and brings the emails back unread when due, once", async () => {
    const conv = await memory.createConversation("me");
    const g = gmail();
    const dueAt = new Date("2026-11-02T09:00:00Z");
    await mailSnooze.snoozeMail({ userId: "me", conversationId: conv, messageIds: ["m1", "m2"], about: "Acme invoice", dueAt }, g.modify);
    expect(g.calls).toEqual([[["m1", "m2"], [], ["INBOX"]]]);
    expect((await mailSnooze.listSnoozes("me")).map(mailSnooze.describeSnooze)).toEqual(["snoozed 2 emails: Acme invoice"]);

    await mailSnooze.returnDueSnoozes(g.modify, new Date("2026-11-02T08:59:00Z"));
    expect(g.calls).toHaveLength(1);
    await mailSnooze.returnDueSnoozes(g.modify, new Date("2026-11-02T09:00:30Z"));
    await mailSnooze.returnDueSnoozes(g.modify, new Date("2026-11-02T09:01:30Z"));
    expect(g.calls.slice(1)).toEqual([[["m1", "m2"], ["INBOX", "UNREAD"], []]]);
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(["Back in your inbox: Acme invoice."]);
    expect(await mailSnooze.listSnoozes("me")).toEqual([]);
  });

  it("brings emails back early, keeps the snooze when Google fails, and says so when the sweep fails", async () => {
    const g = gmail();
    const id = await mailSnooze.snoozeMail({ userId: "me", conversationId: null, messageIds: ["m1"], about: "Trip", dueAt: new Date("2026-12-01T09:00:00Z") }, g.modify);
    expect(await mailSnooze.unsnooze("someone-else", id, g.modify)).toBe(false);
    expect(await mailSnooze.unsnooze("me", "nope", g.modify)).toBe(false);

    g.fail();
    await expect(mailSnooze.unsnooze("me", id, g.modify)).rejects.toThrow(/401/);
    expect(await mailSnooze.listSnoozes("me")).toHaveLength(1);

    await mailSnooze.returnDueSnoozes(g.modify, new Date("2026-12-01T09:00:01Z"));
    const [row] = await query<{ status: string }>("SELECT status FROM mail_snoozes WHERE id = $1", [id]);
    expect(row.status).toBe("failed");
    const [conv] = await query<{ id: string }>("SELECT id FROM conversations WHERE user_id = 'me'");
    expect((await memory.takePendingTaskUpdates(conv.id))[0]).toMatch(/^Couldn't put your snoozed email back in the inbox \(Trip\): Google API 401\. It's in All Mail\.$/);
  });

  it("brings one back early when asked, logs it, and is in export and erase", async () => {
    const g = gmail();
    const id = await mailSnooze.snoozeMail({ userId: "me", conversationId: null, messageIds: ["m1"], about: "Sam", dueAt: new Date("2026-12-01T09:00:00Z") }, g.modify);
    expect(await mailSnooze.unsnooze("me", id, g.modify)).toBe(true);
    expect(g.calls.at(-1)).toEqual([["m1"], ["INBOX", "UNREAD"], []]);
    expect(describeAction("gmail_snooze", { message_ids: ["a", "b"], until: "2026-11-02T09:00:00Z" })).toBe("Snoozed 2 emails until Mon, Nov 2, 9:00 AM");

    expect((await exportData("me")).mail_snoozes).toMatchObject([{ about: "Sam", status: "back" }]);
    await deleteAllData("me");
    expect((await exportData("me")).mail_snoozes).toEqual([]);
  });
});
