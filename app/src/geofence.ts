import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { api, type PlaceReminder, type Settings } from "./api";

/**
 * Place reminders ("remind me when I get home"). The server keeps them; the phone
 * watches each area with a geofence and tells the server when it arrives or leaves.
 * Needs "Always" location access, so it's off until the user turns it on in Settings.
 */

const TASK = "jarvis-place-reminders";
const ENABLED_KEY = "jarvis-place-reminders-on";
// Read in the background, when the phone may be locked: readable after the first unlock.
const BG_KEY = "jarvis-place-reminders-bg";
const BG = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

interface Background {
  settings: Settings;
  reminders: Pick<PlaceReminder, "id" | "text" | "place_name" | "on_event">[];
  /** Last state the phone reported for each area. */
  inside: Record<string, boolean>;
  /** The areas being watched, to skip restarting when nothing changed. */
  signature: string;
}

export const placeRemindersSupported = Platform.OS !== "web";

async function readBackground(): Promise<Background | null> {
  const raw = await SecureStore.getItemAsync(BG_KEY, BG).catch(() => null);
  return raw ? (JSON.parse(raw) as Background) : null;
}
const writeBackground = (b: Background) => SecureStore.setItemAsync(BG_KEY, JSON.stringify(b), BG);

/**
 * Whether a geofence report is the arrival or departure a reminder waits for. Watching starts
 * with a report of where the phone is now, and starts again each time the app relaunches, so
 * only a change from the last known state counts; the first report just sets that state.
 */
export function isCrossing(known: boolean | undefined, inside: boolean, onEvent: "arrive" | "leave") {
  if (known === undefined || known === inside) return false;
  return inside === (onEvent === "arrive");
}

type GeofenceEvent = { eventType: Location.GeofencingEventType; region: Location.LocationRegion };

if (placeRemindersSupported) {
  // Defined when the app loads, so the phone can wake it in the background for an event.
  TaskManager.defineTask<GeofenceEvent>(TASK, async ({ data, error }) => {
    const id = data?.region?.identifier;
    if (error || !id) return;
    const bg = await readBackground();
    if (!bg) return;
    const inside = data.eventType === Location.GeofencingEventType.Enter;
    const known = bg.inside[id];
    bg.inside[id] = inside;
    await writeBackground(bg);
    const reminder = bg.reminders.find((r) => r.id === id);
    if (!reminder || !isCrossing(known, inside, reminder.on_event)) return;
    try {
      await api.triggerPlaceReminder(bg.settings, id, inside ? "arrive" : "leave");
    } catch {
      // No connection: show it from the phone instead, so it isn't lost.
      await Notifications.scheduleNotificationAsync({
        content: { title: inside ? `Arrived at ${reminder.place_name}` : `Leaving ${reminder.place_name}`, body: reminder.text },
        trigger: null,
      }).catch(() => {});
    }
  });
}

export async function placeRemindersEnabled() {
  if (!placeRemindersSupported) return false;
  return (await SecureStore.getItemAsync(ENABLED_KEY)) === "1";
}

/** Watches the areas of the active place reminders, or stops watching when there are none. */
export async function syncPlaceReminders(settings: Settings) {
  if (!(await placeRemindersEnabled())) return;
  const { granted } = await Location.getBackgroundPermissionsAsync();
  if (!granted) return;
  const reminders = await api.placeReminders(settings);
  const previous = await readBackground();
  const signature = reminders.map((r) => `${r.id}:${r.latitude}:${r.longitude}:${r.radius_m}:${r.on_event}`).join("|");
  const inside = Object.fromEntries(Object.entries(previous?.inside ?? {}).filter(([id]) => reminders.some((r) => r.id === id)));
  await writeBackground({
    settings,
    reminders: reminders.map(({ id, text, place_name, on_event }) => ({ id, text, place_name, on_event })),
    inside,
    signature,
  });
  const started = await Location.hasStartedGeofencingAsync(TASK).catch(() => false);
  if (reminders.length === 0) {
    if (started) await Location.stopGeofencingAsync(TASK);
    return;
  }
  if (started && previous?.signature === signature) return;
  await Location.startGeofencingAsync(
    TASK,
    reminders.map((r) => ({
      identifier: r.id,
      latitude: r.latitude,
      longitude: r.longitude,
      radius: r.radius_m,
      // Both, so the phone's last known state stays current; the task only acts on the one asked for.
      notifyOnEnter: true,
      notifyOnExit: true,
    })),
  );
}

/** Stops watching and forgets the copy of the sign-in kept for the background. */
export async function stopPlaceReminders() {
  if (!placeRemindersSupported) return;
  await SecureStore.deleteItemAsync(ENABLED_KEY);
  await SecureStore.deleteItemAsync(BG_KEY, BG);
  if (await Location.hasStartedGeofencingAsync(TASK).catch(() => false)) await Location.stopGeofencingAsync(TASK);
}

/** The Settings switch. Turning it on asks for location access "Always". */
export function usePlaceReminderSetting(settings: Settings) {
  const [on, setOnState] = useState(false);
  useEffect(() => {
    placeRemindersEnabled().then(setOnState);
  }, []);
  const setOn = useCallback(
    async (value: boolean): Promise<string | null> => {
      if (value) {
        const fg = await Location.requestForegroundPermissionsAsync();
        if (!fg.granted) return "Jarvis needs location access for this. You can allow it in the phone's Settings.";
        const bgp = await Location.requestBackgroundPermissionsAsync();
        if (!bgp.granted) return "Place reminders need location access set to Always, so they work while Jarvis is closed. You can change it in the phone's Settings, under Jarvis, Location.";
        await SecureStore.setItemAsync(ENABLED_KEY, "1");
        setOnState(true);
        await syncPlaceReminders(settings);
      } else {
        await stopPlaceReminders();
        setOnState(false);
      }
      return null;
    },
    [settings],
  );
  return { on, setOn };
}

/** The phone's position now, as exactly as it can tell, for saving a place. */
export async function preciseLocation() {
  const { granted } = await Location.requestForegroundPermissionsAsync();
  if (!granted) return null;
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { latitude: p.coords.latitude, longitude: p.coords.longitude };
}
