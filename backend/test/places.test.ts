import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteAllData, exportData } from "../src/account.js";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import * as memory from "../src/memory.js";
import * as places from "../src/places.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const json = { ...auth, "Content-Type": "application/json" };
const home = { name: "Home", latitude: 40.7128, longitude: -74.006, radius_m: places.PRECISE_RADIUS_M };

describe("place reminders", () => {
  it("sends a one-off reminder on the right event, once", async () => {
    const conv = await memory.createConversation("me");
    const id = await places.createPlaceReminder({ userId: "me", conversationId: conv, text: "Take the bins out", place: home, on: "arrive", everyTime: false });
    expect(await places.listPlaceReminders("me")).toMatchObject([{ id, place_name: "home", radius_m: 150, on_event: "arrive" }]);

    expect(await places.triggerPlaceReminder("me", id, "leave")).toBe("ignored");
    expect(await places.triggerPlaceReminder("me", id, "arrive")).toBe("sent");
    expect(await places.triggerPlaceReminder("me", id, "arrive")).toBe("ignored");
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(["Reminder: Take the bins out"]);
    expect(await places.listPlaceReminders("me")).toEqual([]);
    expect(await places.triggerPlaceReminder("someone-else", id, "arrive")).toBe("not_found");
    expect(await places.triggerPlaceReminder("me", "nope", "arrive")).toBe("not_found");
  });

  it("repeats an every-time reminder, but not when the edge of the area flickers", async () => {
    const id = await places.createPlaceReminder({ userId: "me", conversationId: null, text: "Log your workout", place: { ...home, name: "gym" }, on: "leave", everyTime: true });
    const t0 = new Date("2026-10-29T18:00:00Z");
    expect(await places.triggerPlaceReminder("me", id, "leave", t0)).toBe("sent");
    expect(await places.triggerPlaceReminder("me", id, "leave", new Date(t0.getTime() + 2 * 60_000))).toBe("ignored");
    expect(await places.triggerPlaceReminder("me", id, "leave", new Date(t0.getTime() + 24 * 3600_000))).toBe("sent");
    expect(await places.listPlaceReminders("me")).toHaveLength(1);
    expect(places.describePlaceReminder({ on_event: "leave", place_name: "gym", every_time: true })).toBe("every time you leave gym");
    expect(places.describePlaceReminder({ on_event: "arrive", place_name: "home", every_time: false })).toBe("when you get home");
  });

  it("caps how many places the phone has to watch", async () => {
    for (let i = 0; i < places.MAX_ACTIVE; i++)
      await places.createPlaceReminder({ userId: "me", conversationId: null, text: `r${i}`, place: home, on: "arrive", everyTime: false });
    await expect(places.createPlaceReminder({ userId: "me", conversationId: null, text: "one more", place: home, on: "arrive", everyTime: false })).rejects.toThrow(/at most 20/);
  });

  it("saves places and triggers over the API", async () => {
    const save = (body: unknown) => app.request("/api/places", { method: "POST", headers: json, body: JSON.stringify(body) });
    expect(await (await save({ name: " Work ", latitude: 40.75, longitude: -73.99 })).json()).toEqual({ name: "work" });
    expect((await save({ name: "x", latitude: 100, longitude: 0 })).status).toBe(400);
    // Saving again moves it.
    await save({ name: "work", latitude: 40.76, longitude: -73.98 });
    expect(await (await app.request("/api/places", { headers: auth })).json()).toEqual([{ name: "work", latitude: 40.76, longitude: -73.98, radius_m: 150 }]);

    const id = await places.createPlaceReminder({ userId: "me", conversationId: null, text: "Call Mom", place: (await places.getPlace("me", "WORK"))!, on: "leave", everyTime: false });
    const trigger = (rid: string, event: string) =>
      app.request(`/api/place-reminders/${rid}/trigger`, { method: "POST", headers: json, body: JSON.stringify({ event }) });
    expect((await trigger(id, "teleport")).status).toBe(400);
    expect(await (await trigger(id, "arrive")).json()).toEqual({ sent: false });
    expect(await (await trigger(id, "leave")).json()).toEqual({ sent: true });
    expect((await trigger("00000000-0000-0000-0000-000000000000", "leave")).status).toBe(404);

    const other = await places.createPlaceReminder({ userId: "me", conversationId: null, text: "x", place: home, on: "arrive", everyTime: false });
    expect(await (await app.request("/api/place-reminders", { headers: auth })).json()).toMatchObject([{ id: other }]);
    expect(await (await app.request(`/api/place-reminders/${other}`, { method: "DELETE", headers: auth })).json()).toEqual({ cancelled: true });
    expect(await (await app.request("/api/places/work", { method: "DELETE", headers: auth })).json()).toEqual({ deleted: true });
  });

  it("is part of export and erase", async () => {
    await places.savePlace("me", home);
    await places.createPlaceReminder({ userId: "me", conversationId: await memory.createConversation("me"), text: "Water plants", place: home, on: "arrive", everyTime: false });
    const data = await exportData("me");
    expect(data.places).toMatchObject([{ name: "home" }]);
    expect(data.place_reminders).toMatchObject([{ text: "Water plants", place_name: "home" }]);
    await deleteAllData("me");
    expect(await places.listPlaces("me")).toEqual([]);
    expect(await places.listPlaceReminders("me")).toEqual([]);
  });
});
