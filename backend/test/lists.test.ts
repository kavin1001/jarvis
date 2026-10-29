import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { exportData, deleteAllData } from "../src/account.js";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import * as lists from "../src/lists.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const json = { ...auth, "Content-Type": "application/json" };

describe("lists", () => {
  it("adds items in order, skips ones already on the list, and treats name variants as one list", async () => {
    const first = await lists.addItems("me", "Shopping list", ["eggs", "milk", "Eggs", " "]);
    expect(first.map((i) => i.text)).toEqual(["eggs", "milk"]);
    expect(await lists.addItems("me", "  shopping ", ["MILK", "bread"])).toMatchObject([{ text: "bread", list: "shopping" }]);
    expect((await lists.listItems("me", "SHOPPING")).map((i) => i.text)).toEqual(["eggs", "milk", "bread"]);

    // A checked-off item can go back on.
    await lists.setDone("me", [first[0].id], true);
    expect(await lists.addItems("me", "shopping", ["eggs"])).toHaveLength(1);
    const items = await lists.listItems("me", "shopping");
    expect(items.map((i) => [i.text, i.done])).toEqual([["milk", false], ["bread", false], ["eggs", false], ["eggs", true]]);
    expect(lists.describeList("shopping", items)).toContain(`[${first[0].id}] (done) eggs`);
  });

  it("checks off, removes and clears, ignoring other users' and malformed ids", async () => {
    const [a, b] = await lists.addItems("me", "packing", ["passport", "charger"]);
    const [theirs] = await lists.addItems("someone-else", "packing", ["socks"]);
    expect(await lists.setDone("me", [a.id, theirs.id, "nope"], true)).toBe(1);
    expect(await lists.removeItems("me", [theirs.id])).toBe(0);
    expect(await lists.clearList("me", "packing")).toBe(1);
    expect((await lists.listItems("me", "packing")).map((i) => i.id)).toEqual([b.id]);
    expect(await lists.clearList("me", "Packing list", true)).toBe(1);
    expect(await lists.allLists("me")).toEqual([]);
    expect(await lists.allLists("someone-else")).toHaveLength(1);
  });

  it("serves lists over the API", async () => {
    const add = (name: string, items: unknown) =>
      app.request(`/api/lists/${encodeURIComponent(name)}/items`, { method: "POST", headers: json, body: JSON.stringify({ items }) });
    const [item] = (await (await add("Groceries", ["apples", "pears"])).json()) as lists.ListItem[];
    expect((await add("Groceries", [])).status).toBe(400);
    expect((await add(" ", ["x"])).status).toBe(400);

    const patch = (id: string, body: unknown) => app.request(`/api/list-items/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
    expect(await (await patch(item.id, { done: true, text: "green apples" })).json()).toMatchObject({ done: true, text: "green apples" });
    expect((await patch(item.id, {})).status).toBe(400);
    expect((await patch("00000000-0000-0000-0000-000000000000", { done: true })).status).toBe(404);
    expect((await patch("not-an-id", { done: true })).status).toBe(404);

    const all = (await (await app.request("/api/lists", { headers: auth })).json()) as { name: string; items: lists.ListItem[] }[];
    expect(all).toMatchObject([{ name: "groceries", items: [{ text: "pears", done: false }, { text: "green apples", done: true }] }]);

    expect(await (await app.request("/api/lists/groceries", { method: "DELETE", headers: auth })).json()).toEqual({ removed: 1 });
    const pears = all[0].items[0].id;
    expect(await (await app.request(`/api/list-items/${pears}`, { method: "DELETE", headers: auth })).json()).toEqual({ deleted: true });
    expect(await (await app.request("/api/lists", { headers: auth })).json()).toEqual([]);
  });

  it("is part of export and erase", async () => {
    await lists.addItems("me", "to-do", ["call the bank"]);
    expect((await exportData("me")).lists).toMatchObject([{ list: "to-do", text: "call the bank", done: false }]);
    await deleteAllData("me");
    expect(await lists.allLists("me")).toEqual([]);
  });
});
