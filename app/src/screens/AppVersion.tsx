import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useState } from "react";
import { View } from "react-native";
import { Alert } from "../dialog";
import { LinkButton, useShared } from "../ui";
import { Text } from "../theme";

/**
 * The app's version, and on phone builds set up for updates, a way to get the newest one
 * without reinstalling. Updates also download on their own at launch and apply next time.
 */
export function AppVersion() {
  const styles = useShared();
  const [checking, setChecking] = useState(false);
  const version = Constants.expoConfig?.version ?? "?";
  const build = Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId ? ` · update ${Updates.updateId.slice(0, 8)}` : "";

  async function check() {
    setChecking(true);
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found.isAvailable) return Alert.alert("You're up to date", `Jarvis ${version} is the newest version.`);
      await Updates.fetchUpdateAsync();
      Alert.alert("Update ready", "Restart Jarvis to use it.", [
        { text: "Later", style: "cancel" },
        { text: "Restart", onPress: () => void Updates.reloadAsync() },
      ]);
    } catch (err) {
      Alert.alert("Couldn't check for updates", String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>Version</Text>
      <Text>
        Jarvis {version}
        {build}
      </Text>
      {Updates.isEnabled ? (
        <View style={{ alignItems: "flex-start" }}>
          <LinkButton label={checking ? "Checking…" : "Check for updates"} onPress={check} />
        </View>
      ) : null}
    </View>
  );
}
