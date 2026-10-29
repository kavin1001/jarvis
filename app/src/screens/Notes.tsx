import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, Share, View } from "react-native";
import { api, unreachable, type Note, type Settings } from "../api";
import { readCache, writeCache } from "../cache";
import { Alert } from "../dialog";
import { Markdown, plainText } from "../Markdown";
import { Empty, LinkButton, relativeTime, useShared } from "../ui";
import { Text, TextInput, useColors } from "../theme";

/** The body for the list row, without the title repeated when the body starts with it. */
const snippet = (n: Note) => {
  const words = plainText(n.body).replace(/\s+/g, " ").trim();
  const title = n.title.replace(/…$/, "");
  return words.startsWith(title) && words.length > title.length ? words.slice(title.length).trim() : words;
};

type Open = {
  id: string | null;
  title: string;
  body: string;
  editing: boolean;
};

/** The Notes part of the Lists tab: search, read, edit and share notes Jarvis took. */
export function Notes({ settings }: { settings: Settings }) {
  const styles = useShared();
  const colors = useColors();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(
    async (q: string) => {
      try {
        const found = await api.notes(settings, q.trim());
        setNotes(found);
        setOffline(false);
        if (!q.trim()) writeCache("notes", found);
      } catch (err) {
        if (unreachable(err)) {
          // No connection: search the copy on this phone instead.
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          const cached = (await readCache<Note[]>("notes"))?.value ?? [];
          setNotes(cached.filter((n) => words.every((w) => `${n.title} ${n.body}`.toLowerCase().includes(w))));
          setOffline(true);
        } else {
          setNotes((n) => n ?? []);
          Alert.alert("Couldn't load your notes", String(err));
        }
      }
    },
    [settings],
  );
  // Search as they type, once they pause.
  useEffect(() => {
    const t = setTimeout(() => load(search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  async function save() {
    if (!open) return;
    const body = open.body.trim();
    if (!body) return Alert.alert("The note is empty", "Write something first, or go back.");
    try {
      const note = open.id
        ? await api.updateNote(settings, open.id, {
            body,
            ...(open.title.trim() ? { title: open.title.trim() } : {}),
          })
        : await api.createNote(settings, body, open.title.trim() || undefined);
      setOpen({
        id: note.id,
        title: note.title,
        body: note.body,
        editing: false,
      });
      load(search);
    } catch (err) {
      Alert.alert("Couldn't save the note", String(err));
    }
  }

  function remove(id: string) {
    Alert.alert("Delete this note?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          api.deleteNote(settings, id).then(
            () => {
              setOpen(null);
              load(search);
            },
            (err) => Alert.alert("Couldn't delete the note", String(err)),
          ),
      },
    ]);
  }

  if (open) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <LinkButton label="‹ Notes" onPress={() => setOpen(null)} />
          {open.editing ? (
            <LinkButton label="Save" onPress={save} />
          ) : (
            <View style={{ flexDirection: "row", gap: 16 }}>
              <LinkButton
                label="Share"
                onPress={() =>
                  Share.share({
                    message: `${open.title}\n\n${plainText(open.body)}`,
                  }).catch(() => {})
                }
              />
              <LinkButton label="Edit" onPress={() => setOpen({ ...open, editing: true })} />
            </View>
          )}
        </View>
        {open.editing ? (
          <>
            <TextInput
              style={styles.input}
              value={open.title}
              onChangeText={(title) => setOpen({ ...open, title })}
              placeholder="Title (optional)"
              maxLength={120}
            />
            <TextInput
              style={[styles.input, { minHeight: 200, textAlignVertical: "top" }]}
              value={open.body}
              onChangeText={(body) => setOpen({ ...open, body })}
              placeholder="Write your note"
              multiline
              autoFocus={!open.id}
            />
          </>
        ) : (
          <>
            <Text style={{ fontSize: 22, fontWeight: "700" }}>{open.title}</Text>
            <Markdown text={open.body} />
          </>
        )}
        {open.id ? (
          <View style={{ alignItems: "flex-start", marginTop: 12 }}>
            <LinkButton label="Delete note" danger onPress={() => remove(open.id!)} />
          </View>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <>
      <View
        style={{
          flexDirection: "row",
          gap: 8,
          paddingHorizontal: 16,
          paddingBottom: 8,
          alignItems: "center",
        }}
      >
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={search}
          onChangeText={setSearch}
          placeholder="Search notes"
          returnKeyType="search"
          autoCorrect={false}
        />
        <LinkButton label="+ New" onPress={() => setOpen({ id: null, title: "", body: "", editing: true })} />
      </View>
      {offline ? (
        <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingBottom: 8 }]}>No connection: these are the notes saved on your phone.</Text>
      ) : null}
      <FlatList
        data={notes ?? []}
        keyExtractor={(n) => n.id}
        ListEmptyComponent={
          notes === null ? undefined : (
            <Empty
              text={search.trim() ? "No notes match." : 'No notes yet. Tell Jarvis "take a note…", or hold a reply and tap Save as note.'}
            />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              setOpen({
                id: item.id,
                title: item.title,
                body: item.body,
                editing: false,
              })
            }
            accessibilityRole="button"
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.muted }]} numberOfLines={2}>
              {relativeTime(item.updated_at)} · {snippet(item)}
            </Text>
          </Pressable>
        )}
      />
    </>
  );
}
