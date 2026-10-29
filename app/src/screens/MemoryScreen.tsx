import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { Alert } from "../dialog";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { api, type Fact, type Settings } from "../api";
import { Empty, Header, LinkButton, useShared } from "../ui";
import { Text, TextInput, useColors, type TextInputHandle } from "../theme";

export default function MemoryScreen({ settings }: { settings: Settings }) {
  const styles = useShared();
  const colors = useColors();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => setFacts(await api.facts(settings)), [settings]);
  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    if (!draft.trim()) return;
    await api.addFact(settings, draft.trim());
    setDraft("");
    load();
  }

  const [sheet, setSheet] = useState<SheetAction[] | null>(null);
  const [editing, setEditing] = useState<Fact | null>(null);
  const editBox = useRef<TextInputHandle>(null);
  const editingId = editing?.id;
  useEffect(() => {
    // Focus once the action sheet has finished closing, or it takes the focus back.
    if (!editingId) return;
    const timer = setTimeout(() => editBox.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [editingId]);

  async function saveEdit() {
    const e = editing;
    setEditing(null);
    if (!e?.fact.trim()) return;
    try {
      await api.updateFact(settings, e.id, e.fact.trim());
      load();
    } catch (err) {
      Alert.alert("Couldn't save", String(err));
    }
  }

  function forget(f: Fact) {
    api.deleteFact(settings, f.id).then(load, (err) => Alert.alert("Couldn't forget that", String(err)));
  }

  return (
    <>
      <Header title="Memory" right={<LinkButton label="Refresh" onPress={load} />} />
      <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingBottom: 8 }]}>
        What Jarvis remembers about you across conversations. Tap a fact to edit or forget it.
      </Text>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        <TextInput
          style={{ flex: 1, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 8, padding: 10 }}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add something Jarvis should know"
          onSubmitEditing={add}
        />
        <LinkButton label="Add" onPress={add} />
      </View>
      <FlatList
        data={facts}
        keyExtractor={(f) => f.id}
        ListEmptyComponent={<Empty text="Nothing saved yet. Tell Jarvis about yourself and it will remember." />}
        extraData={editing}
        renderItem={({ item }) =>
          editing?.id === item.id ? (
            // No save on blur: the box can lose focus while the action sheet closes.
            <View style={[styles.row, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <TextInput
                ref={editBox}
                style={[styles.input, { flex: 1 }]}
                value={editing.fact}
                onChangeText={(fact) => setEditing({ id: item.id, fact })}
                onSubmitEditing={saveEdit}
                returnKeyType="done"
                maxLength={500}
                multiline
                blurOnSubmit
              />
              <LinkButton label="Save" onPress={saveEdit} />
              <LinkButton label="Cancel" onPress={() => setEditing(null)} />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              style={styles.row}
              accessibilityHint="Edit or forget"
              onPress={() =>
                setSheet([
                  { label: "Edit", onPress: () => setEditing(item) },
                  { label: "Forget", danger: true, onPress: () => forget(item) },
                ])
              }
            >
              <Text>{item.fact}</Text>
            </Pressable>
          )
        }
      />
      <ActionSheet actions={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
