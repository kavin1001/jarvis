/** Wall-clock parts of an instant in a time zone. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

/** The instant at which the wall clock in `timeZone` reads the given time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Correct by the zone's offset at the guess, then once more across a DST edge.
  let utc = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    utc += guess - asUtc;
  }
  return new Date(utc);
}

/** Next time a repeating reminder fires, keeping the same local wall-clock time. */
export function nextOccurrence(previous: Date, repeat: "daily" | "weekdays" | "weekly", timeZone: string): Date {
  const p = zonedParts(previous, timeZone);
  const step = repeat === "weekly" ? 7 : 1;
  for (let add = step; ; add += step) {
    // Date.UTC normalises day overflow (Jan 32 -> Feb 1).
    const local = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    const weekday = local.getUTCDay();
    if (repeat === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    return zonedToUtc(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), p.hour, p.minute, p.second, timeZone);
  }
}

/** "Thursday, October 29, 2026, 9:30 AM" in the user's zone, for the model's context. */
export function describeNow(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
