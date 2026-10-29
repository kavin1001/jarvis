import { useCallback, useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { api, type Place, type Settings } from "../api";
import { Alert } from "../dialog";
import { placeRemindersSupported, preciseLocation, usePlaceReminderSetting } from "../geofence";
import { Text, TextInput } from "../theme";
import { LinkButton, useShared } from "../ui";

/** Settings, Places: the switch for place reminders and the saved places they use. */
export function Places({ settings }: { settings: Settings }) {
  const styles = useShared();
  const reminders = usePlaceReminderSetting(settings);
  const [places, setPlaces] = useState<Place[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => api.places(settings).then(setPlaces, () => {}), [settings]);
  useEffect(() => {
    load();
  }, [load]);

  if (!placeRemindersSupported) return null;

  async function saveHere() {
    const label = name.trim();
    if (!label) return Alert.alert("Name this place first", "For example Home, Work or Gym.");
    setSaving(true);
    try {
      const here = await preciseLocation();
      if (!here) return Alert.alert("Location is off", "Allow location for Jarvis in the phone's Settings to save a place.");
      await api.savePlace(settings, { name: label, ...here });
      setName("");
      load();
    } catch (err) {
      Alert.alert("Couldn't save the place", String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.row}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Place reminders</Text>
          <Text style={styles.rowMeta}>
            "Remind me when I get home." Your phone watches the places and tells Jarvis when you arrive or leave. Needs location access set to
            Always.
          </Text>
        </View>
        <Switch
          value={reminders.on}
          accessibilityLabel="Place reminders"
          onValueChange={async (on) => {
            const problem = await reminders.setOn(on).catch((err) => String(err));
            if (problem) Alert.alert("Place reminders are off", problem);
          }}
        />
      </View>
      {places.map((p) => (
        <View key={p.name} style={{ flexDirection: "row", alignItems: "center", paddingTop: 8 }}>
          <Text style={{ flex: 1 }}>
            📍 {p.name[0].toUpperCase() + p.name.slice(1)}
            {p.radius_m > 500 ? <Text style={styles.rowMeta}> · approximate</Text> : null}
          </Text>
          <LinkButton
            label="Remove"
            danger
            onPress={() => api.deletePlace(settings, p.name).then(load, (err) => Alert.alert("Couldn't remove it", String(err)))}
          />
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingTop: 8 }}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={name}
          onChangeText={setName}
          placeholder="Name where you are, e.g. Home"
          maxLength={60}
          onSubmitEditing={saveHere}
        />
        <LinkButton label={saving ? "Saving…" : "Save here"} onPress={saveHere} />
      </View>
    </View>
  );
}
