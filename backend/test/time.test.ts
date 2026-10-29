import { describe, expect, it } from "vitest";
import { firstOccurrence, nextOccurrence, zonedToUtc } from "../src/time.js";

describe("time zones", () => {
  it("converts a local wall time to UTC", () => {
    expect(zonedToUtc(2026, 7, 1, 9, 0, 0, "America/Los_Angeles").toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(zonedToUtc(2026, 12, 1, 9, 0, 0, "America/Los_Angeles").toISOString()).toBe("2026-12-01T17:00:00.000Z");
  });

  it("keeps 9am local across a DST change", () => {
    // US clocks fall back on 2026-11-01.
    const before = new Date("2026-10-31T16:00:00Z"); // 9am PDT
    expect(nextOccurrence(before, "daily", "America/Los_Angeles").toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("skips weekends for weekday reminders", () => {
    const friday = new Date("2026-10-30T15:00:00Z"); // 8am PDT Friday
    expect(nextOccurrence(friday, "weekdays", "America/Los_Angeles").toISOString()).toBe("2026-11-02T16:00:00.000Z");
  });

  it("repeats weekly across a month end", () => {
    const d = new Date("2026-01-28T12:00:00Z");
    expect(nextOccurrence(d, "weekly", "UTC").toISOString()).toBe("2026-02-04T12:00:00.000Z");
  });
});

describe("firstOccurrence", () => {
  const tz = "America/Chicago";
  it("uses today when the time is still ahead, otherwise tomorrow", () => {
    const now = new Date("2026-10-29T12:00:00Z"); // 7:00 AM in Chicago, a Thursday
    expect(firstOccurrence(8, 0, "daily", tz, now).toISOString()).toBe("2026-10-29T13:00:00.000Z");
    expect(firstOccurrence(6, 30, "daily", tz, now).toISOString()).toBe("2026-10-30T11:30:00.000Z");
  });
  it("skips the weekend for weekday routines", () => {
    const friday = new Date("2026-10-30T20:00:00Z"); // 3 PM Friday in Chicago
    // Monday Nov 2 is after the DST change, so 8 AM CST is 14:00 UTC.
    expect(firstOccurrence(8, 0, "weekdays", tz, friday).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});
