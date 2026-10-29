import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { Alert } from "../dialog";
import { api, type Reminder, type Settings, type Task } from "../api";
import { askApproval } from "../usePush";
import { Empty, Header, LinkButton, relativeTime, useShared } from "../ui";
import { Text, useColors } from "../theme";
import { fileSize, openTaskFile } from "../taskFiles";

const ROUTINES: { label: string; text: string; time: string; repeat: "daily" | "weekdays" }[] = [
  {
    label: "Morning briefing (weekdays, 8:00)",
    text: "Morning briefing: today's weather where I am, what's on my calendar, any important unread email, and two or three top news headlines. Keep it short.",
    time: "08:00",
    repeat: "weekdays",
  },
  {
    label: "Evening wrap-up (daily, 18:00)",
    text: "Evening wrap-up: what's on my calendar tomorrow, any reminders due tomorrow, and anything from today's background tasks I still need to act on.",
    time: "18:00",
    repeat: "daily",
  },
];

const STATUS_LABEL: Record<Task["status"], string> = {
  queued: "Queued",
  running: "Working",
  waiting_approval: "Needs your OK",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function TasksScreen({ settings, refreshKey }: { settings: Settings; refreshKey: number }) {
  const styles = useShared();
  const colors = useColors();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, r] = await Promise.all([api.tasks(settings), api.reminders(settings)]);
      setTasks(t);
      setReminders(r);
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
      <Header
        title="Tasks and reminders"
        right={
          <LinkButton
            label="Add routine"
            onPress={() =>
              Alert.alert("Add a routine", "Jarvis runs it on schedule and sends you the answer. You can also just ask in chat, like \"every Sunday at 6, plan my week\".", [
                ...ROUTINES.map((r) => ({
                  text: r.label,
                  onPress: () =>
                    api
                      .addRoutine(settings, { text: r.text, time: r.time, repeat: r.repeat })
                      .then(load, (err) => Alert.alert("Couldn't add it", String(err))),
                })),
                { text: "Cancel", style: "cancel" as const },
              ])
            }
          />
        }
      />
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListHeaderComponent={
          reminders.length > 0 ? (
            <View>
              <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingTop: 8 }]}>Upcoming</Text>
              {reminders.map((r) => (
                <Pressable
                  key={r.id}
                  style={styles.row}
                  onPress={() =>
                    Alert.alert("Cancel this?", r.text, [
                      { text: "Keep", style: "cancel" },
                      { text: "Cancel it", style: "destructive", onPress: () => api.cancelReminder(settings, r.id).then(load) },
                    ])
                  }
                >
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {r.action === "run" ? "⚙︎ " : "⏰ "}
                    {r.text}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {new Date(r.due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}
                    {r.repeat ? ` · ${r.repeat}` : ""}
                  </Text>
                </Pressable>
              ))}
              <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingTop: 16 }]}>Background tasks</Text>
            </View>
          ) : undefined
        }
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
            <Text style={styles.rowMeta}>
              {relativeTime(item.created_at)}
              {item.cost_usd > 0 ? ` · $${item.cost_usd.toFixed(2)}` : ""}
            </Text>
            {item.status === "running" && item.last_message ? (
              <Text style={styles.rowMeta} numberOfLines={open === item.id ? undefined : 2}>
                Latest: {item.last_message}
              </Text>
            ) : null}
            {item.files.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => openTaskFile(settings, item.id, f).catch((err) => Alert.alert("Couldn't open the file", String(err)))}
                accessibilityRole="button"
                accessibilityHint="Downloads the file to share or save it"
                style={{ flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: colors.surface, padding: 10, borderRadius: 8, marginTop: 6 }}
              >
                <Text style={{ flex: 1, color: colors.accent }} numberOfLines={1}>
                  📄 {f.filename}
                </Text>
                <Text style={styles.rowMeta}>{fileSize(f.size_bytes)}</Text>
              </Pressable>
            ))}
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
                {item.status === "queued" || item.status === "running" || item.status === "waiting_approval" ? (
                  <View style={{ alignItems: "flex-start", marginTop: 8 }}>
                    <LinkButton
                      label="Stop this task"
                      danger
                      onPress={() =>
                        Alert.alert("Stop this task?", item.summary ?? item.instructions, [
                          { text: "Keep going", style: "cancel" },
                          {
                            text: "Stop",
                            style: "destructive",
                            onPress: () => api.cancelTask(settings, item.id).then(load, (err) => Alert.alert("Couldn't stop it", String(err))),
                          },
                        ])
                      }
                    />
                  </View>
                ) : null}
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
