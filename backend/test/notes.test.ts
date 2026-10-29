import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteAllData, exportData } from "../src/account.js";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import * as notes from "../src/notes.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const json = { ...auth, "Content-Type": "application/json" };

describe("notes", () => {
  it("titles a note from its first line", () => {
    expect(notes.titleFor("# Wifi\npassword is hunter2")).toBe("Wifi");
    expect(notes.titleFor("   ")).toBe("Note");
    expect(notes.titleFor("Gate code 4821. Parking on level 2.")).toBe("Gate code 4821.");
    expect(notes.titleFor("Dr. Lee at 3")).toBe("Dr. Lee at 3");
    expect(notes.titleFor("x".repeat(80))).toHaveLength(58);
  });

  it("creates, appends, replaces and deletes, only for the owner", async () => {
    const note = await notes.createNote("me", "Gate code 4821\nthen the blue door");
    expect(note.title).toBe("Gate code 4821");
    const appended = await notes.updateNote("me", note.id, { body: "parking on level 2", append: true });
    expect(appended?.body).toBe("Gate code 4821\nthen the blue door\nparking on level 2");
    expect((await notes.updateNote("me", note.id, { body: "new text", title: "Mum's flat" }))?.body).toBe("new text");
    expect(await notes.updateNote("someone-else", note.id, { body: "x" })).toBeNull();
    expect(await notes.updateNote("me", "not-a-uuid", { body: "x" })).toBeNull();
    expect(await notes.deleteNote("someone-else", note.id)).toBe(false);
    expect(await notes.deleteNote("me", note.id)).toBe(true);
    expect(await notes.getNote("me", note.id)).toBeNull();
  });

  it("finds notes containing every word, title matches first", async () => {
    const recipe = await notes.createNote("me", "200g flour, 2 eggs, milk", "Pancakes");
    const ideas = await notes.createNote("me", "A pancakes pan for Dad", "Gift ideas");
    await notes.createNote("me", "Nothing related");
    await notes.createNote("someone-else", "pancakes");
    expect((await notes.findNotes("me", "PANCAKES")).map((n) => n.id)).toEqual([recipe.id, ideas.id]);
    expect((await notes.findNotes("me", "pancakes dad")).map((n) => n.id)).toEqual([ideas.id]);
    expect(await notes.findNotes("me", "100%")).toEqual([]);
    expect(await notes.findNotes("me")).toHaveLength(3);
    expect(notes.describeNotes([recipe])).toContain(`[${recipe.id}] Pancakes (`);
  });

  it("serves notes over the API and includes them in export and erase", async () => {
    const created = await app.request("/api/notes", { method: "POST", headers: json, body: JSON.stringify({ body: "Locker 113" }) });
    const note = (await created.json()) as notes.Note;
    expect(note.title).toBe("Locker 113");
    const bad = await app.request("/api/notes", { method: "POST", headers: json, body: JSON.stringify({ body: " " }) });
    expect(bad.status).toBe(400);

    const patched = await app.request(`/api/notes/${note.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "Gym" }) });
    expect(await patched.json()).toMatchObject({ title: "Gym", body: "Locker 113" });
    expect((await app.request("/api/notes?q=locker", { headers: auth }).then((r) => r.json())) as unknown[]).toHaveLength(1);

    expect((await exportData("me")).notes).toMatchObject([{ title: "Gym", body: "Locker 113" }]);
    await deleteAllData("me");
    expect(await notes.findNotes("me")).toEqual([]);
    const gone = await app.request(`/api/notes/${note.id}`, { method: "DELETE", headers: auth });
    expect(await gone.json()).toEqual({ deleted: false });
  });
});
