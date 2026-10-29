import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

/**
 * Copies of lists and notes kept on the device, so the shopping list still opens in a
 * supermarket with no signal. Files in the app's documents folder on a phone (they can
 * be larger than the secure store allows), localStorage in the web build.
 */

const web = Platform.OS === "web";
const PREFIX = "jarvis.cache.";
const dir = () => new Directory(Paths.document, "offline");

export interface Cached<T> {
  saved_at: string;
  value: T;
}

export async function readCache<T>(name: string): Promise<Cached<T> | null> {
  try {
    const raw = web ? globalThis.localStorage?.getItem(PREFIX + name) : await fileFor(name).text();
    return raw ? (JSON.parse(raw) as Cached<T>) : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(name: string, value: T) {
  const raw = JSON.stringify({ saved_at: new Date().toISOString(), value } satisfies Cached<T>);
  try {
    if (web) return globalThis.localStorage?.setItem(PREFIX + name, raw);
    if (!dir().exists) dir().create({ intermediates: true });
    const file = fileFor(name);
    if (!file.exists) file.create();
    await file.write(raw);
  } catch (err) {
    console.warn("couldn't save offline copy", err);
  }
}

/** On sign-out and erase: nothing personal stays on the device. */
export async function clearCache() {
  try {
    if (web) {
      for (const key of Object.keys(globalThis.localStorage ?? {})) if (key.startsWith(PREFIX)) globalThis.localStorage.removeItem(key);
    } else if (dir().exists) {
      dir().delete();
    }
  } catch (err) {
    console.warn("couldn't clear offline copies", err);
  }
}

const fileFor = (name: string) => new File(dir(), `${name.replace(/[^\w-]/g, "_")}.json`);
