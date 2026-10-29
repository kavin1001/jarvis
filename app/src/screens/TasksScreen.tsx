import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { api, type Settings, type Task } from "../api";
import { askApproval } from "../usePush";
import { colors, Empty, Header, relativeTime, styles } from "../ui";

const STATUS_LABEL: Record<Task["status"], string> = {
  queued: "Queued",
  running: "Working",
  waiting_approval: "Needs your OK",
  done: "Done",
  failed: "Failed",
};

export default function TasksScreen({ settings, refreshKey }: { settings: Settings; refreshKey: number }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api.tasks(settings));
    } finally {
      setLoading(false);
    }
  }, [settings]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Poll while anything is still in flight.
  const active = tasks.some((t) => t.status === "running" || t.status === "queued" || t.status === "waiting_approval");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [active, load]);

  return (
    <>
      <Header title="Tasks" />
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListEmptyComponent={loading ? undefined : <Empty text="Background tasks Jarvis runs for you show up here." />}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => setOpen(open === item.id ? null : item.id)}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={[styles.rowTitle, { flex: 1 }]} numberOfLines={open === item.id ? undefined : 1}>
                {item.summary ?? item.instructions}
              </Text>
              <Text style={{ color: item.status === "failed" ? colors.danger : item.status === "waiting_approval" ? colors.warningText : colors.muted }}>
                {STATUS_LABEL[item.status]}
              </Text>
            </View>
            <Text style={styles.rowMeta}>{relativeTime(item.created_at)}</Text>
            {item.pending_approvals.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => askApproval(settings, a.id, a.summary, load)}
                style={{ backgroundColor: colors.warning, padding: 10, borderRadius: 8, marginTop: 6 }}
              >
                <Text style={{ color: colors.warningText }}>Tap to review: {a.summary}</Text>
              </Pressable>
            ))}
            {open === item.id && (
              <>
                <Text style={[styles.rowMeta, { marginTop: 8 }]}>Instructions</Text>
                <Text>{item.instructions}</Text>
                {item.result ? (
                  <>
                    <Text style={[styles.rowMeta, { marginTop: 8 }]}>Result</Text>
                    <Text>{item.result}</Text>
                  </>
                ) : null}
              </>
            )}
          </Pressable>
        )}
      />
    </>
  );
}
