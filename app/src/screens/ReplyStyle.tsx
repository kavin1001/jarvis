import { useEffect, useState } from "react";
import { View } from "react-native";
import { api, type Settings } from "../api";
import { Alert } from "../dialog";
import { LinkButton, useShared } from "../ui";
import { Text, TextInput } from "../theme";

const MAX = 1500;
const EXAMPLE = "e.g. Keep answers short. Use metric units. I'm vegetarian. Call me Kav.";

/** Settings: the user's own instructions for how Jarvis replies, sent with every chat. */
export function ReplyStyle({ settings }: { settings: Settings }) {
  const styles = useShared();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api.instructions(settings).then(
      ({ instructions }) => {
        setSaved(instructions ?? "");
        setDraft(instructions ?? "");
        setLoaded(true);
      },
      () => setLoaded(false),
    );
  }, [settings]);

  async function save() {
    try {
      const { instructions } = await api.setInstructions(settings, draft.trim() || null);
      setSaved(instructions ?? "");
      setDraft(instructions ?? "");
    } catch (err) {
      Alert.alert("Couldn't save that", String(err));
    }
  }

  if (!loaded) return null;
  const changed = draft.trim() !== (saved ?? "");
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>How Jarvis replies</Text>
      <Text style={styles.rowMeta}>Your own instructions, used in every chat.</Text>
      <TextInput
        style={[styles.input, { minHeight: 80, textAlignVertical: "top", marginTop: 8 }]}
        value={draft}
        onChangeText={setDraft}
        placeholder={EXAMPLE}
        multiline
        maxLength={MAX}
        accessibilityLabel="How Jarvis replies"
      />
      {changed ? (
        <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
          <LinkButton label="Save" onPress={save} />
          <LinkButton label="Cancel" onPress={() => setDraft(saved ?? "")} />
        </View>
      ) : null}
    </View>
  );
}
