import { useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { api, type NotifySettings as Prefs, type Settings } from "../api";
import { Alert } from "../dialog";
import { Text } from "../theme";
import { useShared } from "../ui";

const ROWS: [keyof Prefs, string, string][] = [
  ["replies", "Replies", "When an answer finishes after you've left the app."],
  ["tasks", "Finished tasks", "When a background task is done or fails."],
  ["spending", "Spending", "Once a day, when spend nears the daily cap."],
];

/** Settings, Notifications: the kinds you can turn off. Approvals and reminders always notify. */
export function NotifySettings({ settings }: { settings: Settings }) {
  const styles = useShared();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    api.notifySettings(settings).then(setPrefs, () => setPrefs(null));
  }, [settings]);
  if (!prefs) return null;

  async function toggle(key: keyof Prefs, on: boolean) {
    setPrefs({ ...prefs!, [key]: on });
    try {
      setPrefs(await api.setNotifySettings(settings, { [key]: on }));
    } catch (err) {
      setPrefs(prefs);
      Alert.alert("Couldn't save", String(err));
    }
  }

  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>Approvals and reminders always notify.</Text>
      {ROWS.map(([key, title, detail]) => (
        <View key={key} style={{ flexDirection: "row", alignItems: "center", paddingTop: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{title}</Text>
            <Text style={styles.rowMeta}>{detail}</Text>
          </View>
          <Switch value={prefs[key]} onValueChange={(on) => toggle(key, on)} accessibilityLabel={`${title} notifications`} />
        </View>
      ))}
    </View>
  );
}
