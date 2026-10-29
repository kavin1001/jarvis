import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState, Pressable, View } from "react-native";
import type { Settings } from "./api";
import { Text, useColors } from "./theme";

type Connection = { online: boolean; check: () => Promise<boolean> };
const ConnectionContext = createContext<Connection>({ online: true, check: async () => true });

/**
 * Watches whether the backend answers /health: every minute while it does,
 * every 10 seconds while it doesn't, and whenever the app comes back to the front.
 */
export function ConnectionProvider({ settings, children }: { settings: Settings; children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const check = useCallback(async () => {
    try {
      const res = await fetch(`${settings.url}/health`);
      setOnline(res.ok);
      return res.ok;
    } catch {
      setOnline(false);
      return false;
    }
  }, [settings.url]);

  useEffect(() => {
    check();
    const timer = setInterval(check, online ? 60_000 : 10_000);
    const sub = AppState.addEventListener("change", (state) => state === "active" && check());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [check, online]);

  return <ConnectionContext.Provider value={{ online, check }}>{children}</ConnectionContext.Provider>;
}

export const useConnection = () => useContext(ConnectionContext);

/** A strip across the top while the backend can't be reached. */
export function OfflineBanner() {
  const { online, check } = useConnection();
  const colors = useColors();
  const [checking, setChecking] = useState(false);
  if (online) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.warning, paddingHorizontal: 16, paddingVertical: 10 }}
    >
      <Text style={{ flex: 1, color: colors.warningText }}>Can't reach your Jarvis server. Check your connection.</Text>
      <Pressable
        onPress={async () => {
          setChecking(true);
          await check();
          setChecking(false);
        }}
        hitSlop={8}
        disabled={checking}
      >
        <Text style={{ color: colors.warningText, fontWeight: "600" }}>{checking ? "Checking…" : "Retry"}</Text>
      </Pressable>
    </View>
  );
}
