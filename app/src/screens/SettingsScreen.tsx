import Constants from "expo-constants";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { api, clearSettings, type Connectors, type Settings, type Usage } from "../api";
import { colors, Header, LinkButton, styles } from "../ui";

const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

export default function SettingsScreen({ settings, onSignOut }: { settings: Settings; onSignOut: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [connectors, setConnectors] = useState<Connectors | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [u, c] = await Promise.allSettled([api.usage(settings), api.connectors(settings)]);
    setUsage(u.status === "fulfilled" ? u.value : null);
    setConnectors(c.status === "fulfilled" ? c.value : null);
    setLoading(false);
  }, [settings]);
  useEffect(() => {
    load();
    // Coming back from the Google sign-in page in the browser: refresh the status.
    const sub = AppState.addEventListener("change", (state) => state === "active" && load());
    return () => sub.remove();
  }, [load]);

  const google = connectors?.google;
  const connectGoogle = async () => {
    try {
      await Linking.openURL((await api.startGoogle(settings)).url);
    } catch (err) {
      Alert.alert("Couldn't start Google sign-in", String(err));
    }
  };

  const budget = usage?.daily_budget_usd ?? null;
  const share = usage && budget ? Math.min(1, usage.today_usd / budget) : 0;

  return (
    <ScrollView refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <Header title="Settings" />

      <View style={styles.row}>
        <Text style={styles.rowMeta}>Spend today (estimated)</Text>
        <Text style={{ fontSize: 28, fontWeight: "700" }}>
          {usage ? usd(usage.today_usd) : "—"}
          {budget ? <Text style={{ fontSize: 15, color: colors.muted }}> of {usd(budget)} daily cap</Text> : null}
        </Text>
        {budget ? (
          <View style={{ height: 6, backgroundColor: colors.border, borderRadius: 3, marginTop: 6 }}>
            <View
              style={{
                width: `${share * 100}%`,
                height: 6,
                borderRadius: 3,
                backgroundColor: share >= 0.9 ? colors.danger : colors.accent,
              }}
            />
          </View>
        ) : null}
        {usage ? (
          <Text style={styles.rowMeta}>
            {usage.chat_turns_today} replies and {usage.tasks_today} tasks today · last 7 days {usd(usage.last_7_days_usd)} · this month{" "}
            {usd(usage.month_to_date_usd)}
          </Text>
        ) : null}
      </View>

      {google?.available ? (
        <View style={styles.row}>
          <Text style={styles.rowMeta}>Gmail and Google Calendar</Text>
          <Text>{google.connected ? `Connected${google.email ? ` as ${google.email}` : ""}` : "Not connected"}</Text>
          <View style={{ alignItems: "flex-start" }}>
            {google.connected ? (
              <LinkButton
                label="Disconnect Google"
                danger
                onPress={() =>
                  Alert.alert("Disconnect Google?", "Jarvis will no longer read your mail or calendar.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Disconnect", style: "destructive", onPress: () => api.disconnectGoogle(settings).then(load) },
                  ])
                }
              />
            ) : (
              <LinkButton label="Connect Google" onPress={connectGoogle} />
            )}
          </View>
        </View>
      ) : null}

      <View style={styles.row}>
        <Text style={styles.rowMeta}>Backend</Text>
        <Text>{settings.url}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowMeta}>App version</Text>
        <Text>{Constants.expoConfig?.version ?? "dev"}</Text>
      </View>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        <LinkButton
          label="Disconnect this phone"
          danger
          onPress={() =>
            Alert.alert("Disconnect?", "You'll need the backend URL and token to connect again.", [
              { text: "Cancel", style: "cancel" },
              { text: "Disconnect", style: "destructive", onPress: () => clearSettings().then(onSignOut) },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}
