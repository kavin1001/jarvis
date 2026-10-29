import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import * as Speech from "expo-speech";
import { useRef, useState } from "react";
import { plainText } from "./Markdown";
import { voicePrefs } from "./voicePrefs";

/** Who the speech recognizer's events are for: the chat mic, or a meeting being recorded (MeetingRecorder). */
export const recognizer = { owner: "chat" as "chat" | "meeting" };

/**
 * Hold-to-talk: start() on press, stop() on release. onFinal receives the
 * transcript once recognition ends. speak() reads replies aloud.
 */
export function useVoice(onFinal: (transcript: string) => void, onSilence?: () => void) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const transcript = useRef("");

  useSpeechRecognitionEvent("result", (e) => {
    if (recognizer.owner !== "chat") return;
    transcript.current = e.results[0]?.transcript ?? "";
    setPartial(transcript.current);
  });
  useSpeechRecognitionEvent("end", () => {
    if (recognizer.owner !== "chat") return;
    setListening(false);
    const text = transcript.current.trim();
    transcript.current = "";
    setPartial("");
    if (text) onFinal(text);
    else onSilence?.();
  });
  useSpeechRecognitionEvent("error", (e) => {
    if (recognizer.owner !== "chat") return;
    // "no-speech" just means nobody talked; anything else is logged.
    if (e.error !== "no-speech") console.warn("speech error", e.error, e.message);
    setListening(false);
    onSilence?.();
  });

  async function start() {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) return;
    Speech.stop();
    transcript.current = "";
    setListening(true);
    ExpoSpeechRecognitionModule.start({ lang: phoneLocale(), interimResults: true, continuous: false });
  }

  function stop() {
    ExpoSpeechRecognitionModule.stop();
  }

  return { listening, partial, start, stop };
}

/** The phone's language and region, such as "en-GB", so recognition matches how you speak. */
export function phoneLocale() {
  const locale = (Intl.DateTimeFormat().resolvedOptions().locale || "en-US").split("-u-")[0];
  return locale === "en" ? "en-US" : locale;
}

/**
 * The most natural installed voice for the phone's language: a downloaded
 * "Premium" or "Enhanced" Siri voice when there is one (Settings, Accessibility,
 * Spoken Content, Voices), otherwise the system default.
 */
let bestVoice: Promise<string | undefined> | null = null;
function pickVoice() {
  // Some browsers never load a voice list; after a moment, use the default voice.
  bestVoice ??= Promise.race([
    Speech.getAvailableVoicesAsync(),
    new Promise<Speech.Voice[]>((resolve) => setTimeout(() => resolve([]), 1500)),
  ])
    .then((voices) => {
      const lang = (Intl.DateTimeFormat().resolvedOptions().locale || "en-US").split("-")[0];
      const mine = voices.filter((v) => v.language?.toLowerCase().startsWith(lang));
      const pick =
        mine.find((v) => /premium/i.test(v.identifier)) ??
        mine.find((v) => v.quality === Speech.VoiceQuality.Enhanced) ??
        undefined;
      return pick?.identifier;
    })
    .catch(() => undefined);
  return bestVoice;
}
pickVoice();

/**
 * Speaks streamed text sentence by sentence, so voice replies start early.
 * onFinished runs once everything queued before flush() has been spoken,
 * unless speech was stopped (for example by tapping the mic). A silent speaker
 * says nothing but still calls onFinished, so hands-free keeps listening.
 */
export function createSpeaker(onFinished?: () => void, silent = false) {
  let pending = "";
  let queued = 0;
  let flushed = false;
  let stopped = false;
  let order: Promise<void> = Promise.resolve();
  const done = () => {
    queued--;
    if (flushed && queued === 0 && !stopped) onFinished?.();
  };
  const say = (text: string) => {
    text = plainText(text);
    if (silent || !text) return;
    queued++;
    // Chained so sentences stay in order while the voice lookup is still pending.
    order = order.then(async () => {
      const voice = await pickVoice();
      Speech.speak(text, { voice, rate: voicePrefs().rate, onDone: done, onError: done, onStopped: () => ((stopped = true), done()) });
    });
  };
  return {
    push(delta: string) {
      pending += delta;
      const match = pending.match(/^[\s\S]*[.!?](\s|$)/);
      if (match) {
        say(match[0].trim());
        pending = pending.slice(match[0].length);
      }
    },
    flush() {
      if (pending.trim()) say(pending.trim());
      pending = "";
      flushed = true;
      if (queued === 0 && !stopped) onFinished?.();
    },
  };
}

/** Phrases that end hands-free mode instead of being sent. */
export function isStopPhrase(text: string) {
  return /^(stop|cancel|that'?s (all|it)|(ok(ay)? )?(thanks|thank you)( jarvis)?|goodbye|bye|never ?mind)[.!]?$/i.test(text.trim());
}
