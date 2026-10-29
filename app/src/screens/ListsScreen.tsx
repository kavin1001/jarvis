import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Share, View } from "react-native";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { api, unreachable, type List, type ListItem, type Settings } from "../api";
import { readCache, writeCache } from "../cache";
import { useConnection } from "../connection";
import { Alert } from "../dialog";
import { Choices, Empty, Header, LinkButton, useShared } from "../ui";
import { Notes } from "./Notes";
import { Text, TextInput, useColors } from "../theme";

const NEW = "\u0000new";
const NOTES = "\u0000notes";

/** Check-offs made without a connection, sent when it's back: item id to done. */
type Pending = Record<string, boolean>;

export default function ListsScreen({ settings }: { settings: Settings }) {
  const styles = useShared();
  const colors = useColors();
  const [lists, setLists] = useState<List[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState("");
  const [sheet, setSheet] = useState<SheetAction[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      // Check-offs made offline go first, so the fresh copy includes them.
      const pending = (await readCache<Pending>("lists-pending"))?.value ?? {};
      const left: Pending = {};
      for (const [id, done] of Object.entries(pending)) {
        await api.updateListItem(settings, id, { done }).catch((err) => {
          if (unreachable(err)) left[id] = done;
        });
      }
      await writeCache("lists-pending", left);
      setLists(await api.lists(settings));
      setOffline(false);
    } catch (err) {
      if (unreachable(err)) {
        // Show the copy on this phone, if there is one.
        const cached = await readCache<List[]>("lists");
        setLists((l) => l ?? cached?.value ?? []);
        setOffline(true);
      } else {
        setLists((l) => l ?? []);
        Alert.alert("Couldn't load your lists", String(err));
      }
    }
  }, [settings]);
  useEffect(() => {
    // The copy on the phone first, so the list opens at once; then the server's.
    readCache<List[]>("lists").then((c) => c && setLists((l) => l ?? c.value));
    load();
  }, [load]);
  useEffect(() => {
    if (lists) writeCache("lists", lists);
  }, [lists]);
  // Back online: send the kept ticks and refresh.
  const { online } = useConnection();
  useEffect(() => {
    if (online && offline) load();
  }, [online, offline, load]);

  // A list made here exists only once it has an item, so keep its name until then.
  const names = [...new Set([...(lists ?? []).map((l) => l.name), ...(selected && selected !== NEW && selected !== NOTES ? [selected] : [])])];
  const current = selected === NEW || selected === NOTES ? selected : selected && names.includes(selected) ? selected : names[0] ?? NEW;
  const items = lists?.find((l) => l.name === current)?.items ?? [];
  const doneCount = items.filter((i) => i.done).length;

  function patchLocal(id: string, change: Partial<ListItem> | null) {
    setLists((ls) =>
      (ls ?? []).map((l) => ({
        ...l,
        items: change === null ? l.items.filter((i) => i.id !== id) : l.items.map((i) => (i.id === id ? { ...i, ...change } : i)),
      })),
    );
  }

  async function add() {
    const texts = draft
      .split(/\n|,/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (texts.length === 0 || current === NEW) return;
    setDraft("");
    try {
      await api.addListItems(settings, current, texts);
      load();
    } catch (err) {
      setDraft(texts.join(", "));
      Alert.alert("Couldn't add that", String(err));
    }
  }

  function create() {
    const name = newName.trim().toLowerCase().replace(/\s+list$/, "");
    if (!name) return;
    setNewName("");
    setSelected(name);
  }

  async function toggle(item: ListItem) {
    patchLocal(item.id, { done: !item.done });
    try {
      await api.updateListItem(settings, item.id, { done: !item.done });
    } catch (err) {
      if (unreachable(err)) {
        // Keep the tick and send it when the connection is back.
        const pending = (await readCache<Pending>("lists-pending"))?.value ?? {};
        await writeCache("lists-pending", { ...pending, [item.id]: !item.done });
        setOffline(true);
        return;
      }
      patchLocal(item.id, { done: item.done });
      Alert.alert("Couldn't update that", String(err));
    }
  }

  async function saveEdit() {
    const e = editing;
    setEditing(null);
    if (!e?.text.trim()) return;
    patchLocal(e.id, { text: e.text.trim() });
    api.updateListItem(settings, e.id, { text: e.text.trim() }).catch((err) => {
      Alert.alert("Couldn't save", String(err));
      load();
    });
  }

  function remove(item: ListItem) {
    patchLocal(item.id, null);
    api.deleteListItem(settings, item.id).catch((err) => {
      Alert.alert("Couldn't remove that", String(err));
      load();
    });
  }

  // What's still to get, as text for Messages or Notes: "Shopping:\n- eggs\n- milk".
  function share() {
    const open = items.filter((i) => !i.done).map((i) => `- ${i.text}`);
    Share.share({ message: `${current[0].toUpperCase() + current.slice(1)}:\n${open.join("\n")}` }).catch(() => {});
  }

  async function clear(all: boolean) {
    try {
      await api.clearList(settings, current, all);
      if (all) setSelected(null);
      load();
    } catch (err) {
      Alert.alert("Couldn't clear the list", String(err));
    }
  }

  const top = (
    <>
      <Header title="Lists" right={current === NOTES ? undefined : <LinkButton label="Refresh" onPress={load} />} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Choices
          options={[...names.map((n): [string, string] => [n, n[0].toUpperCase() + n.slice(1)]), [NOTES, "📝 Notes"], [NEW, "+ New list"]]}
          value={current}
          onChange={setSelected}
        />
      </View>
    </>
  );

  if (current === NOTES) {
    return (
      <>
        {top}
        <Notes settings={settings} />
      </>
    );
  }

  return (
    <>
      {top}
      {offline ? (
        <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingBottom: 8 }]}>
          No connection: this is the copy on your phone. Ticks are kept and sent when you're back online.
        </Text>
      ) : null}
      {current === NEW ? (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={newName}
            onChangeText={setNewName}
            placeholder="Name it, e.g. Packing"
            onSubmitEditing={create}
            maxLength={60}
            autoFocus={lists !== null && names.length > 0}
          />
          <LinkButton label="Create" onPress={create} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={`Add to ${current}`}
            onSubmitEditing={add}
            submitBehavior="submit"
            returnKeyType="done"
          />
          <LinkButton label="Add" onPress={add} />
        </View>
      )}
      <FlatList
        data={current === NEW ? [] : items}
        keyExtractor={(i) => i.id}
        extraData={editing}
        ListEmptyComponent={
          lists === null ? undefined : (
            <Empty
              text={
                names.length === 0
                  ? "No lists yet. Tell Jarvis \"add milk to my shopping list\", or make one here."
                  : current === NEW
                    ? "Give the new list a name."
                    : "Nothing on this list yet."
              }
            />
          )
        }
        renderItem={({ item }) =>
          editing?.id === item.id ? (
            <View style={[styles.row, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={editing.text}
                onChangeText={(text) => setEditing({ id: item.id, text })}
                onSubmitEditing={saveEdit}
                returnKeyType="done"
                maxLength={200}
                autoFocus
              />
              <LinkButton label="Save" onPress={saveEdit} />
              <LinkButton label="Cancel" onPress={() => setEditing(null)} />
            </View>
          ) : (
            <View style={[styles.row, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <Pressable
                onPress={() => toggle(item)}
                hitSlop={10}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.done }}
                accessibilityLabel={item.text}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 2,
                  borderColor: item.done ? colors.muted : colors.accent,
                  backgroundColor: item.done ? colors.muted : undefined,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {item.done && <Text style={{ color: colors.onAccent, fontSize: 13, fontWeight: "700" }}>✓</Text>}
              </Pressable>
              <Pressable
                style={{ flex: 1 }}
                accessibilityHint="Edit or remove"
                onPress={() =>
                  setSheet([
                    { label: "Edit", onPress: () => setEditing({ id: item.id, text: item.text }) },
                    { label: "Remove", danger: true, onPress: () => remove(item) },
                  ])
                }
              >
                <Text style={item.done ? { color: colors.muted, textDecorationLine: "line-through" } : undefined}>{item.text}</Text>
              </Pressable>
            </View>
          )
        }
        ListFooterComponent={
          current !== NEW && items.length > 0 ? (
            <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 16 }}>
              {doneCount > 0 ? <LinkButton label={`Clear ${doneCount} checked`} onPress={() => clear(false)} /> : <View />}
              {items.length > doneCount ? <LinkButton label="Share" onPress={share} /> : null}
              <LinkButton
                label="Delete list"
                danger
                onPress={() =>
                  Alert.alert(`Delete the ${current} list?`, `All ${items.length} items go.`, [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: () => clear(true) },
                  ])
                }
              />
            </View>
          ) : undefined
        }
      />
      <ActionSheet actions={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
