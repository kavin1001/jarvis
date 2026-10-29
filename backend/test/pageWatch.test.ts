import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAllData, exportData } from "../src/account.js";
import { app } from "../src/app.js";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import * as pageWatch from "../src/pageWatch.js";
import { cancelReminder, createReminder, fireDueReminders, listReminders } from "../src/reminders.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const publicDns = async () => ["93.184.216.34"];

describe("page watches", () => {
  it("only fetches public http(s) pages", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"])
      expect(pageWatch.isPublicAddress(a), a).toBe(false);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(pageWatch.isPublicAddress(a), a).toBe(true);

    await expect(pageWatch.checkUrl("file:///etc/passwd", publicDns)).rejects.toThrow(/http and https/);
    await expect(pageWatch.checkUrl("https://example.com:8443/", publicDns)).rejects.toThrow(/usual web ports/);
    await expect(pageWatch.checkUrl("https://u:p@example.com/", publicDns)).rejects.toThrow(/login/);
    await expect(pageWatch.checkUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/public/);
    await expect(pageWatch.checkUrl("https://internal.example/", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow(/public/);
    await expect(pageWatch.checkUrl("not a url")).rejects.toThrow(/web address/);
    expect((await pageWatch.checkUrl("https://example.com/tickets", publicDns)).hostname).toBe("example.com");
  });

  it("follows redirects only to public pages, and reads the text of the HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.hostname === "short.example"
          ? new Response(null, { status: 302, headers: { location: "https://example.com/page" } })
          : url.hostname === "sneaky.example"
            ? new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } })
            : new Response("<html><head><style>p{}</style><script>var x=1</script></head><body><p>Tickets&nbsp;<b>on sale</b> &amp; more</p></body></html>", {
                headers: { "content-type": "text/html; charset=utf-8" },
              }),
      ),
    );
    expect(await pageWatch.fetchPageText("https://short.example/x", publicDns)).toBe("Tickets on sale & more");
    await expect(pageWatch.fetchPageText("https://sneaky.example/x", publicDns)).rejects.toThrow(/public/);
  });

  it("tells the user when the words appear, once", async () => {
    const conv = await memory.createConversation("me");
    let page = "Tickets: coming soon";
    const fetchText = async () => page;
    const made = await pageWatch.createPageWatch({ userId: "me", conversationId: conv, url: "https://example.com/t", lookFor: "On Sale", about: "concert tickets", days: 14 }, fetchText);
    expect("id" in made).toBe(true);

    await pageWatch.checkPageWatches(fetchText, minutes(10));
    await pageWatch.checkPageWatches(fetchText, minutes(31));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([]);

    page = "Tickets: on sale now from $40. Hurry.";
    await pageWatch.checkPageWatches(fetchText, minutes(62));
    const [update] = await memory.takePendingTaskUpdates(conv);
    expect(update).toContain('"On Sale" is now on https://example.com/t (concert tickets)');
    expect(update).toContain("on sale now from $40");
    expect(await pageWatch.listPageWatches("me")).toEqual([]);

    // Already there: nothing to wait for.
    expect(await pageWatch.createPageWatch({ userId: "me", conversationId: conv, url: "https://example.com/t", lookFor: "on sale", about: "x", days: 1 }, fetchText)).toEqual({
      already: expect.stringContaining("on sale now"),
    });
  });

  it("without words, notices a change; gives up on a page that keeps failing", async () => {
    const conv = await memory.createConversation("me");
    let page = "Menu: soup";
    await pageWatch.createPageWatch({ userId: "me", conversationId: conv, url: "https://example.com/menu", lookFor: null, about: "the menu", days: 14 }, async () => page);
    await pageWatch.checkPageWatches(async () => page, minutes(31));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual([]);
    page = "Menu: soup, pie";
    await pageWatch.checkPageWatches(async () => page, minutes(62));
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(["https://example.com/menu changed (the menu)."]);

    await pageWatch.createPageWatch({ userId: "me", conversationId: conv, url: "https://example.com/gone", lookFor: "x y", about: "gone", days: 30 }, async () => "nothing");
    const failing = async () => {
      throw new Error("The page answered 404.");
    };
    for (let i = 1; i <= 48; i++) await pageWatch.checkPageWatches(failing, minutes(31 * i));
    expect(await pageWatch.listPageWatches("me")).toEqual([]);
    expect((await memory.takePendingTaskUpdates(conv))[0]).toMatch(/^Stopped watching https:\/\/example\.com\/gone for gone: it hasn't loaded for a day/);
  });

  it("caps, cancels, lists over the API, and is in export and erase", async () => {
    const ids: string[] = [];
    for (let i = 0; i < pageWatch.MAX_ACTIVE; i++) {
      const made = await pageWatch.createPageWatch({ userId: "me", conversationId: null, url: `https://example.com/${i}`, lookFor: "open", about: `${i}`, days: 7 }, async () => "closed");
      ids.push((made as { id: string }).id);
    }
    await expect(pageWatch.createPageWatch({ userId: "me", conversationId: null, url: "https://example.com/x", lookFor: "open", about: "x", days: 7 }, async () => "")).rejects.toThrow(/At most 10/);
    const listed = await (await app.request("/api/page-watches", { headers: auth })).json();
    expect(listed).toHaveLength(pageWatch.MAX_ACTIVE);
    expect(Object.keys(listed[0]).sort()).toEqual(["about", "expires_at", "id", "look_for", "url"]);
    expect(await (await app.request(`/api/page-watches/${ids[0]}`, { method: "DELETE", headers: auth })).json()).toEqual({ cancelled: true });
    expect(await pageWatch.cancelPageWatch("someone-else", ids[1])).toBe(false);
    expect(pageWatch.describePageWatch({ about: "tickets", url: "https://example.com/t", look_for: "on sale", expires_at: "2026-11-05T12:00:00Z" })).toBe(
      'watching https://example.com/t for "on sale" (tickets) until Thu, Nov 5',
    );

    expect((await exportData("me")).page_watches).toHaveLength(pageWatch.MAX_ACTIVE);
    await deleteAllData("me");
    expect((await exportData("me")).page_watches).toEqual([]);
  });
});

describe("cancelling a nagging routine", () => {
  it("stops the nags still to come", async () => {
    const id = await createReminder({ userId: "me", conversationId: null, text: "Pills", action: "notify", dueAt: new Date("2026-10-29T08:00:00Z"), repeat: "daily", nagMinutes: 10 });
    await fireDueReminders(async () => "", new Date("2026-10-29T08:00:01Z"));
    expect(await listReminders("me")).toHaveLength(2);
    expect(await cancelReminder("me", id)).toBe(true);
    expect(await listReminders("me")).toEqual([]);
    const [{ n }] = await query<{ n: number }>("SELECT count(*)::int AS n FROM reminders WHERE status = 'cancelled'");
    expect(n).toBe(2);
  });
});
