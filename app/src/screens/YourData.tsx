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
      <View style={{ flexDirection: "row", gap: 24, paddingTop: 4 }}>
        <LinkButton label="Export as JSON" onPress={exportAll} />
        <LinkButton label="Erase everything" danger onPress={eraseAll} />
      </View>
    </View>
  );
}
