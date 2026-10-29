import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { Alert } from "../dialog";
import { api, type MailSnooze, type MailWatch, type PageWatch, type PlaceReminder, type Reminder, type Repeat, type Settings, type Task } from "../api";
import { askApproval } from "../usePush";
import { Empty, Header, LinkButton, relativeTime, useShared } from "../ui";
import { Text, useColors } from "../theme";
import { fileSize, openTaskFile } from "../taskFiles";

const REPEAT_LABELS: Record<Repeat, string> = {
  daily: "every day",
  weekdays: "weekdays",
  weekends: "weekends",
  weekly: "every week",
  biweekly: "every two weeks",
  monthly: "every month",
};

const ROUTINES: { label: string; text: string; time: string; repeat: Repeat; weekday?: number }[] = [
  {
    label: "Morning briefing (weekdays, 8:00)",
    text: "Morning briefing: today's weather where I am, what's on my calendar, any important unread email, birthdays today or tomorrow, and two or three top news headlines. Keep it short.",
    time: "08:00",
    repeat: "weekdays",
  },
  {
    label: "Evening wrap-up (daily, 18:00)",
    text: "Evening wrap-up: what's on my calendar tomorrow, any reminders due tomorrow, and anything from today's background tasks I still need to act on.",
    time: "18:00",
    repeat: "daily",
  },
  {
    label: "Inbox catch-up (weekdays, 17:00)",
    text: "Inbox catch-up: look through today's unread email and tell me which few need a reply or action from me, one line each, and offer to draft replies. Skip newsletters and notifications.",
    time: "17:00",
    repeat: "weekdays",
  },
  {
    label: "Evening journal (daily, 21:00)",
    text: 'Journal check-in: ask me in one short, friendly line how my day went. When I answer, add it with today\'s date to my note titled "Journal" (create the note the first time).',
    time: "21:00",
    repeat: "daily",
  },
  {
    label: "Plan my week (Sundays, 18:00)",
    text: "Plan my week: go through my calendar for the coming week, point out busy days, clashes and free evenings, and list the reminders and to-dos that are due. End with the one thing to prepare tonight.",
    time: "18:00",
    repeat: "weekly",
    weekday: 0,
  },
  {
    label: "Weekend ideas (weekends, 9:00)",
    text: "Weekend ideas: check today's weather where I am and what's on my calendar, then suggest two or three things to do today that fit. Keep it short.",
    time: "09:00",
    repeat: "weekends",
  },
];

function placeRule(r: PlaceReminder) {
  const where = r.place_name === "home" ? "home" : r.place_name;
  const what = r.on_event === "arrive" ? (where === "home" ? "When you get home" : `When you get to ${where}`) : `When you leave ${where}`;
  return r.every_time ? `${what}, every time` : what;
}

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
  const [atPlaces, setAtPlaces] = useState<PlaceReminder[]>([]);
  const [watches, setWatches] = useState<MailWatch[]>([]);
  const [pages, setPages] = useState<PageWatch[]>([]);
  const [snoozed, setSnoozed] = useState<MailSnooze[]>([]);
  const [sheet, setSheet] = useState<SheetAction[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, r, p, w, pw, sn] = await Promise.all([
        api.tasks(settings),
        api.reminders(settings),
        api.placeReminders(settings).catch(() => []),
        api.mailWatches(settings).catch(() => []),
        api.pageWatches(settings).catch(() => []),
        api.mailSnoozes(settings).catch(() => []),
      ]);
      setTasks(t);
      setReminders(r);
      setAtPlaces(p);
      setWatches(w);
      setPages(pw);
      setSnoozed(sn);
    } finally {
      setLoading(false);
    }
  }, [settings]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const failed = (what: string) => (err: unknown) => Alert.alert(`Couldn't ${what}`, String(err));
  function reminderActions(r: Reminder): SheetAction[] {
    const due = new Date(r.due_at);
    const move = (label: string, to: Date): SheetAction => ({
      label,
      onPress: () => api.moveReminder(settings, r.id, to).then(load, failed("move it")),
    });
    if (r.nag_of) {
      return [
        { label: "Done", onPress: () => api.reminderDone(settings, r.id).then(load, failed("mark it done")) },
        move("Snooze an hour", new Date(Date.now() + 3600_000)),
      ];
    }
    return [
      ...(r.action === "run"
        ? [
            {
              label: "Run it now",
              onPress: () =>
                api.runReminderNow(settings, r.id).then(
                  () => Alert.alert("Running it now", "You'll get the answer as a notification and in a new chat. Its schedule stays the same."),
                  failed("run it"),
                ),
            },
          ]
        : []),
      ...(r.repeat
        ? [{ label: "Skip the next one", onPress: () => api.skipReminder(settings, r.id).then(load, failed("skip it")) }]
        : [move("An hour later", new Date(due.getTime() + 3600_000)), move("Same time tomorrow", new Date(due.getTime() + 24 * 3600_000))]),
      { label: r.repeat ? "Stop this routine" : "Cancel it", danger: true, onPress: () => api.cancelReminder(settings, r.id).then(load, failed("cancel it")) },
    ];
  }

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
                      .addRoutine(settings, { text: r.text, time: r.time, repeat: r.repeat, weekday: r.weekday })
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
          reminders.length > 0 || atPlaces.length > 0 || watches.length > 0 || pages.length > 0 || snoozed.length > 0 ? (
            <View>
              <Text style={[styles.rowMeta, { paddingHorizontal: 16, paddingTop: 8 }]}>Upcoming</Text>
              {reminders.map((r) => (
                <Pressable
                  key={r.id}
                  style={styles.row}
                  accessibilityHint={r.action === "run" ? "Run now, move or stop" : "Move or cancel"}
                  onPress={() => setSheet(reminderActions(r))}
                >
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {r.action === "run" ? "⚙︎ " : "⏰ "}
                    {r.text}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {new Date(r.due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}
                    {r.repeat ? ` · ${REPEAT_LABELS[r.repeat]}` : ""}
                    {r.nag_of ? " · again until you tap Done" : r.nag_minutes ? ` · keeps reminding every ${r.nag_minutes} min` : ""}
                  </Text>
                </Pressable>
              ))}
              {atPlaces.map((r) => (
                <Pressable
                  key={r.id}
                  style={styles.row}
                  accessibilityHint="Cancel"
                  onPress={() =>
                    setSheet([{ label: "Cancel it", danger: true, onPress: () => api.cancelPlaceReminder(settings, r.id).then(load, failed("cancel it")) }])
                  }
                >
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    📍 {r.text}
                  </Text>
                  <Text style={styles.rowMeta}>{placeRule(r)}</Text>
                </Pressable>
              ))}
              {watches.map((w) => (
                <Pressable
                  key={w.id}
                  style={styles.row}
                  accessibilityHint="Stop watching"
                  onPress={() =>
                    setSheet([{ label: "Stop watching", danger: true, onPress: () => api.cancelMailWatch(settings, w.id).then(load, failed("stop it")) }])
                  }
                >
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    ✉️ {w.about}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {w.once ? "Tells you about the first new email" : "Tells you about each new email"} · until{" "}
                    {new Date(w.expires_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                  </Text>
                </Pressable>
              ))}
              {snoozed.map((s) => (
                <Pressable
                  key={s.id}
                  style={styles.row}
                  accessibilityHint="Bring back now"
                  onPress={() => setSheet([{ label: "Back to the inbox now", onPress: () => api.unsnoozeMail(settings, s.id).then(load, failed("bring it back")) }])}
                >
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    💤 {s.about}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {s.count === 1 ? "Email" : `${s.count} emails`} back in your inbox{" "}
                    {new Date(s.due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}
                  </Text>
                </Pressable>
              ))}
              {pages.map((w) => (
                <Pressable
                  key={w.id}
                  style={styles.row}
                  accessibilityHint="Stop watching"
                  onPress={() =>
                    setSheet([{ label: "Stop watching", danger: true, onPress: () => api.cancelPageWatch(settings, w.id).then(load, failed("stop it")) }])
                  }
                >
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    🌐 {w.about}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={2}>
                    {w.look_for ? `Waiting for "${w.look_for}"` : "Waiting for a change"} on {w.url.replace(/^https?:\/\/(www\.)?/, "")}
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
      <ActionSheet actions={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
