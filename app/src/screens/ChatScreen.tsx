import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { api, streamChat, type ChatMessage, type PendingApproval, type Reminder, type Settings, type Task } from "../api";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { Command } from "../deepLink";
import { approximateLocation } from "../location";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { Markdown, plainText } from "../Markdown";
import * as Speech from "expo-speech";
import type { Doc } from "../documents";
import { chooseAttachments, type Photo } from "../photos";
import { Text, TextInput, useStyles, type Palette } from "../theme";
import { askApproval } from "../usePush";
import { createSpeaker, isStopPhrase, useVoice } from "../useVoice";

// Shown on an empty chat so a new user sees what Jarvis can do.
const SUGGESTIONS = [
  "What's on my calendar today?",
  "Summarize my unread email",
  "Remind me to call Mom at 6pm",
  "What did we talk about yesterday?",
];

/** "Today 6:00 PM" or "Tomorrow 8:00 AM", for the next day of reminders. */
function whenLabel(iso: string) {
  const due = new Date(iso);
  const time = due.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return due.toDateString() === new Date().toDateString() ? `Today ${time}` : `Tomorrow ${time}`;
}

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
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const list = useRef<FlatList<ChatMessage>>(null);
  const [sheet, setSheet] = useState<SheetAction[] | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  // Hands-free: after Jarvis finishes speaking, listen again until silence or "stop".
  const [handsFree, setHandsFreeState] = useState(false);
  const handsFreeRef = useRef(false);
  const setHandsFree = (on: boolean) => {
    handsFreeRef.current = on;
    setHandsFreeState(on);
  };

  // What's coming up, shown on an empty chat.
  const [upcoming, setUpcoming] = useState<{ reminders: Reminder[]; working: Task[] }>({ reminders: [], working: [] });

  const refresh = useCallback(async () => {
    const tasks = await api.tasks(settings).catch(() => []);
    setApprovals(tasks.flatMap((t) => t.pending_approvals));
    setMessages(conversationId ? await api.messages(settings, conversationId) : []);
    if (!conversationId) {
      const dayAhead = Date.now() + 24 * 3600_000;
      const reminders = await api.reminders(settings).catch(() => []);
      setUpcoming({
        reminders: reminders.filter((r) => Date.parse(r.due_at) <= dayAhead).slice(0, 3),
        working: tasks.filter((t) => t.status === "queued" || t.status === "running" || t.status === "waiting_approval").slice(0, 3),
      });
    }
  }, [settings, conversationId]);

  useEffect(() => {
    if (!busy) refresh();
  }, [refresh, refreshKey]);

  async function send(text: string, source: "text" | "voice") {
    if ((!text.trim() && photos.length === 0 && docs.length === 0) || busy) return;
    if (!text.trim()) text = docs.length ? "Summarize this." : "What's in this photo?";
    const images = photos.map(({ media_type, data }) => ({ media_type, data }));
    const documents = docs;
    setBusy(true);
    setDraft("");
    setPhotos([]);
    setDocs([]);
    const speaker = source === "voice" ? createSpeaker(() => handsFreeRef.current && voice.start()) : null;
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
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const location = await approximateLocation();
      await streamChat(settings, { conversationId, text, source, timezone, images, documents, location }, (e) => {
        switch (e.type) {
          case "conversation":
            if (e.conversationId !== conversationId) onConversation(e.conversationId);
            break;
          case "text":
            appendReply(e.text);
            speaker?.push(e.text);
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
      else appendReply(`\n\nCould not reach Jarvis: ${String(err)}`);
    } finally {
      inFlight.current = null;
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
    if (item.role === "user" && item.kind === "turn") {
      // Attachments aren't kept on the phone, so only the words are sent again.
      const words = item.text.replace(/^(📄 .*\n)+/, "").replace(/^📷 /, "");
      if (words.trim()) actions.push({ label: "Send again", onPress: () => send(words, "text") });
    }
    return actions;
  }

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
          <Pressable onPress={() => onConversation(undefined)}>
            <Text style={styles.link}>New chat</Text>
          </Pressable>
        </View>
      </View>

      {approvals.map((a) => (
        <Pressable key={a.id} style={styles.approval} onPress={() => askApproval(settings, a.id, a.summary, refresh)}>
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
            {upcoming.reminders.length > 0 || upcoming.working.length > 0 ? (
              <View style={styles.today}>
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
              <Pressable key={s} style={styles.suggestion} onPress={() => send(s, "text")} disabled={busy}>
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

      {voice.listening && <Text style={styles.partial}>{voice.partial || "Listening…"}</Text>}

      {docs.length > 0 && (
        <View style={styles.photos}>
          {docs.map((d, i) => (
            <Pressable key={`${d.name}-${i}`} style={styles.docChip} onPress={() => setDocs((all) => all.filter((_, j) => j !== i))}>
              <Text numberOfLines={1}>📄 {d.name} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}

      {photos.length > 0 && (
        <View style={styles.photos}>
          {photos.map((p, i) => (
            <Pressable key={p.uri} onPress={() => setPhotos((all) => all.filter((_, j) => j !== i))}>
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
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask Jarvis"
          multiline
          editable={!busy}
        />
        {busy ? (
          <Pressable
            style={[styles.button, styles.listening]}
            onPress={() => {
              setHandsFree(false);
              inFlight.current?.abort();
            }}
            accessibilityLabel="Stop Jarvis"
          >
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        ) : draft || photos.length || docs.length ? (
          <Pressable style={styles.button} onPress={() => send(draft, "text")} disabled={busy}>
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
