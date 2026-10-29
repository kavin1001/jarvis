import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import * as Speech from "expo-speech";
import { useRef, useState } from "react";

/**
 * Hold-to-talk: start() on press, stop() on release. onFinal receives the
 * transcript once recognition ends. speak() reads replies aloud.
 */
export function useVoice(onFinal: (transcript: string) => void, onSilence?: () => void) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const transcript = useRef("");

  useSpeechRecognitionEvent("result", (e) => {
    transcript.current = e.results[0]?.transcript ?? "";
    setPartial(transcript.current);
  });
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    const text = transcript.current.trim();
    transcript.current = "";
    setPartial("");
    if (text) onFinal(text);
    else onSilence?.();
  });
  useSpeechRecognitionEvent("error", (e) => {
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
    ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: true, continuous: false });
  }

  function stop() {
    ExpoSpeechRecognitionModule.stop();
  }

  return { listening, partial, start, stop };
}

/**
 * Speaks streamed text sentence by sentence, so voice replies start early.
 * onFinished runs once everything queued before flush() has been spoken,
 * unless speech was stopped (for example by tapping the mic).
 */
export function createSpeaker(onFinished?: () => void) {
  let pending = "";
  let queued = 0;
  let flushed = false;
  let stopped = false;
  const done = () => {
    queued--;
    if (flushed && queued === 0 && !stopped) onFinished?.();
  };
  const say = (text: string) => {
    queued++;
    Speech.speak(text, { onDone: done, onError: done, onStopped: () => ((stopped = true), done()) });
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
