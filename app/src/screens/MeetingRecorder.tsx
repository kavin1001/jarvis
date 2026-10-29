import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Alert } from "../dialog";
import { addResult, elapsed, fullText } from "../meeting";
import { Text, useStyles, type Palette } from "../theme";
import { phoneLocale, recognizer } from "../useVoice";

type Phase = "starting" | "recording" | "finishing" | "cancelled";

/**
 * Records a meeting with the phone's own speech recognition and hands back the transcript. Recognition
 * stops by itself after pauses or time limits, so it is restarted until the user taps Stop. The screen is
 * kept awake, because a locked phone stops listening.
 */
export function MeetingRecorder({ onDone, onCancel }: { onDone: (transcript: string, startedAt: Date, ms: number) => void; onCancel: () => void }) {
  const styles = useStyles(makeStyles);
  const [text, setText] = useState({ committed: "", live: "" });
  const [phase, setPhase] = useState<Phase>("starting");
  const [now, setNow] = useState(Date.now());
  const t = useRef(text);
  const phaseRef = useRef<Phase>("starting");
  const startedAt = useRef(new Date());
  // On-device recognition has no time limit and keeps the audio on the phone; fall back if the language isn't installed.
  const onDevice = useRef(Platform.OS !== "web" && ExpoSpeechRecognitionModule.supportsOnDeviceRecognition());
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const update = (next: { committed: string; live: string }) => {
    t.current = next;
    setText(next);
  };
  const listen = () =>
    ExpoSpeechRecognitionModule.start({
      lang: phoneLocale(),
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      iosTaskHint: "dictation",
      requiresOnDeviceRecognition: onDevice.current,
    });

  useSpeechRecognitionEvent("result", (e) => {
    if (recognizer.owner !== "meeting") return;
    update(addResult(t.current, e.results[0]?.transcript ?? "", e.isFinal));
  });
  useSpeechRecognitionEvent("end", () => {
    if (recognizer.owner !== "meeting") return;
    // Words still partial when recognition stopped are kept.
    if (t.current.live) update(addResult(t.current, t.current.live, true));
    if (phaseRef.current === "recording") return listen();
    recognizer.owner = "chat";
    if (phaseRef.current === "finishing") onDone(t.current.committed, startedAt.current, Date.now() - startedAt.current.getTime());
  });
  useSpeechRecognitionEvent("error", (e) => {
    if (recognizer.owner !== "meeting" || phaseRef.current !== "recording") return;
    if (e.error === "no-speech" || e.error === "speech-timeout") return; // "end" follows and listening restarts
    if (onDevice.current && (e.error === "language-not-supported" || e.error === "service-not-allowed")) {
      onDevice.current = false;
      return;
    }
    console.warn("meeting recording error", e.error, e.message);
    go("finishing");
    Alert.alert("Recording stopped", e.error === "interrupted" ? "Something else used the microphone, like a call." : e.message || e.error);
  });

  useEffect(() => {
    let alive = true;
    // Browsers can refuse a wake lock (a hidden tab, a headless one); recording works anyway.
    const awake = activateKeepAwakeAsync("meeting").catch(() => {});
    ExpoSpeechRecognitionModule.requestPermissionsAsync().then((permission) => {
      if (!alive) return;
      if (!permission.granted) {
        Alert.alert("Microphone needed", "Allow the microphone and speech recognition for Jarvis in Settings to record a meeting.");
        return onCancel();
      }
      recognizer.owner = "meeting";
      startedAt.current = new Date();
      go("recording");
      listen();
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(tick);
      awake.then(() => deactivateKeepAwake("meeting")).catch(() => {});
      if (phaseRef.current === "recording") {
        phaseRef.current = "cancelled";
        ExpoSpeechRecognitionModule.abort();
      }
      // Normally reset by the last "end" event; this covers one that never arrives.
      setTimeout(() => (recognizer.owner = "chat"), 1500);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop() {
    if (!fullText(t.current).trim()) {
      return Alert.alert("Nothing heard yet", "Jarvis hasn't picked up any words. Keep recording, or discard it.", [
        { text: "Keep recording", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: cancel },
      ]);
    }
    go("finishing");
    ExpoSpeechRecognitionModule.stop();
  }

  function cancel() {
    go("cancelled");
    ExpoSpeechRecognitionModule.abort();
    onCancel();
  }

  function confirmCancel() {
    if (now - startedAt.current.getTime() < 60_000) return cancel();
    Alert.alert("Discard this recording?", "The transcript will be lost.", [
      { text: "Keep recording", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: cancel },
    ]);
  }

  const words = fullText(text);
  return (
    <Modal visible animationType="slide" onRequestClose={confirmCancel}>
      <View style={styles.screen}>
        <Text style={styles.title}>{phase === "finishing" ? "Finishing…" : phase === "starting" ? "Starting…" : "Recording a meeting"}</Text>
        <Text style={styles.time} accessibilityLabel={`Recording time ${elapsed(now - startedAt.current.getTime())}`}>
          {phase === "starting" ? "0:00" : elapsed(now - startedAt.current.getTime())}
        </Text>
        <Text style={styles.note}>
          Transcribed {onDevice.current ? "on your phone" : "by your phone's speech service"}. Keep Jarvis open and the screen on. When you stop, Jarvis writes up the
          notes and saves them.
        </Text>
        <ScrollView style={styles.transcript} ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          <Text style={styles.words}>
            {text.committed}
            {text.live ? <Text style={styles.live}>{`${text.committed ? " " : ""}${text.live}`}</Text> : null}
            {words ? null : <Text style={styles.live}>Listening…</Text>}
          </Text>
        </ScrollView>
        <Pressable style={styles.stop} onPress={stop} disabled={phase !== "recording"} accessibilityRole="button">
          <Text style={styles.stopText}>Stop and write up notes</Text>
        </Pressable>
        <Pressable style={styles.discard} onPress={confirmCancel} disabled={phase === "finishing"} accessibilityRole="button">
          <Text style={styles.discardText}>Discard</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background, padding: 20, paddingTop: 64, maxWidth: 640, width: "100%", alignSelf: "center" },
    title: { fontSize: 22, fontWeight: "600", textAlign: "center" },
    time: { fontSize: 44, fontWeight: "300", textAlign: "center", marginVertical: 8, fontVariant: ["tabular-nums"] },
    note: { color: colors.muted, textAlign: "center", marginBottom: 12 },
    transcript: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: 12, marginBottom: 16 },
    words: { fontSize: 16, lineHeight: 22 },
    live: { color: colors.muted },
    stop: { backgroundColor: colors.danger, borderRadius: 24, paddingVertical: 14, alignItems: "center" },
    stopText: { color: colors.onAccent, fontSize: 17, fontWeight: "600" },
    discard: { paddingVertical: 14, alignItems: "center" },
    discardText: { color: colors.muted, fontSize: 16 },
  });
