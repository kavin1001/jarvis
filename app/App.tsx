import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { loadSettings, saveSettings, type Settings } from "./src/api";
import ChatScreen from "./src/ChatScreen";

export default function App() {
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (settings === undefined) return null;
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      {settings ? (
        <ChatScreen settings={settings} />
      ) : (
        <Setup
          onSave={async (s) => {
            await saveSettings(s);
            setSettings(s);
          }}
        />
      )}
    </SafeAreaView>
  );
}

function Setup({ onSave }: { onSave: (s: Settings) => void }) {
  const [url, setUrl] = useState(process.env.EXPO_PUBLIC_JARVIS_API_URL ?? "");
  const [token, setToken] = useState("");
  return (
    <View style={styles.setup}>
      <Text style={styles.title}>Connect Jarvis</Text>
      <Text>Backend URL</Text>
      <TextInput style={styles.input} value={url} onChangeText={setUrl} autoCapitalize="none" placeholder="https://jarvis.example.com" />
      <Text>App token (JARVIS_APP_TOKEN from the backend)</Text>
      <TextInput style={styles.input} value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry />
      <Button
        title="Save"
        disabled={!url || !token}
        onPress={() => onSave({ url: url.replace(/\/$/, ""), token })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  setup: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
});
