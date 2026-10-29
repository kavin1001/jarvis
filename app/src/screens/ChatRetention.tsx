import { useEffect, useState } from "react";
import { View } from "react-native";
import { api, type Settings } from "../api";
import { Alert } from "../dialog";
import { Choices, useShared } from "../ui";
import { Text } from "../theme";

const OPTIONS: [string, string][] = [
  ["forever", "Forever"],
  ["365", "1 year"],
  ["90", "90 days"],
  ["30", "30 days"],
];

/** Settings, Privacy: how long Jarvis keeps chats you haven't used. */
export function ChatRetention({ settings }: { settings: Settings }) {
  const styles = useShared();
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    api.privacy(settings).then((p) => setValue(p.chat_retention_days ? String(p.chat_retention_days) : "forever"), () => setValue(null));
  }, [settings]);

  async function choose(next: string) {
    const days = next === "forever" ? null : Number(next);
    const save = () =>
      api.setChatRetention(settings, days).then(
        ({ deleted }) => {
          setValue(next);
          if (deleted) Alert.alert("Old chats deleted", `${deleted} chat${deleted === 1 ? "" : "s"} went.`);
        },
        (err) => Alert.alert("Couldn't change that", String(err)),
      );
    if (days === null) return save();
    try {
      const { would_delete = 0 } = await api.privacy(settings, days);
      if (would_delete === 0) return save();
      Alert.alert(
        `Delete ${would_delete} chat${would_delete === 1 ? "" : "s"} now?`,
        `They haven't been used for over ${OPTIONS.find(([k]) => k === next)![1]}. Pinned chats are kept. This can't be undone.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => void save() },
        ],
      );
    } catch (err) {
      Alert.alert("Couldn't change that", String(err));
    }
  }

  if (value === null) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>Keep chats</Text>
      <Text style={styles.rowMeta}>Chats you haven't used for longer are deleted. Pinned chats stay.</Text>
      <Choices options={OPTIONS} value={value} onChange={(v) => void choose(v)} />
    </View>
  );
}
