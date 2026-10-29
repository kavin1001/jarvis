import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteAllData, exportData } from "../src/account.js";
import { app } from "../src/app.js";
import { pool, query } from "../src/db.js";
import type { MailHit } from "../src/google.js";
import * as mailWatch from "../src/mailWatch.js";
import * as memory from "../src/memory.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const hit = (id: string, from = "Sam Lee <sam@example.com>", subject = "Re: the lease"): MailHit => ({ id, from, subject, date: "", snippet: "", list: false });

/** A fake Gmail that returns whatever the test puts in the inbox, and records the searches. */
function inbox() {
  const mail: MailHit[] = [];
  const searches: string[] = [];
  const search = async (_userId: string, q: string) => {
    searches.push(q);
    return [...mail];
  };
  return { mail, searches, search };
}

const minutes = (n: number, from = Date.now()) => new Date(from + n * 60_000);

describe("email watches", () => {
  it("tells the user once about a new match, then stops", async () => {
    const conv = await memory.createConversation("me");
    const id = await mailWatch.createMailWatch({ userId: "me", conversationId: conv, query: "from:sam@example.com", about: "Sam's reply", once: true, days: 7, seenIds: ["old"] });
    const box = inbox();
    box.mail.push(hit("old"));

    // Not due yet, then due but only the email that was already there.
    await mailWatch.checkMailWatches(box.search, minutes(1));
    expect(box.searches).toEqual([]);
    await mailWatch.checkMailWatches(box.search, minutes(6));
    expect(box.searches).toHaveLength(1);
    expect(box.searches[0]).toMatch(/^\(from:sam@example\.com\) -from:me after:\d+$/);
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([]);

    box.mail.unshift(hit("new"));
    await mailWatch.checkMailWatches(box.search, minutes(12));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(['New email for Sam\'s reply:\n- From Sam Lee <sam@example.com>: "Re: the lease" [new]']);
    expect(await mailWatch.listMailWatches("me")).toEqual([]);
    const [row] = await query<{ status: string }>("SELECT status FROM mail_watches WHERE id = $1", [id]);
    expect(row.status).toBe("done");
  });

  it("keeps watching for every match, without repeating one", async () => {
    const conv = await memory.createConversation("me");
    await mailWatch.createMailWatch({ userId: "me", conversationId: conv, query: "from:landlord", about: "the landlord", once: false, days: 7 });
    const box = inbox();
    box.mail.push(hit("a", "landlord@example.com", "Rent"));
    await mailWatch.checkMailWatches(box.search, minutes(6));
    box.mail.unshift(hit("b", "landlord@example.com", "Boiler"));
    await mailWatch.checkMailWatches(box.search, minutes(12));
    await mailWatch.checkMailWatches(box.search, minutes(18));
    const updates = await memory.takePendingTaskUpdates(conv);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toContain("[b]");
    expect(updates[1]).not.toContain("[a]");
    expect(updates[1]).toContain("(Still watching.)");
    expect(await mailWatch.listMailWatches("me")).toHaveLength(1);
  });

  it("expires, cancels, caps and describes watches", async () => {
    const id = await mailWatch.createMailWatch({ userId: "me", conversationId: null, query: "from:x", about: "x", once: true, days: 1 });
    const box = inbox();
    await mailWatch.checkMailWatches(box.search, minutes(25 * 60));
    expect(box.searches).toEqual([]);
    const [row] = await query<{ status: string }>("SELECT status FROM mail_watches WHERE id = $1", [id]);
    expect(row.status).toBe("expired");

    const ids = [];
    for (let i = 0; i < mailWatch.MAX_ACTIVE; i++)
      ids.push(await mailWatch.createMailWatch({ userId: "me", conversationId: null, query: `from:${i}`, about: `${i}`, once: true, days: 7 }));
    await expect(mailWatch.createMailWatch({ userId: "me", conversationId: null, query: "from:y", about: "y", once: true, days: 7 })).rejects.toThrow(/At most 10/);
    expect(await mailWatch.cancelMailWatch("someone-else", ids[0])).toBe(false);
    expect(await mailWatch.cancelMailWatch("me", "not-an-id")).toBe(false);
    expect(await mailWatch.cancelMailWatch("me", ids[0])).toBe(true);
    expect(await mailWatch.listMailWatches("me")).toHaveLength(mailWatch.MAX_ACTIVE - 1);

    expect(mailWatch.describeMailWatch({ about: "Sam's reply", query: "from:sam", once: true, expires_at: "2026-11-05T12:00:00Z" })).toBe(
      "watching email for Sam's reply (from:sam), once until Thu, Nov 5",
    );
  });

  it("nudges only if nothing arrives by the deadline, with one last look first", async () => {
    const conv = await memory.createConversation("me");
    const until = minutes(60);
    const quiet = await mailWatch.createMailWatch({ userId: "me", conversationId: conv, query: "from:sam", about: "Sam's reply", once: false, days: 7, until, ifNone: true, seenIds: ["old"] });
    const box = inbox();
    box.mail.push(hit("old"));
    await mailWatch.checkMailWatches(box.search, minutes(6));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([]);
    const [w] = await mailWatch.listMailWatches("me");
    expect(w).toMatchObject({ once: true, if_none: true });
    expect(mailWatch.describeMailWatch({ ...w, expires_at: "2026-11-06T22:00:00Z" }, "America/New_York")).toBe(
      "waiting for Sam's reply (from:sam); a nudge if nothing arrives by Fri, Nov 6, 5:00 PM",
    );

    // Nothing by the deadline: the final search covers the whole wait, then the nudge.
    await mailWatch.checkMailWatches(box.search, minutes(61));
    expect(box.searches.at(-1)).toMatch(/^\(from:sam\) -from:me after:\d+$/);
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([expect.stringMatching(/^Still nothing for Sam's reply \(searched from:sam\) since \w{3}, \w{3} \d+\. Offer to draft a follow-up\.$/)]);
    const [row] = await query<{ status: string }>("SELECT status FROM mail_watches WHERE id = $1", [quiet]);
    expect(row.status).toBe("expired");
    // Expired once, nudged once.
    await mailWatch.checkMailWatches(box.search, minutes(70));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([]);
  });

  it("ends a nudge quietly when the email comes, even in the last minutes", async () => {
    const conv = await memory.createConversation("me");
    const box = inbox();
    const early = await mailWatch.createMailWatch({ userId: "me", conversationId: conv, query: "from:sam", about: "Sam", once: true, days: 7, ifNone: true });
    box.mail.push(hit("r1"));
    await mailWatch.checkMailWatches(box.search, minutes(6));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(['Sam: it arrived (from Sam Lee <sam@example.com>: "Re: the lease" [r1]), so no nudge needed.']);
    expect((await query<{ status: string }>("SELECT status FROM mail_watches WHERE id = $1", [early]))[0].status).toBe("done");

    // A reply after the last regular check but before the deadline still counts.
    box.mail.length = 0;
    await mailWatch.createMailWatch({ userId: "me", conversationId: conv, query: "from:ana", about: "Ana", once: true, days: 7, until: minutes(30), ifNone: true });
    await mailWatch.checkMailWatches(box.search, minutes(26));
    box.mail.push(hit("r2", "Ana <ana@example.com>", "Sounds good"));
    await mailWatch.checkMailWatches(box.search, minutes(31));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([expect.stringMatching(/^Ana: it arrived/)]);

    await expect(mailWatch.createMailWatch({ userId: "me", conversationId: conv, query: "x", about: "x", once: true, days: 7, until: minutes(5), ifNone: true })).rejects.toThrow(/10 minutes/);
  });

  it("lists and cancels watches over the API", async () => {
    const id = await mailWatch.createMailWatch({ userId: "me", conversationId: null, query: "from:sam", about: "Sam", once: false, days: 7 });
    const listed = await (await app.request("/api/mail-watches", { headers: auth })).json();
    expect(listed).toMatchObject([{ id, about: "Sam", query: "from:sam", once: false }]);
    expect(Object.keys(listed[0]).sort()).toEqual(["about", "expires_at", "id", "if_none", "once", "query"]);
    expect(await (await app.request(`/api/mail-watches/${id}`, { method: "DELETE", headers: auth })).json()).toEqual({ cancelled: true });
    expect(await (await app.request("/api/mail-watches", { headers: auth })).json()).toEqual([]);
  });

  it("is in the export and goes with erase", async () => {
    await mailWatch.createMailWatch({ userId: "me", conversationId: null, query: "from:sam", about: "Sam", once: true, days: 7 });
    expect((await exportData("me")).mail_watches).toMatchObject([{ about: "Sam", query: "from:sam", status: "active" }]);
    await deleteAllData("me");
    expect((await exportData("me")).mail_watches).toEqual([]);
  });
});
