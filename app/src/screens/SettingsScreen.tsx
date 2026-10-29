import Constants from "expo-constants";
import { Alert, Text, View } from "react-native";
import { clearSettings, type Settings } from "../api";
import { Header, LinkButton, styles } from "../ui";

export default function SettingsScreen({ settings, onSignOut }: { settings: Settings; onSignOut: () => void }) {
  return (
    <>
      <Header title="Settings" />
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
    </>
  );
}
