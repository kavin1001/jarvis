import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api, type Activity as Entry, type Settings } from "../api";
import { LinkButton, relativeTime, useShared } from "../ui";
import { Text } from "../theme";

const ICONS: Record<string, string> = {
  gmail_create_draft: "✉️",
  gmail_organize: "✉️",
  calendar_create_event: "📅",
  calendar_update_event: "📅",
  calendar_delete_event: "📅",
  start_task: "⚙️",
  continue_task: "⚙️",
  cancel_task: "⚙️",
  mcp: "🔌",
};

/** Settings section: what Jarvis did on your accounts lately (drafts, calendar changes, connected apps). */
export function Activity({ settings, refreshKey }: { settings: Settings; refreshKey?: number }) {
  const styles = useShared();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => api.activity(settings).then(setEntries, () => setEntries((e) => e ?? [])), [settings]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const LIMIT = 5;
  const shown = showAll ? entries ?? [] : (entries ?? []).slice(0, LIMIT);
  return (
    <View style={styles.row}>
      <Text style={styles.rowMeta}>What Jarvis did on your accounts</Text>
      {entries?.length === 0 ? <Text style={styles.rowMeta}>Nothing yet. Drafts, calendar changes, tasks and connected-app actions show up here.</Text> : null}
      {shown.map((a) => (
        <View key={a.id} style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
          <Text>{ICONS[a.kind] ?? "•"}</Text>
          <View style={{ flex: 1 }}>
            <Text>{a.summary}</Text>
            <Text style={styles.rowMeta}>{relativeTime(a.created_at)}</Text>
          </View>
        </View>
      ))}
      {(entries?.length ?? 0) > LIMIT ? (
        <View style={{ alignItems: "flex-start", paddingVertical: 4 }}>
          <LinkButton label={showAll ? "Show fewer" : `Show all ${entries!.length}`} onPress={() => setShowAll(!showAll)} />
        </View>
      ) : null}
    </View>
  );
}
