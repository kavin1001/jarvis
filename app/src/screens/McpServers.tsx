import { useCallback, useEffect, useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { Alert } from "../dialog";
import { api, type McpServer, type Settings } from "../api";
import { colors, LinkButton, styles } from "../ui";

const input = { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10 } as const;

/** Settings section: remote MCP servers that give Jarvis tools for your other apps. */
export function McpServers({ settings }: { settings: Settings }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const load = useCallback(() => api.mcpServers(settings).then(setServers).catch(() => {}), [settings]);
  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    try {
      await api.addMcpServer(settings, { name: name.trim().toLowerCase(), url: url.trim(), token: token.trim() || undefined });
      setName("");
      setUrl("");
      setToken("");
      setAdding(false);
      load();
    } catch (err) {
      Alert.alert("Couldn't add server", String(err));
    }
  }

  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>Connected apps (MCP servers)</Text>
      {servers.map((s) => (
        <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{s.name}</Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {s.url}
              {s.has_token ? " · token saved" : ""}
            </Text>
          </View>
          <Switch value={s.enabled} onValueChange={(v) => api.setMcpServerEnabled(settings, s.id, v).then(load)} />
          <LinkButton
            label="Remove"
            danger
            onPress={() =>
              Alert.alert(`Remove ${s.name}?`, "Jarvis will lose these tools.", [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: () => api.deleteMcpServer(settings, s.id).then(load) },
              ])
            }
          />
        </View>
      ))}
      {adding ? (
        <View style={{ gap: 8, paddingTop: 4 }}>
          <TextInput style={input} value={name} onChangeText={setName} placeholder="Name, e.g. notion" autoCapitalize="none" />
          <TextInput style={input} value={url} onChangeText={setUrl} placeholder="https://… server URL" autoCapitalize="none" keyboardType="url" />
          <TextInput style={input} value={token} onChangeText={setToken} placeholder="Access token (optional)" autoCapitalize="none" secureTextEntry />
          <View style={{ flexDirection: "row", gap: 16 }}>
            <LinkButton label="Add" onPress={add} />
            <LinkButton label="Cancel" onPress={() => setAdding(false)} />
          </View>
        </View>
      ) : (
        <View style={{ alignItems: "flex-start" }}>
          <LinkButton label="Add a server" onPress={() => setAdding(true)} />
        </View>
      )}
    </View>
  );
}
