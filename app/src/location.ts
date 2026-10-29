import * as Location from "expo-location";
import * as SecureStore from "./storage";

const KEY = "jarvis-share-location";

export interface ApproxLocation {
  latitude: number;
  longitude: number;
  label?: string;
}

export async function locationSharingEnabled() {
  return (await SecureStore.getItemAsync(KEY)) === "1";
}

/** Turning it on asks for permission; returns whether sharing is now on. */
export async function setLocationSharing(on: boolean) {
  if (on) {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) return false;
  }
  await SecureStore.setItemAsync(KEY, on ? "1" : "0");
  cached = null;
  return on;
}

let cached: { at: number; value: ApproxLocation } | null = null;

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

/**
 * Approximate location (about 1 km) for "near me" questions, or undefined when
 * sharing is off or the phone can't tell quickly. Never delays a message by more than ~3 s.
 */
export async function approximateLocation(): Promise<ApproxLocation | undefined> {
  if (!(await locationSharingEnabled())) return undefined;
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
  const { granted } = await Location.getForegroundPermissionsAsync();
  if (!granted) return undefined;
  try {
    const position =
      (await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 })) ??
      (await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), 3000));
    if (!position) return undefined;
    const round = (n: number) => Math.round(n * 100) / 100;
    const value: ApproxLocation = { latitude: round(position.coords.latitude), longitude: round(position.coords.longitude) };
    const [place] = (await withTimeout(Location.reverseGeocodeAsync(position.coords), 1500)) ?? [];
    if (place) value.label = [place.city ?? place.subregion, place.region, place.country].filter(Boolean).join(", ");
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return undefined;
  }
}
