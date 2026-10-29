import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, useColors, useStyles, type Palette } from "./theme";

export function Header({ title, right }: { title: string; right?: ReactNode }) {
  const styles = useShared();
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      {right}
    </View>
  );
}

export function LinkButton({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  const styles = useShared();
  const colors = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={[styles.link, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

export function Empty({ text }: { text: string }) {
  const styles = useShared();
  return <Text style={styles.empty}>{text}</Text>;
}

export function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

const makeShared = (colors: Palette) =>
  StyleSheet.create({
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 },
    title: { fontSize: 22, fontWeight: "700" },
    link: { color: colors.accent, fontSize: 16 },
    empty: { color: colors.muted, textAlign: "center", padding: 32 },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 4,
    },
    rowTitle: { fontSize: 16, fontWeight: "500" },
    rowMeta: { fontSize: 13, color: colors.muted },
    input: { borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8, padding: 10 },
  });

/** Styles shared by every screen, in the current theme. */
export const useShared = () => useStyles(makeShared);
