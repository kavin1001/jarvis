import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { api, loadSettings, saveSettings, type Settings } from "./src/api";
import ChatScreen from "./src/screens/ChatScreen";
import HistoryScreen from "./src/screens/HistoryScreen";
import MemoryScreen from "./src/screens/MemoryScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import TasksScreen from "./src/screens/TasksScreen";
import { TabBar, type Tab } from "./src/TabBar";
import { usePush } from "./src/usePush";

const CONVERSATION_KEY = "jarvis-conversation";

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
        <Main settings={settings} onSignOut={() => setSettings(null)} />
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

function Main({ settings, onSignOut }: { settings: Settings; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("chat");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    SecureStore.getItemAsync(CONVERSATION_KEY).then((id) => setConversationId(id ?? undefined));
  }, []);
  useEffect(() => {
    api
      .tasks(settings)
      .then((tasks) => setPendingApprovals(tasks.reduce((n, t) => n + t.pending_approvals.length, 0)))
      .catch(() => {});
  }, [settings, refreshKey, tab]);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  usePush(settings, bump);

  function openConversation(id: string | undefined) {
    setConversationId(id);
    if (id) SecureStore.setItemAsync(CONVERSATION_KEY, id);
    else SecureStore.deleteItemAsync(CONVERSATION_KEY);
    setTab("chat");
  }

  return (
    <View style={styles.root}>
      <View style={styles.root}>
        {tab === "chat" && (
          <ChatScreen
            settings={settings}
            conversationId={conversationId}
            onConversation={(id) => {
              setConversationId(id);
              if (id) SecureStore.setItemAsync(CONVERSATION_KEY, id);
              else SecureStore.deleteItemAsync(CONVERSATION_KEY);
            }}
            refreshKey={refreshKey}
          />
        )}
        {tab === "history" && <HistoryScreen settings={settings} current={conversationId} onOpen={openConversation} />}
        {tab === "tasks" && <TasksScreen settings={settings} refreshKey={refreshKey} />}
        {tab === "memory" && <MemoryScreen settings={settings} />}
        {tab === "settings" && <SettingsScreen settings={settings} onSignOut={onSignOut} />}
      </View>
      <TabBar tab={tab} onChange={setTab} badges={{ tasks: pendingApprovals }} />
    </View>
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
      <Button title="Save" disabled={!url || !token} onPress={() => onSave({ url: url.replace(/\/$/, ""), token })} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  setup: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
});
