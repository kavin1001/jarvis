import { Pressable, StyleSheet, View } from "react-native";
import { Text, useStyles, type Palette } from "./theme";

export type Tab = "chat" | "history" | "tasks" | "memory" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "history", label: "History" },
  { key: "tasks", label: "Tasks" },
  { key: "memory", label: "Memory" },
  { key: "settings", label: "Settings" },
];

export function TabBar({ tab, onChange, badges }: { tab: Tab; onChange: (t: Tab) => void; badges: Partial<Record<Tab, number>> }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.bar}>
      {TABS.map((t) => (
        <Pressable key={t.key} style={styles.tab} onPress={() => onChange(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
          <Text style={[styles.label, tab === t.key && styles.active]}>{t.label}</Text>
          {badges[t.key] ? <Text style={styles.badge}>{badges[t.key]}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    tab: { flex: 1, alignItems: "center", paddingVertical: 12, flexDirection: "row", justifyContent: "center", gap: 4 },
    label: { color: colors.muted, fontSize: 13, fontWeight: "500" },
    active: { color: colors.accent },
    badge: { backgroundColor: colors.danger, color: colors.onAccent, fontSize: 11, borderRadius: 8, paddingHorizontal: 5, overflow: "hidden" },
  });
