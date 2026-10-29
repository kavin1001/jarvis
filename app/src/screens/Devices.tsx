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

  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>Signed-in devices</Text>
      {devices.map((d) => (
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
      <View style={{ alignItems: "flex-start" }}>
        <LinkButton label="Pair another device" onPress={pair} />
      </View>
    </View>
  );
}
