import Constants from "expo-constants";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { Alert } from "../dialog";
import { appLockAvailable, useAppLockSetting } from "../appLock";
import { clearCache } from "../cache";
import { api, clearSettings, type Connectors, type Settings, type Usage } from "../api";
import { locationSharingEnabled, setLocationSharing } from "../location";
import { Activity } from "./Activity";
import { ChatRetention } from "./ChatRetention";
import { ReplyStyle } from "./ReplyStyle";
import { AppVersion } from "./AppVersion";
import { Devices } from "./Devices";
import { SetupStatus } from "./SetupStatus";
import { YourData } from "./YourData";
import { McpServers } from "./McpServers";
import { NotifySettings } from "./NotifySettings";
import { Places } from "./Places";
import { SiriShortcut } from "./SiriShortcut";
import { stopPlaceReminders } from "../geofence";
import { Choices, Header, LinkButton, Section, useShared } from "../ui";
import { Text, useColors, useTheme, type Appearance } from "../theme";
import { createSpeaker } from "../useVoice";
import { RATES, setVoicePrefs, useVoicePrefs, type ReadReplies } from "../voicePrefs";

const APPEARANCES: [Appearance, string][] = [
  ["system", "Match phone"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const READ_REPLIES: [ReadReplies, string][] = [
  ["voice", "When I speak"],
  ["always", "Always"],
  ["never", "Never"],
];

/** A row of pill buttons that picks one value. */
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

export default function SettingsScreen({
  settings,
  onSignOut,
  onErased,
}: {
  settings: Settings;
  onSignOut: () => void;
  /** After "Erase everything": start a fresh chat. */
  onErased: () => void;
}) {
  const styles = useShared();
  const colors = useColors();
  const { appearance, setAppearance } = useTheme();
  const voice = useVoicePrefs();
  const lock = useAppLockSetting();
  const [canLock, setCanLock] = useState(false);
  useEffect(() => {
    appLockAvailable().then(setCanLock, () => setCanLock(false));
  }, []);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [connectors, setConnectors] = useState<Connectors | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusKey, setStatusKey] = useState(0);
  const [shareLocation, setShareLocation] = useState(false);
  useEffect(() => {
    locationSharingEnabled().then(setShareLocation);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setStatusKey((k) => k + 1);
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

      <SetupStatus settings={settings} refreshKey={statusKey} />

      <Section title="Usage" />
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

      <Section title="Accounts" />
      {google?.available ? (
        <View style={styles.row}>
          <Text style={styles.rowMeta}>Gmail, Google Calendar, Contacts and Drive</Text>
          <Text>{google.connected ? `Connected${google.email ? ` as ${google.email}` : ""}` : "Not connected"}</Text>
          {google.connected && (!google.can_organize || !google.can_search_contacts || !google.can_see_all_calendars || !google.can_read_drive || google.can_edit_contacts === false || google.can_create_docs === false) ? (
            <View style={{ alignItems: "flex-start" }}>
              <Text style={styles.rowMeta}>
                Connect again to let Jarvis{" "}
                {[
                  !google.can_organize && "archive and mark email",
                  !google.can_search_contacts && "look up your contacts",
                  !google.can_see_all_calendars && "see your shared and family calendars",
                  !google.can_read_drive && "search and read your Google Drive",
                  google.can_edit_contacts === false && "save contacts for you",
                  google.can_create_docs === false && "make Google Docs and Sheets",
                ]
                  .filter(Boolean)
                  .join(", ")}
                .
              </Text>
              <LinkButton label="Connect again" onPress={connectGoogle} />
            </View>
          ) : null}
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

      <McpServers settings={settings} />
      <Activity settings={settings} refreshKey={statusKey} />

      <Section title="Replies, voice and appearance" />
      <ReplyStyle settings={settings} />
      <View style={styles.row}>
        <Text style={styles.rowMeta}>Appearance</Text>
        <Choices options={APPEARANCES} value={appearance} onChange={setAppearance} />
      </View>

      <View style={styles.row}>
        <Text style={styles.rowMeta}>Read replies aloud</Text>
        <Choices options={READ_REPLIES} value={voice.readReplies} onChange={(readReplies) => setVoicePrefs({ readReplies })} />
      </View>

      <View style={styles.row}>
        <Text style={styles.rowMeta}>Speaking speed</Text>
        <Choices
          options={RATES}
          value={voice.rate}
          onChange={(rate) => {
            setVoicePrefs({ rate });
            Speech.stop();
            const speaker = createSpeaker();
            speaker.push("This is how fast I'll talk.");
            speaker.flush();
          }}
        />
      </View>

      <Section title="Privacy" />
      <View style={[styles.row, { flexDirection: "row", alignItems: "center" }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Share approximate location</Text>
          <Text style={styles.rowMeta}>For "near me" questions. Rounded to about 1 km and sent only with your messages.</Text>
        </View>
        <Switch
          value={shareLocation}
          onValueChange={async (on) => {
            const now = await setLocationSharing(on);
            setShareLocation(now);
            if (on && !now) Alert.alert("Location is off", "Allow location for Jarvis in iOS Settings to use this.");
          }}
        />
      </View>

      <ChatRetention settings={settings} />

      {canLock && (
        <View style={[styles.row, { flexDirection: "row", alignItems: "center" }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Lock Jarvis</Text>
            <Text style={styles.rowMeta}>Ask for Face ID or your passcode when you open Jarvis after a minute away.</Text>
          </View>
          <Switch value={lock.on} onValueChange={(on) => void lock.setOn(on)} accessibilityLabel="Lock Jarvis" />
        </View>
      )}

      <Section title="Reminders and Siri" />
      <Places settings={settings} />
      <SiriShortcut settings={settings} />

      <Section title="Notifications" />
      <NotifySettings settings={settings} />

      <Section title="Your data and devices" />
      <YourData
        settings={settings}
        onErased={() => {
          clearCache();
          Alert.alert("Erased", "Jarvis has forgotten everything.");
          onErased();
        }}
      />

      <Devices settings={settings} onSignOut={() => stopPlaceReminders().then(clearSettings).then(onSignOut)} />

      <View style={styles.row}>
        <Text style={styles.rowMeta}>Backend</Text>
        <Text>{settings.url}</Text>
      </View>
      <AppVersion />
      <View style={styles.row}>
        <Text style={styles.rowMeta}>App version</Text>
        <Text>{Constants.expoConfig?.version ?? "dev"}</Text>
      </View>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        <LinkButton
          label="Disconnect this phone"
          danger
          onPress={() =>
            Alert.alert("Disconnect?", "You'll need the backend URL and a pairing code (or the app token) to connect again.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Disconnect",
                style: "destructive",
                onPress: async () => {
                  // Also revoke this phone's token on the server, if it's reachable.
                  const current = (await api.devices(settings).catch(() => [])).find((d) => d.current);
                  if (current) await api.revokeDevice(settings, current.id).catch(() => {});
                  await stopPlaceReminders();
                  await clearSettings();
                  onSignOut();
                },
              },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}
