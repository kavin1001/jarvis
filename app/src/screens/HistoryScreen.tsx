import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl } from "react-native";
import { Alert } from "../dialog";
import { api, type Conversation, type SearchHit, type Settings } from "../api";
import { Empty, Header, LinkButton, relativeTime, useShared } from "../ui";
import { Text, TextInput, useColors } from "../theme";

export default function HistoryScreen({
  settings,
  current,
  onOpen,
}: {
  settings: Settings;
  current: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const styles = useShared();
  const colors = useColors();
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  // Debounced search; an empty box shows the conversation list again.
  useEffect(() => {
    const term = q.trim();
    if (!term) return setHits(null);
    const timer = setTimeout(
      () =>
        api
          .search(settings, term)
          .then(setHits)
          .catch(() => setHits([])),
      300,
    );
    return () => clearTimeout(timer);
  }, [q, settings]);

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
      <TextInput
        style={{
          marginHorizontal: 16,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: colors.inputBorder,
          borderRadius: 8,
          padding: 10,
        }}
        value={q}
        onChangeText={setQ}
        placeholder="Search past chats"
        clearButtonMode="while-editing"
        returnKeyType="search"
      />
      {hits ? (
        <FlatList
          data={hits}
          keyExtractor={(h, i) => `${h.conversation_id}-${i}`}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Empty text="Nothing matches." />}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onOpen(item.conversation_id)}>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {item.title || "Untitled"} · {item.role === "user" ? "You" : "Jarvis"} · {relativeTime(item.created_at)}
              </Text>
              <Text numberOfLines={3}>
                {item.snippet.split(/(«[^»]*»)/).map((part, i) =>
                  part.startsWith("«") ? (
                    <Text key={i} style={{ fontWeight: "700" }}>
                      {part.slice(1, -1)}
                    </Text>
                  ) : (
                    part
                  ),
                )}
              </Text>
            </Pressable>
          )}
        />
      ) : (
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
      )}
    </>
  );
}
