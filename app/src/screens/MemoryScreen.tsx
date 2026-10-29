import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { Alert } from "../dialog";
import { api, type Fact, type Settings } from "../api";
import { colors, Empty, Header, LinkButton, styles } from "../ui";

export default function MemoryScreen({ settings }: { settings: Settings }) {
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

  function remove(f: Fact) {
    Alert.alert("Forget this?", f.fact, [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => api.deleteFact(settings, f.id).then(load) },
    ]);
  }

  return (
    <>
      <Header title="Memory" right={<LinkButton label="Refresh" onPress={load} />} />
      <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingBottom: 8 }]}>
        What Jarvis remembers about you across conversations. Tap a fact to forget it.
      </Text>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        <TextInput
          style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10 }}
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
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => remove(item)}>
            <Text>{item.fact}</Text>
          </Pressable>
        )}
      />
    </>
  );
}
