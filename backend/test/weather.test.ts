import { afterEach, describe, expect, it, vi } from "vitest";
import { findPlace, weatherReport } from "../src/weather.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: (url: URL) => unknown) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      urls.push(url);
      return Response.json(body(url));
    }),
  );
  return urls;
}

const hours = Array.from({ length: 48 }, (_, i) => `2026-10-${29 + Math.floor(i / 24)}T${String(i % 24).padStart(2, "0")}:00`);
const forecast = {
  current: { time: "2026-10-29T08:15", temperature_2m: 14.4, apparent_temperature: 12.6, weather_code: 2, wind_speed_10m: 11.2 },
  hourly: {
    time: hours,
    temperature_2m: hours.map((_, i) => 10 + (i % 24) / 2),
    precipitation_probability: hours.map((h) => (h.endsWith("T15:00") ? 70 : 5)),
    weather_code: hours.map(() => 3),
  },
  daily: {
    time: ["2026-10-29", "2026-10-30", "2026-10-31"],
    weather_code: [61, 0, 95],
    temperature_2m_max: [19.6, 21, 17],
    temperature_2m_min: [9.2, 10, 8],
    precipitation_probability_max: [70, 0, null],
    sunrise: ["2026-10-29T07:25", "2026-10-30T07:26", "2026-10-31T07:27"],
    sunset: ["2026-10-29T18:12", "2026-10-30T18:11", "2026-10-31T18:10"],
  },
};

describe("weather", () => {
  it("summarizes now, the next 12 hours and each day", async () => {
    const urls = stubFetch(() => forecast);
    const text = await weatherReport({ name: "Lisbon, Portugal", latitude: 38.72, longitude: -9.14 }, { days: 3, units: "celsius" });
    expect(text).toContain("Weather for Lisbon, Portugal (local time 2026-10-29 08:15)");
    expect(text).toContain("Now: 14°C (feels like 13°C), partly cloudy, wind 11 km/h.");
    // 08:00 to 19:00: temperatures 14 to 19.5, wettest at 15:00.
    expect(text).toContain("Next 12 hours: 14°C to 20°C; rain chance peaks at 70% around 15:00.");
    expect(text).toContain("Today (2026-10-29): 9°C to 20°C, light rain, 70% chance of rain; sunrise 07:25, sunset 18:12.");
    expect(text).toContain("Tomorrow (2026-10-30): 10°C to 21°C, clear, 0% chance of rain");
    expect(text).toContain("Saturday (2026-10-31): 8°C to 17°C, thunderstorms, 0% chance of rain");
    const q = urls[0].searchParams;
    expect([q.get("latitude"), q.get("forecast_days"), q.get("temperature_unit"), q.get("wind_speed_unit")]).toEqual(["38.72", "3", "celsius", "kmh"]);
  });

  it("uses Fahrenheit and mph when asked", async () => {
    const urls = stubFetch(() => forecast);
    const text = await weatherReport({ name: "x", latitude: 1, longitude: 2 }, { days: 1, units: "fahrenheit" });
    expect(text).toContain("°F");
    expect(text).toContain("mph");
    expect(urls[0].searchParams.get("wind_speed_unit")).toBe("mph");
  });

  it("finds a place, using the part after the comma to choose", async () => {
    const urls = stubFetch(() => ({
      results: [
        { name: "Paris", latitude: 48.85, longitude: 2.35, country: "France", admin1: "Île-de-France", country_code: "FR" },
        { name: "Paris", latitude: 33.66, longitude: -95.55, country: "United States", admin1: "Texas", country_code: "US" },
      ],
    }));
    expect(await findPlace("Paris")).toEqual({ name: "Paris, Île-de-France, France", latitude: 48.85, longitude: 2.35 });
    expect(await findPlace("Paris, Texas")).toMatchObject({ latitude: 33.66 });
    expect(urls[1].searchParams.get("name")).toBe("Paris");

    stubFetch(() => ({}));
    expect(await findPlace("Nowhere-at-all")).toBeNull();
  });

  it("reports a failing service", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    await expect(weatherReport({ name: "x", latitude: 1, longitude: 2 }, { days: 1, units: "celsius" })).rejects.toThrow("503");
  });
});
