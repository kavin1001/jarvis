import Constants from "expo-constants";
import { Platform } from "react-native";
import { loadSettings } from "./api";

type Where = "render" | "global" | "promise";

// A crash loop would otherwise send the same report over and over.
const sent = new Set<string>();
const MAX_PER_LAUNCH = 10;

/** Sends an app error to the backend's logs. Best effort: never throws, and quiet when signed out or offline. */
export async function reportError(error: unknown, where: Where, fatal = false) {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const key = `${where}:${err.message}`;
    if (sent.has(key) || sent.size >= MAX_PER_LAUNCH) return;
    sent.add(key);
    const settings = await loadSettings();
    if (!settings) return;
    await fetch(`${settings.url}/api/client-errors`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: err.message.slice(0, 2000) || err.name,
        stack: err.stack?.slice(0, 8000),
        where,
        fatal,
        platform: Platform.OS,
        version: (Constants.expoConfig?.version ?? "?").slice(0, 40),
      }),
    });
  } catch {
    // Reporting must never be the thing that breaks.
  }
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsShape {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

/** Reports errors no component caught: thrown in event handlers or timers, and unhandled promise rejections on the web. */
export function installGlobalErrorReporting() {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      reportError(error, "global", Boolean(isFatal));
      previous(error, isFatal);
    });
  }
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.addEventListener("error", (e) => reportError(e.error ?? e.message, "global"));
    window.addEventListener("unhandledrejection", (e) => reportError(e.reason, "promise"));
  }
}
