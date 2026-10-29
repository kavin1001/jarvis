import { describe, expect, it } from "vitest";
import { nextOccurrence, zonedToUtc } from "../src/time.js";

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
