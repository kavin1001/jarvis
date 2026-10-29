import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Share, View } from "react-native";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import * as Clipboard from "expo-clipboard";
import { Alert } from "../dialog";
import { plainText } from "../Markdown";
import { api, type Conversation, type SearchHit, type Settings } from "../api";
import { Empty, Header, LinkButton, relativeTime, useShared } from "../ui";
import { Text, TextInput, useColors, type TextInputHandle } from "../theme";

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
  const [sheet, setSheet] = useState<SheetAction[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const renameBox = useRef<TextInputHandle>(null);
  const renamingId = renaming?.id;
  useEffect(() => {
    // Focus once the action sheet has finished closing, or it takes the focus back.
    if (!renamingId) return;
    const timer = setTimeout(() => renameBox.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [renamingId]);

  async function saveTitle() {
    const r = renaming;
    setRenaming(null);
    if (!r?.title.trim()) return;
    try {
      await api.renameConversation(settings, r.id, r.title.trim());
      load();
    } catch (err) {
      Alert.alert("Couldn't rename", String(err));
    }
  }

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

  async function shareTranscript(c: Conversation) {
    let text: string;
    try {
      const messages = await api.messages(settings, c.id);
      const lines = messages.map((m) => `${m.kind === "task_update" ? "Update" : m.role === "user" ? "You" : "Jarvis"}: ${plainText(m.text)}`);
      text = `${c.title ?? "Jarvis chat"}\n\n${lines.join("\n\n")}`;
    } catch (err) {
      return Alert.alert("Couldn't load the chat", String(err));
    }
    // Browsers without a share sheet get the transcript on the clipboard instead.
    await Share.share({ title: c.title ?? "Jarvis chat", message: text }).catch(async () => {
      await Clipboard.setStringAsync(text);
      Alert.alert("Copied", "The transcript is on your clipboard.");
    });
  }

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
          extraData={renaming}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
          ListEmptyComponent={loading ? undefined : <Empty text="No conversations yet." />}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => onOpen(item.id)}
              onLongPress={() =>
                setSheet([
                  { label: "Rename", onPress: () => setRenaming({ id: item.id, title: item.title ?? "" }) },
                  { label: "Share transcript", onPress: () => shareTranscript(item) },
                  { label: "Delete", danger: true, onPress: () => confirmDelete(item) },
                ])
              }
            >
              {renaming?.id === item.id ? (
                // No save on blur: the box can lose focus while the action sheet closes.
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <TextInput
                    ref={renameBox}
                    style={[styles.rowTitle, styles.input, { flex: 1 }]}
                    value={renaming.title}
                    onChangeText={(title) => setRenaming({ id: item.id, title })}
                    onSubmitEditing={saveTitle}
                    selectTextOnFocus
                    returnKeyType="done"
                    maxLength={80}
                  />
                  <LinkButton label="Save" onPress={saveTitle} />
                  <LinkButton label="Cancel" onPress={() => setRenaming(null)} />
                </View>
              ) : (
                <Text style={[styles.rowTitle, item.id === current && { fontWeight: "700" }]} numberOfLines={1}>
                  {item.title || "Untitled"}
                </Text>
              )}
              <Text style={styles.rowMeta}>{relativeTime(item.updated_at)} · hold for more</Text>
            </Pressable>
          )}
        />
      )}
      <ActionSheet actions={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
