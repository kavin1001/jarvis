import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { api, streamChat, type AgendaEvent, type ChatMessage, type PendingApproval, type Reminder, type Settings, type Task } from "../api";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Alert } from "../dialog";
import type { Command } from "../deepLink";
import { useConnection } from "../connection";
import { approximateLocation } from "../location";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { Markdown, plainText } from "../Markdown";
import * as Speech from "expo-speech";
import type { Doc } from "../documents";
import { chooseAttachments, type Photo } from "../photos";
import { Text, TextInput, useStyles, type Palette, type TextInputHandle } from "../theme";
import { askApproval } from "../usePush";
import { createSpeaker, isStopPhrase, useVoice } from "../useVoice";
import { shouldSpeak } from "../voicePrefs";

// Shown on an empty chat so a new user sees what Jarvis can do.
const SUGGESTIONS = [
  "What's on my calendar today?",
  "Summarize my unread email",
  "Remind me to call Mom at 6pm",
  "What did we talk about yesterday?",
];

/** "Today 6:00 PM" or "Tomorrow 8:00 AM", for the next day of reminders and events. */
function whenLabel(iso: string) {
  const due = new Date(iso);
  const time = due.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return due.toDateString() === new Date().toDateString() ? `Today ${time}` : `Tomorrow ${time}`;
}

/** "Today" or "Tomorrow" for an all-day event's plain date (YYYY-MM-DD, in local time). */
function dayLabel(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toDateString() === new Date().toDateString() ? "Today" : "Tomorrow";
}

type Queued = { id: number; text: string; source: "text" | "voice"; photos: Photo[]; docs: Doc[] };

export default function ChatScreen({
  settings,
  conversationId,
  onConversation,
  refreshKey,
  command,
}: {
  settings: Settings;
  conversationId: string | undefined;
  onConversation: (id: string | undefined) => void;
  /** Bumped by the parent when a push says something changed. */
  refreshKey: number;
  /** A shortcut or Siri link to act on once. */
  command?: Command | null;
}) {
  const styles = useStyles(makeStyles);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  // Messages written while the server can't be reached, sent in order once it answers again.
  const [queue, setQueue] = useState<Queued[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const connection = useConnection();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const list = useRef<FlatList<ChatMessage>>(null);
  const [sheet, setSheet] = useState<SheetAction[] | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  // The conversation the reply in flight belongs to, known once the server names it.
  const replyConversation = useRef<string | undefined>(undefined);
  // Hands-free: after Jarvis finishes speaking, listen again until silence or "stop".
  const [handsFree, setHandsFreeState] = useState(false);
  const handsFreeRef = useRef(false);
  const setHandsFree = (on: boolean) => {
    handsFreeRef.current = on;
    setHandsFreeState(on);
  };

  // What's coming up, shown on an empty chat.
  const [upcoming, setUpcoming] = useState<{ weather: string | null; events: AgendaEvent[]; reminders: Reminder[]; working: Task[] }>({
    weather: null,
    events: [],
    reminders: [],
    working: [],
  });

  // Set when a reply's connection drops: until then, refresh that chat until the reply arrives.
  const catchUp = useRef<{ until: number; conversationId: string } | null>(null);
  const catchUpTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    const tasks = await api.tasks(settings).catch(() => []);
    setApprovals(tasks.flatMap((t) => t.pending_approvals));
    const loaded = conversationId ? await api.messages(settings, conversationId) : [];
    // A message sent while this was loading (a link or notification reply) shows its own bubbles.
    if (inFlight.current) return;
    setMessages(loaded);
    // After a dropped connection, keep checking until the server's reply shows up.
    clearTimeout(catchUpTimer.current);
    const waiting = catchUp.current;
    if (waiting && waiting.conversationId === conversationId && Date.now() < waiting.until && loaded.at(-1)?.role !== "assistant") {
      setStatus("Still working on it…");
      catchUpTimer.current = setTimeout(() => refreshRef.current(), 3000);
    } else if (waiting) {
      catchUp.current = null;
      setStatus(null);
    }
    if (!conversationId) {
      const dayAhead = Date.now() + 24 * 3600_000;
      const [reminders, agenda] = await Promise.all([
        api.reminders(settings).catch(() => []),
        approximateLocation().then((near) => api.agenda(settings, near)).catch(() => ({ events: [], weather: null })),
      ]);
      setUpcoming({
        weather: agenda.weather ?? null,
        events: agenda.events,
        reminders: reminders.filter((r) => Date.parse(r.due_at) <= dayAhead).slice(0, 3),
        working: tasks.filter((t) => t.status === "queued" || t.status === "running" || t.status === "waiting_approval").slice(0, 3),
      });
    }
  }, [settings, conversationId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => () => clearTimeout(catchUpTimer.current), []);

  useEffect(() => {
    if (!busy) refresh();
  }, [refresh, refreshKey]);

  // Back in the app: pick up a reply that finished while it was in the background.
  const refreshSoon = useRef(false);
  useEffect(() => {
    if (!busy && refreshSoon.current) {
      refreshSoon.current = false;
      refresh();
    }
    const sub = AppState.addEventListener("change", (state) => state === "active" && !inFlight.current && refresh());
    return () => sub.remove();
  }, [refresh, busy]);

  async function send(text: string, source: "text" | "voice", attached = { photos, docs }) {
    const { photos: sentPhotos, docs: documents } = attached;
    if (!text.trim() && sentPhotos.length === 0 && documents.length === 0) return;
    if (busy || !connection.online) {
      // Offline, or already waiting on a reply: hold it and send it when possible.
      if (!connection.online || queue.length > 0) {
        setQueue((q) => [...q, { id: Date.now(), text, source, photos: sentPhotos, docs: documents }]);
        setDraft("");
        setPhotos([]);
        setDocs([]);
      }
      return;
    }
    if (!text.trim()) text = documents.length ? "Summarize this." : "What's in this photo?";
    const images = sentPhotos.map(({ media_type, data }) => ({ media_type, data }));
    setBusy(true);
    setDraft("");
    setPhotos([]);
    setDocs([]);
    const speak = shouldSpeak(source);
    const speaker = speak || source === "voice" ? createSpeaker(() => handsFreeRef.current && voice.start(), !speak) : null;
    const replyId = `pending-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", kind: "turn", text: `${documents.map((d) => `📄 ${d.name}\n`).join("")}${images.length ? "📷 " : ""}${text}`, source },
      { id: replyId, role: "assistant", kind: "turn", text: "", source: "text" },
    ]);
    const appendReply = (delta: string) =>
      setMessages((m) => m.map((msg) => (msg.id === replyId ? { ...msg, text: msg.text + delta } : msg)));

    const controller = new AbortController();
    inFlight.current = controller;
    let heard = false;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const location = await approximateLocation();
      await streamChat(settings, { conversationId, text, source, timezone, images, documents, location }, (e) => {
        heard = true;
        switch (e.type) {
          case "conversation":
            replyConversation.current = e.conversationId;
            if (e.conversationId !== conversationId) onConversation(e.conversationId);
            break;
          case "text":
            setStatus(null);
            appendReply(e.text);
            speaker?.push(e.text);
            break;
          case "status":
            setStatus(e.text);
            break;
          case "task_started":
            appendReply(`\n\n⏳ Working in the background: ${e.summary}`);
            break;
          case "error":
            appendReply(`\n\n${e.message}`);
            break;
        }
      }, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) appendReply(" …(stopped)");
      else if (!heard && !(await connection.check())) {
        // Never reached the server: hold the message and send it once the server is back.
        setMessages((m) => m.slice(0, -2));
        setQueue((q) => [{ id: Date.now(), text, source, photos: sentPhotos, docs: documents }, ...q]);
      } else if (heard) {
        // The connection dropped mid-reply (often the app going to the background). The
        // server finishes the reply anyway, so show what it has instead of an error.
        refreshSoon.current = true;
        if (replyConversation.current) catchUp.current = { until: Date.now() + 3 * 60_000, conversationId: replyConversation.current };
      } else appendReply(`\n\nCould not reach Jarvis: ${String(err)}`);
    } finally {
      inFlight.current = null;
      setStatus(null);
      if (controller.signal.aborted) Speech.stop();
      else speaker?.flush();
      setBusy(false);
    }
  }

  const voice = useVoice(
    (transcript) => {
      if (handsFreeRef.current && isStopPhrase(transcript)) return setHandsFree(false);
      send(transcript, "voice");
    },
    () => setHandsFree(false),
  );

  function remindActions(text: string): SheetAction[] {
    const words = text.replace(/\s+/g, " ").trim();
    const reminder = words.length > 160 ? `${words.slice(0, 157)}…` : words;
    const at = (hour: number, dayOffset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, 0, 0, 0);
      return d;
    };
    const options: [string, Date][] = [
      ["In 20 minutes", new Date(Date.now() + 20 * 60_000)],
      ["In an hour", new Date(Date.now() + 3600_000)],
      ...(new Date().getHours() < 17 ? [["This evening at 6", at(18, 0)] as [string, Date]] : []),
      ["Tomorrow at 9 AM", at(9, 1)],
    ];
    return options.map(([label, when]) => ({
      label,
      onPress: () =>
        api.addReminder(settings, { text: reminder, due_at: when.toISOString(), conversation_id: conversationId }).then(
          () => {
            if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert("Reminder set", `${whenLabel(when.toISOString())}: ${reminder}`);
          },
          (err) => Alert.alert("Couldn't set the reminder", String(err)),
        ),
    }));
  }

  function messageActions(item: ChatMessage): SheetAction[] {
    const text = item.role === "assistant" ? plainText(item.text) : item.text;
    const actions: SheetAction[] = [
      {
        label: "Copy",
        onPress: () => {
          Clipboard.setStringAsync(item.text.trim());
          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ];
    if (item.role === "assistant") {
      actions.push({
        label: "Read aloud",
        onPress: () => {
          Speech.stop();
          const speaker = createSpeaker();
          speaker.push(text);
          speaker.flush();
        },
      });
    }
    actions.push({
      label: "Share",
      onPress: () => Share.share({ message: text }).catch(() => Clipboard.setStringAsync(text)),
    });
    if (item.text.trim()) actions.push({ label: "Remind me about this", onPress: () => setSheet(remindActions(text)) });
    if (item.text.trim())
      actions.push({
        label: "Save as note",
        onPress: () =>
          api.createNote(settings, item.text.trim()).then(
            (note) => {
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert("Saved to Notes", `"${note.title}" is in the Lists tab, under Notes.`);
            },
            (err) => Alert.alert("Couldn't save the note", String(err)),
          ),
      });
    if (item.role === "user" && item.kind === "turn") {
      // Attachments aren't kept on the phone, so only the words are sent again.
      const words = item.text.replace(/^(📄 .*\n)+/, "").replace(/^📷 /, "");
      if (words.trim()) actions.push({ label: "Send again", onPress: () => send(words, "text") });
    }
    return actions;
  }

  // Back online: send what was held, oldest first, one reply at a time.
  useEffect(() => {
    if (!connection.online || busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    send(next.text, next.source, next);
  }, [connection.online, busy, queue]);

  /** Takes a held message back into the message box. */
  function unqueue(item: Queued) {
    setQueue((q) => q.filter((x) => x.id !== item.id));
    setDraft(item.text);
    setPhotos(item.photos);
    setDocs(item.docs);
  }

  // The box is disabled while Jarvis replies; on a computer, put the cursor back afterwards.
  const composer = useRef<TextInputHandle>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (Platform.OS === "web" && wasBusy.current && !busy) composer.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  // Each command runs once, after the screen is ready.
  const handled = useRef(0);
  useEffect(() => {
    if (!command || command.id === handled.current || busy) return;
    handled.current = command.id;
    if (command.kind === "new") onConversation(undefined);
    else if (command.kind === "draft") setDraft(command.text);
    else if (command.kind === "listen") {
      setHandsFree(command.handsFree);
      voice.start();
    }
    else send(command.text, command.voice ? "voice" : "text");
  }, [command, busy]);

  // Tap to talk hands-free (stops on silence, or tap again), or hold and release.
  const pressedAt = useRef<number | null>(null);
  const micIn = () => {
    if (voice.listening) {
      pressedAt.current = null;
      voice.stop();
    } else {
      pressedAt.current = Date.now();
      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // Talking over Jarvis cuts its reply short, as with a person.
      Speech.stop();
      voice.start();
    }
  };
  const micOut = () => {
    if (pressedAt.current !== null && Date.now() - pressedAt.current > 400) voice.stop();
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>Jarvis</Text>
        <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
          <Pressable
            onPress={() => {
              if (handsFree) return setHandsFree(false);
              setHandsFree(true);
              if (!voice.listening && !busy) voice.start();
            }}
            style={[styles.pill, handsFree && styles.pillOn]}
            accessibilityLabel={handsFree ? "Turn off hands-free" : "Start a hands-free conversation"}
          >
            <Text style={[styles.pillText, handsFree && styles.pillTextOn]}>Hands-free</Text>
          </Pressable>
          <Pressable onPress={() => onConversation(undefined)} accessibilityRole="button">
            <Text style={styles.link}>New chat</Text>
          </Pressable>
        </View>
      </View>

      {approvals.map((a) => (
        <Pressable
          key={a.id}
          style={styles.approval}
          onPress={() => askApproval(settings, a.id, a.summary, refresh)}
          accessibilityRole="button"
          accessibilityHint="Approve or deny"
        >
          <Text style={styles.approvalText}>Needs your OK: {a.summary}</Text>
        </Pressable>
      ))}

      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            {upcoming.weather || upcoming.events.length > 0 || upcoming.reminders.length > 0 || upcoming.working.length > 0 ? (
              <View style={styles.today}>
                {upcoming.weather ? (
                  <Text style={styles.todayLine} numberOfLines={1}>
                    🌤 {upcoming.weather}
                  </Text>
                ) : null}
                {upcoming.events.map((e, i) => (
                  <Text key={`${e.start}-${i}`} style={styles.todayLine} numberOfLines={1}>
                    📅 {e.all_day ? dayLabel(e.start) : whenLabel(e.start)} · {e.summary}
                  </Text>
                ))}
                {upcoming.reminders.map((r) => (
                  <Text key={r.id} style={styles.todayLine} numberOfLines={1}>
                    ⏰ {whenLabel(r.due_at)} · {r.text}
                  </Text>
                ))}
                {upcoming.working.map((t) => (
                  <Text key={t.id} style={styles.todayLine} numberOfLines={1}>
                    {t.status === "waiting_approval" ? "✋ Needs your OK" : "⏳ Working"} · {t.summary ?? t.instructions}
                  </Text>
                ))}
              </View>
            ) : null}
            <Text style={styles.emptyTitle}>How can I help?</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} style={styles.suggestion} onPress={() => send(s, "text")} disabled={busy} accessibilityRole="button">
                <Text style={styles.suggestionText}>{s}</Text>
              </Pressable>
            ))}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onLongPress={() => {
              if (!item.text) return;
              if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setSheet(messageActions(item));
            }}
            accessibilityHint="Hold for copy, read aloud and share"
            accessibilityLabel={`${item.kind === "task_update" ? "Update" : item.role === "user" ? "You" : "Jarvis"}: ${item.role === "assistant" ? plainText(item.text) : item.text}`}
            accessibilityActions={item.text ? [{ name: "longpress", label: "More actions" }] : []}
            onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && setSheet(messageActions(item))}
            style={[
              styles.bubble,
              item.role === "user" ? styles.user : styles.assistant,
              item.kind === "task_update" && styles.taskUpdate,
            ]}
          >
            {item.role === "assistant" && item.text ? (
              <Markdown text={item.text} />
            ) : (
              <Text style={item.role === "user" ? styles.userText : undefined}>
                {item.source === "voice" ? "🎙 " : ""}
                {item.text || "…"}
              </Text>
            )}
          </Pressable>
        )}
      />

      <ActionSheet actions={sheet} onClose={() => setSheet(null)} />

      {queue.map((item) => (
        <Pressable
          key={item.id}
          style={styles.queued}
          onPress={() => unqueue(item)}
          accessibilityRole="button"
          accessibilityHint="Puts it back in the message box"
        >
          <Text style={styles.queuedText} numberOfLines={1}>
            🕓 {item.photos.length || item.docs.length ? "📎 " : ""}
            {item.text || "Attachment"}
          </Text>
          <Text style={styles.queuedMeta}>{connection.online ? "Sending next · tap to edit" : "Sends when you're back online · tap to edit"}</Text>
        </Pressable>
      ))}

      {(busy || catchUp.current) && status && !voice.listening && <Text style={styles.partial}>{status}</Text>}
      {voice.listening && <Text style={styles.partial}>{voice.partial || "Listening…"}</Text>}

      {docs.length > 0 && (
        <View style={styles.photos}>
          {docs.map((d, i) => (
            <Pressable
              key={`${d.name}-${i}`}
              style={styles.docChip}
              onPress={() => setDocs((all) => all.filter((_, j) => j !== i))}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${d.name}`}
            >
              <Text numberOfLines={1}>📄 {d.name} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}

      {photos.length > 0 && (
        <View style={styles.photos}>
          {photos.map((p, i) => (
            <Pressable
              key={p.uri}
              onPress={() => setPhotos((all) => all.filter((_, j) => j !== i))}
              accessibilityRole="button"
              accessibilityLabel={`Remove photo ${i + 1}`}
            >
              <Image source={{ uri: p.uri }} style={styles.thumb} />
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.composer}>
        <Pressable
          style={styles.attach}
          onPress={() =>
            chooseAttachments().then((a) => {
              setPhotos((all) => [...all, ...a.photos].slice(0, 4));
              setDocs((all) => [...all, ...a.docs].slice(0, 2));
            })
          }
          disabled={busy}
          accessibilityLabel="Add a photo or file"
        >
          <Text style={styles.attachText}>＋</Text>
        </Pressable>
        <TextInput
          ref={composer}
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask Jarvis"
          multiline
          editable={!busy}
          // On a computer keyboard, Enter sends and Shift+Enter starts a new line.
          onKeyPress={
            Platform.OS === "web"
              ? (e) => {
                  const key = e.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean };
                  if (key.key !== "Enter" || key.shiftKey || key.isComposing) return;
                  e.preventDefault();
                  send(draft, "text");
                }
              : undefined
          }
        />
        {busy ? (
          <Pressable
            style={[styles.button, styles.listening]}
            onPress={async () => {
              setHandsFree(false);
              Speech.stop();
              // Tell the server first: just closing the connection lets the reply finish
              // (so a locked phone still gets its answer as a notification).
              const id = replyConversation.current;
              if (id) await api.stopReply(settings, id).catch(() => {});
              inFlight.current?.abort();
            }}
            accessibilityLabel="Stop Jarvis"
          >
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        ) : draft || photos.length || docs.length ? (
          <Pressable style={styles.button} onPress={() => send(draft, "text")} disabled={busy} accessibilityRole="button" accessibilityLabel="Send">
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.button, voice.listening && styles.listening]}
            onPressIn={micIn}
            onPressOut={micOut}
            disabled={busy}
            accessibilityLabel={voice.listening ? "Stop listening" : "Talk to Jarvis"}
          >
            <Text style={styles.buttonText}>{voice.listening ? "●" : "Talk"}</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 },
    title: { fontSize: 22, fontWeight: "700" },
    link: { color: colors.accent, fontSize: 16 },
    approval: { backgroundColor: colors.warning, marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 8 },
    approvalText: { color: colors.warningText },
    list: { padding: 16, gap: 8 },
    bubble: { maxWidth: "85%", padding: 12, borderRadius: 16 },
    user: { alignSelf: "flex-end", backgroundColor: colors.accent },
    userText: { color: colors.onAccent },
    assistant: { alignSelf: "flex-start", backgroundColor: colors.surface },
    taskUpdate: { borderWidth: 1, borderColor: colors.muted },
    partial: { textAlign: "center", color: colors.muted, padding: 8 },
    queued: { alignSelf: "flex-end", maxWidth: "85%", marginHorizontal: 12, marginBottom: 6, padding: 10, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", borderColor: colors.accent },
    queuedText: { color: colors.text },
    queuedMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
    photos: { flexDirection: "row", gap: 8, paddingHorizontal: 12 },
    docChip: { backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 220 },
    thumb: { width: 56, height: 56, borderRadius: 8 },
    attach: { paddingHorizontal: 6, paddingVertical: 8 },
    attachText: { fontSize: 24, color: colors.accent },
    composer: { flexDirection: "row", padding: 12, gap: 8, alignItems: "flex-end" },
    input: { flex: 1, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120 },
    button: { backgroundColor: colors.accent, borderRadius: 24, paddingHorizontal: 18, paddingVertical: 12 },
    listening: { backgroundColor: colors.danger },
    pill: { borderWidth: 1, borderColor: colors.accent, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
    pillOn: { backgroundColor: colors.accent },
    pillText: { color: colors.accent, fontSize: 14 },
    pillTextOn: { color: colors.onAccent },
    buttonText: { color: colors.onAccent, fontWeight: "600" },
    empty: { alignItems: "center", gap: 10, paddingTop: 48 },
    emptyTitle: { fontSize: 18, fontWeight: "600", color: colors.subtle, marginBottom: 6 },
    suggestion: { borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
    suggestionText: { color: colors.subtle },
    today: { alignSelf: "stretch", backgroundColor: colors.surface, borderRadius: 12, padding: 12, gap: 6, marginBottom: 24 },
    todayLine: { color: colors.subtle },
  });
