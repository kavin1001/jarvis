import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// SecureStore (Keychain / Keystore) on phones; localStorage in the web build, which has no secure store.
const web = Platform.OS === "web";

export async function getItemAsync(key: string): Promise<string | null> {
  return web ? globalThis.localStorage?.getItem(key) ?? null : SecureStore.getItemAsync(key);
}

export async function setItemAsync(key: string, value: string) {
  if (web) globalThis.localStorage?.setItem(key, value);
  else await SecureStore.setItemAsync(key, value);
}

export async function deleteItemAsync(key: string) {
  if (web) globalThis.localStorage?.removeItem(key);
  else await SecureStore.deleteItemAsync(key);
}
