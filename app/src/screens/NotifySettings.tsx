import { useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { api, type NotifySettings as Prefs, type Settings } from "../api";
import { Alert } from "../dialog";
import { Text } from "../theme";
import { Choices, useShared } from "../ui";

type Topic = "replies" | "tasks" | "spending";

const ROWS: [Topic, string, string][] = [
  ["replies", "Replies", "When an answer finishes after you've left the app."],
  ["tasks", "Finished tasks", "When a background task is done or fails."],
  ["spending", "Spending", "Once a day, when spend nears the daily cap."],
];

const hour = (h: number) => (h === 0 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`);
const STARTS: [number, string][] = [21, 22, 23, 0].map((h) => [h * 60, hour(h)]);
const ENDS: [number, string][] = [6, 7, 8, 9].map((h) => [h * 60, hour(h)]);

/** Settings, Notifications: the kinds you can turn off, and quiet hours. Approvals and reminders always notify. */
export function NotifySettings({ settings }: { settings: Settings }) {
  const styles = useShared();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    api.notifySettings(settings).then(setPrefs, () => setPrefs(null));
  }, [settings]);
  if (!prefs) return null;
  const quiet = prefs.quiet_start !== null && prefs.quiet_end !== null;

  async function change(update: Partial<Prefs>) {
    setPrefs({ ...prefs!, ...update });
    try {
      setPrefs(await api.setNotifySettings(settings, update));
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
          <Switch value={prefs[key]} onValueChange={(on) => change({ [key]: on })} accessibilityLabel={`${title} notifications`} />
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", paddingTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Quiet hours</Text>
          <Text style={styles.rowMeta}>Notifications arrive without a sound. Reminders you set still ring.</Text>
        </View>
        <Switch
          value={quiet}
          onValueChange={(on) => change(on ? { quiet_start: 22 * 60, quiet_end: 7 * 60 } : { quiet_start: null, quiet_end: null })}
          accessibilityLabel="Quiet hours"
        />
      </View>
      {quiet ? (
        <>
          <Text style={[styles.rowMeta, { paddingTop: 8 }]}>From</Text>
          <Choices options={STARTS} value={prefs.quiet_start!} onChange={(v) => change({ quiet_start: v })} />
          <Text style={[styles.rowMeta, { paddingTop: 8 }]}>Until</Text>
          <Choices options={ENDS} value={prefs.quiet_end!} onChange={(v) => change({ quiet_end: v })} />
        </>
      ) : null}
    </View>
  );
}
