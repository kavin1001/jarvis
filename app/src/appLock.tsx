import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, Platform, Pressable, View } from "react-native";
import * as storage from "./storage";
import { Text, useColors } from "./theme";

/** Locks the app behind Face ID, Touch ID or the phone's passcode, if the user turned it on. */

const KEY = "jarvis-lock";
// Switching away briefly (to copy a code, say) doesn't lock; a minute away does.
const GRACE_MS = 60_000;

// undefined until read from storage, so the app doesn't flash open before locking.
let enabled: boolean | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
// The web build has no lock (see appLockAvailable), so a stray stored value can't lock it.
storage
  .getItemAsync(KEY)
  .then((v) => (enabled = v === "on" && Platform.OS !== "web"), () => (enabled = false))
  .finally(notify);

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const getEnabled = () => enabled;

async function authenticate() {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Jarvis" });
  return result.success;
}

/** Whether this phone can lock the app: biometrics or a passcode is set up. Never on the web. */
export async function appLockAvailable() {
  if (Platform.OS === "web") return false;
  const [hardware, level] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
  ]);
  return hardware || level !== LocalAuthentication.SecurityLevel.NONE;
}

export function useAppLockSetting() {
  const on = useSyncExternalStore(subscribe, getEnabled) ?? false;
  /** Turning it on asks to authenticate first, so a lock that can't be opened is never set. */
  const setOn = useCallback(async (value: boolean) => {
    if (value && !(await authenticate())) return false;
    enabled = value;
    if (value) await storage.setItemAsync(KEY, "on");
    else await storage.deleteItemAsync(KEY);
    notify();
    return true;
  }, []);
  return { on, setOn };
}

export function AppLock({ children }: { children: ReactNode }) {
  const on = useSyncExternalStore(subscribe, getEnabled);
  const colors = useColors();
  const [locked, setLockedState] = useState(true);
  const lockedRef = useRef(true);
  const setLocked = (value: boolean) => {
    lockedRef.current = value;
    setLockedState(value);
  };
  const [active, setActive] = useState(AppState.currentState === "active");
  const leftAt = useRef<number | null>(null);
  const prompting = useRef(false);

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    try {
      if (await authenticate()) setLocked(false);
    } finally {
      prompting.current = false;
    }
  }, []);

  useEffect(() => {
    if (on === false) setLocked(false);
    else if (on && lockedRef.current && AppState.currentState === "active") unlock();
  }, [on]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
      // The Face ID sheet itself makes the app inactive; only a real trip away counts.
      if (state === "background") leftAt.current ??= Date.now();
      if (state !== "active" || !enabled) return;
      const away = leftAt.current === null ? 0 : Date.now() - leftAt.current;
      leftAt.current = null;
      if (away > GRACE_MS) setLocked(true);
      if (lockedRef.current) unlock();
    });
    return () => sub.remove();
  }, [unlock]);

  // While locked and in the app switcher, a cover hides the chats. The app stays
  // mounted underneath, in the same tree whether or not the lock is on, so a reply
  // in progress or a draft isn't lost.
  const loading = on === undefined;
  const covered = on !== false && (loading || locked || !active);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} accessibilityElementsHidden={covered} importantForAccessibility={covered ? "no-hide-descendants" : "auto"}>
        {children}
      </View>
      {covered && (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            backgroundColor: colors.background,
          }}
        >
          {!loading && locked && <Text style={{ fontSize: 22, fontWeight: "700" }}>Jarvis is locked</Text>}
          {!loading && locked && (
            <Pressable
              onPress={unlock}
              accessibilityRole="button"
              style={{ backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10 }}
            >
              <Text style={{ color: colors.onAccent, fontWeight: "600" }}>Unlock</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
