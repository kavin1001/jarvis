import { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, Text } from "react-native";
import { api, type Conversation, type Settings } from "../api";
import { Empty, Header, LinkButton, relativeTime, styles } from "../ui";

export default function HistoryScreen({
  settings,
  current,
  onOpen,
}: {
  settings: Settings;
  current: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.conversations(settings));
    } finally {
      setLoading(false);
    }
  }, [settings]);
  useEffect(() => {
    load();
  }, [load]);

  function confirmDelete(c: Conversation) {
    Alert.alert("Delete conversation?", c.title ?? "Untitled", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await api.deleteConversation(settings, c.id);
          if (c.id === current) onOpen(undefined);
          load();
        },
      },
    ]);
  }

  return (
    <>
      <Header title="History" right={<LinkButton label="New chat" onPress={() => onOpen(undefined)} />} />
      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListEmptyComponent={loading ? undefined : <Empty text="No conversations yet." />}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onOpen(item.id)} onLongPress={() => confirmDelete(item)}>
            <Text style={[styles.rowTitle, item.id === current && { fontWeight: "700" }]} numberOfLines={1}>
              {item.title || "Untitled"}
            </Text>
            <Text style={styles.rowMeta}>{relativeTime(item.updated_at)} · hold to delete</Text>
          </Pressable>
        )}
      />
    </>
  );
}
