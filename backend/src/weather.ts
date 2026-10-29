/**
 * Weather from Open-Meteo (open-meteo.com): free, no key or account, and quicker
 * and cheaper than a web search for "do I need an umbrella?".
 */

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

// WMO weather interpretation codes, as Open-Meteo documents them.
const CONDITIONS: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorms",
  96: "thunderstorms with hail",
  99: "thunderstorms with heavy hail",
};
const condition = (code: number) => CONDITIONS[code] ?? "unknown conditions";

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The weather service answered ${res.status}.`);
  return (await res.json()) as T;
}

/** "Paris", or "Paris, Texas" to pick among places with the same name. */
export async function findPlace(query: string): Promise<Place | null> {
  const [name, ...rest] = query.split(",").map((s) => s.trim());
  const hint = rest.join(" ").toLowerCase();
  const url = new URL(GEOCODE_URL);
  url.search = new URLSearchParams({ name, count: "10", language: "en", format: "json" }).toString();
  const body = await getJson<{ results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string; country_code?: string }[] }>(url);
  const results = body.results ?? [];
  const match =
    (hint && results.find((r) => [r.country, r.admin1, r.country_code].some((v) => v && (v.toLowerCase() === hint || hint.includes(v.toLowerCase()))))) ||
    results[0];
  if (!match) return null;
  return { name: [match.name, match.admin1, match.country].filter(Boolean).join(", "), latitude: match.latitude, longitude: match.longitude };
}

interface Forecast {
  current: { time: string; temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
  hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: (number | null)[]; weather_code: number[] };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    sunrise: string[];
    sunset: string[];
  };
}

const hhmm = (iso: string) => iso.slice(11, 16);

/** A forecast as a few short lines for Claude to answer from. */
export async function weatherReport(place: Place, opts: { days: number; units: "celsius" | "fahrenheit" }): Promise<string> {
  const url = new URL(FORECAST_URL);
  url.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    timezone: "auto",
    forecast_days: String(opts.days),
    temperature_unit: opts.units,
    wind_speed_unit: opts.units === "fahrenheit" ? "mph" : "kmh",
  }).toString();
  const f = await getJson<Forecast>(url);
  const deg = opts.units === "fahrenheit" ? "°F" : "°C";
  const wind = opts.units === "fahrenheit" ? "mph" : "km/h";
  const t = (v: number) => `${Math.round(v)}${deg}`;
  const c = f.current;

  const lines = [
    `Weather for ${place.name} (local time ${c.time.replace("T", " ")}):`,
    `Now: ${t(c.temperature_2m)} (feels like ${t(c.apparent_temperature)}), ${condition(c.weather_code)}, wind ${Math.round(c.wind_speed_10m)} ${wind}.`,
  ];

  // The next 12 hours: when rain is most likely, so "do I need an umbrella at 5?" has an answer.
  const start = Math.max(0, f.hourly.time.findIndex((h) => h >= c.time.slice(0, 13)));
  const next = f.hourly.time.slice(start, start + 12).map((time, i) => ({
    time,
    rain: f.hourly.precipitation_probability[start + i] ?? 0,
    temp: f.hourly.temperature_2m[start + i],
  }));
  if (next.length > 0) {
    const wettest = next.reduce((a, b) => (b.rain > a.rain ? b : a));
    const temps = next.map((h) => h.temp);
    lines.push(
      `Next 12 hours: ${t(Math.min(...temps))} to ${t(Math.max(...temps))}; ` +
        (wettest.rain >= 20 ? `rain chance peaks at ${wettest.rain}% around ${hhmm(wettest.time)}.` : "little chance of rain."),
    );
  }

  const d = f.daily;
  d.time.forEach((day, i) => {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    lines.push(
      `${label} (${day}): ${t(d.temperature_2m_min[i])} to ${t(d.temperature_2m_max[i])}, ${condition(d.weather_code[i])}, ` +
        `${d.precipitation_probability_max[i] ?? 0}% chance of rain; sunrise ${hhmm(d.sunrise[i])}, sunset ${hhmm(d.sunset[i])}.`,
    );
  });
  return lines.join("\n");
}

const glanceCache = new Map<string, { at: number; line: string }>();
const GLANCE_TTL_MS = 15 * 60_000;

/** One short line for the coming-up card: "14°C, partly cloudy · 9 to 20°C, 70% chance of rain". */
export async function weatherGlance(latitude: number, longitude: number, units: "celsius" | "fahrenheit"): Promise<string> {
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)},${units}`;
  const hit = glanceCache.get(key);
  if (hit && Date.now() - hit.at < GLANCE_TTL_MS) return hit.line;
  const url = new URL(FORECAST_URL);
  url.search = new URLSearchParams({
    latitude: latitude.toFixed(2),
    longitude: longitude.toFixed(2),
    current: "temperature_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "1",
    temperature_unit: units,
  }).toString();
  const f = await getJson<Pick<Forecast, "current"> & { daily: Pick<Forecast["daily"], "temperature_2m_max" | "temperature_2m_min" | "precipitation_probability_max"> }>(url);
  const deg = units === "fahrenheit" ? "°F" : "°C";
  const rain = f.daily.precipitation_probability_max[0] ?? 0;
  const line =
    `${Math.round(f.current.temperature_2m)}${deg}, ${condition(f.current.weather_code)} · ` +
    `${Math.round(f.daily.temperature_2m_min[0])} to ${Math.round(f.daily.temperature_2m_max[0])}${deg}` +
    (rain >= 20 ? `, ${rain}% chance of rain` : "");
  if (glanceCache.size > 100) glanceCache.clear();
  glanceCache.set(key, { at: Date.now(), line });
  return line;
}
