import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Alert } from "../dialog";
import { api, type Device, type Settings } from "../api";
import { LinkButton, relativeTime, useShared } from "../ui";
import { Text } from "../theme";

/** Settings section: signed-in devices, revoke, and a code to pair another one. */
export function Devices({ settings, onSignOut }: { settings: Settings; onSignOut: () => void }) {
  const styles = useShared();
  const [devices, setDevices] = useState<Device[]>([]);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => api.devices(settings).then(setDevices).catch(() => {}), [settings]);
  useEffect(() => {
    load();
  }, [load]);

  async function pair() {
    try {
      const { code } = await api.pairingCode(settings);
      Alert.alert("Pairing code", `${code}\n\nOn the new device, enter your backend URL and this code. It works once, for 10 minutes.`);
    } catch (err) {
      Alert.alert("Couldn't create a code", String(err));
    }
  }

  function revoke(d: Device) {
    Alert.alert(`Sign out ${d.name}?`, d.current ? "This is the phone you're using." : "It will need a new pairing code to come back.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => api.revokeDevice(settings, d.id).then(() => (d.current ? onSignOut() : load())),
      },
    ]);
  }

  function revokeOthers() {
    const others = devices.filter((d) => !d.current);
    Alert.alert(`Sign out ${others.length} other device${others.length === 1 ? "" : "s"}?`, "Only this one stays signed in. The others need a new pairing code to come back.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () =>
          Promise.all(others.map((d) => api.revokeDevice(settings, d.id))).then(load, (err) => {
            Alert.alert("Couldn't sign them all out", String(err));
            load();
          }),
      },
    ]);
  }

  // This device first, then the most recently used.
  const sorted = [...devices].sort(
    (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.last_seen_at ?? "0") - Date.parse(a.last_seen_at ?? "0"),
  );
  const LIMIT = 5;
  const shown = showAll ? sorted : sorted.slice(0, LIMIT);

  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>Signed-in devices</Text>
      {shown.map((d) => (
        <View key={d.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>
              {d.name}
              {d.current ? " (this device)" : ""}
            </Text>
            <Text style={styles.rowMeta}>{d.last_seen_at ? `Active ${relativeTime(d.last_seen_at)}` : "Never used"}</Text>
          </View>
          <LinkButton label="Sign out" danger onPress={() => revoke(d)} />
        </View>
      ))}
      {sorted.length > LIMIT ? (
        <View style={{ alignItems: "flex-start", paddingVertical: 4 }}>
          <LinkButton label={showAll ? "Show fewer" : `Show all ${sorted.length}`} onPress={() => setShowAll(!showAll)} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap", paddingTop: 4 }}>
        <LinkButton label="Pair another device" onPress={pair} />
        {devices.some((d) => d.current) && devices.length > 1 ? <LinkButton label="Sign out the others" danger onPress={revokeOthers} /> : null}
      </View>
    </View>
  );
}
