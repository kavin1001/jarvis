import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { Platform, Share, View } from "react-native";
import { api, type Settings } from "../api";
import { Alert } from "../dialog";
import { LinkButton, useShared } from "../ui";
import { Text } from "../theme";

/** Settings section: download everything Jarvis keeps, or erase it. */
export function YourData({ settings, onErased }: { settings: Settings; onErased: () => void }) {
  const styles = useShared();
  async function exportAll() {
    try {
      const json = JSON.stringify(await api.exportData(settings), null, 2);
      const name = `jarvis-export-${new Date().toISOString().slice(0, 10)}.json`;
      if (Platform.OS === "web") {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        link.download = name;
        link.click();
        return;
      }
      const file = new File(Paths.cache, name);
      if (file.exists) file.delete();
      file.write(json);
      await Share.share({ url: file.uri, title: name });
    } catch (err) {
      Alert.alert("Export failed", String(err));
    }
  }

  function importClaude() {
    Alert.alert(
      "Import from Claude.ai",
      "On claude.ai, open Settings, Privacy, and tap Export data. Claude emails you a link to a zip. Unzip it (the Files app does this when you tap the zip), then pick conversations.json here. Your chats come across as text, and you can search and continue them in Jarvis. Importing again skips chats you already have.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Choose file", onPress: () => void pickExport() },
      ],
    );
  }

  async function pickExport() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ["application/json", "public.json", "*/*"], copyToCacheDirectory: true });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      const text = Platform.OS === "web" && asset.file ? await asset.file.text() : await new File(asset.uri).text();
      let chats: unknown;
      try {
        chats = JSON.parse(text);
      } catch {
        return Alert.alert("That isn't conversations.json", "Unzip the export from Claude and pick the conversations.json inside it.");
      }
      const { imported, skipped, messages } = await api.importClaude(settings, chats);
      Alert.alert(
        imported ? `Imported ${imported} chat${imported === 1 ? "" : "s"}` : "Nothing new to import",
        `${messages} messages${skipped ? `; ${skipped} skipped (already imported, or empty)` : ""}. They're in History.`,
      );
    } catch (err) {
      Alert.alert("Import failed", String(err));
    }
  }

  function eraseAll() {
    Alert.alert(
      "Erase everything?",
      "Deletes all conversations, memory, reminders, tasks and connected apps, and disconnects Google. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Erase",
          style: "destructive",
          onPress: () => api.deleteAllData(settings).then(onErased, (err) => Alert.alert("Couldn't erase", String(err))),
        },
      ],
    );
  }

  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>Your data</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 24, rowGap: 8, paddingTop: 4 }}>
        <LinkButton label="Export as JSON" onPress={exportAll} />
        <LinkButton label="Import from Claude.ai" onPress={importClaude} />
        <LinkButton label="Erase everything" danger onPress={eraseAll} />
      </View>
    </View>
  );
}
