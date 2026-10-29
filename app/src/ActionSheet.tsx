import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Text, useStyles, type Palette } from "./theme";

export interface SheetAction {
  label: string;
  onPress: () => void;
  danger?: boolean;
}

/** A bottom sheet of actions that looks the same on phones and on the web. */
export function ActionSheet({ actions, onClose }: { actions: SheetAction[] | null; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Modal visible={actions !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <View style={styles.sheet}>
          {actions?.map((a) => (
            <Pressable
              key={a.label}
              style={styles.action}
              accessibilityRole="button"
              onPress={() => {
                onClose();
                a.onPress();
              }}
            >
              <Text style={[styles.label, a.danger && styles.danger]}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable style={[styles.action, styles.cancel]} onPress={onClose} accessibilityRole="button">
            <Text style={[styles.label, { fontWeight: "600" }]}>Cancel</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)", padding: 12 },
    sheet: { backgroundColor: colors.background, borderRadius: 14, overflow: "hidden", maxWidth: 520, width: "100%", alignSelf: "center" },
    action: { paddingVertical: 16, alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    cancel: { borderBottomWidth: 0 },
    label: { fontSize: 17, color: colors.accent },
    danger: { color: colors.danger },
  });
