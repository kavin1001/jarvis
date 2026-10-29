import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Platform, View } from "react-native";
import { api, type Settings } from "../api";
import { Alert } from "../dialog";
import { Text, useColors } from "../theme";
import { LinkButton, useShared } from "../ui";

/**
 * Settings, Ask Jarvis from Siri: a token and the steps for an iPhone Shortcut that
 * sends what you say to /api/ask and speaks the answer, without opening the app.
 */
export function SiriShortcut({ settings }: { settings: Settings }) {
  const styles = useShared();
  const colors = useColors();
  const [token, setToken] = useState<string | null>(null);
  const url = `${settings.url.replace(/\/$/, "")}/api/ask`;

  async function make() {
    try {
      setToken((await api.shortcutToken(settings)).token);
    } catch (err) {
      Alert.alert("Couldn't make a token", String(err));
    }
  }

  async function copy(text: string, what: string) {
    await Clipboard.setStringAsync(text);
    if (Platform.OS !== "web") Alert.alert("Copied", `${what} is on the clipboard.`);
  }

  const steps = [
    "Open the Shortcuts app and tap + to make a new shortcut.",
    "Add Dictate Text.",
    `Add Get Contents of URL. Set the URL to ${url}, Method to POST, add a header Authorization with the value Bearer followed by a space and the token, and set Request Body to JSON with a text field holding Dictated Text.`,
    "Add Speak Text, speaking Contents of URL.",
    "Name it Ask Jarvis. Then say \"Hey Siri, Ask Jarvis\", or put it on the Action Button.",
  ];

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>Ask Jarvis from Siri</Text>
      <Text style={styles.rowMeta}>
        An iPhone Shortcut can send what you say to Jarvis and speak the answer, without opening the app. Questions a few minutes apart continue
        the same chat.
      </Text>
      {token ? (
        <View style={{ gap: 8, paddingTop: 8 }}>
          <Text selectable style={{ fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 12, backgroundColor: colors.surface, padding: 8, borderRadius: 6 }}>
            {token}
          </Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <LinkButton label="Copy token" onPress={() => copy(token, "The token")} />
            <LinkButton label="Copy URL" onPress={() => copy(url, "The URL")} />
          </View>
          <Text style={styles.rowMeta}>Shown once. It's listed as Siri Shortcut under Devices, where you can revoke it.</Text>
          {steps.map((step, i) => (
            <Text key={i}>
              {i + 1}. {step}
            </Text>
          ))}
        </View>
      ) : (
        <View style={{ alignItems: "flex-start", paddingTop: 8 }}>
          <LinkButton label="Set up the Shortcut" onPress={make} />
        </View>
      )}
    </View>
  );
}
