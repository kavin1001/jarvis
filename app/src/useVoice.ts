import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import * as Speech from "expo-speech";
import { useRef, useState } from "react";

/**
 * Hold-to-talk: start() on press, stop() on release. onFinal receives the
 * transcript once recognition ends. speak() reads replies aloud.
 */
export function useVoice(onFinal: (transcript: string) => void) {
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
  });
  useSpeechRecognitionEvent("error", (e) => {
    console.warn("speech error", e.error, e.message);
    setListening(false);
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

/** Speaks streamed text sentence by sentence, so voice replies start early. */
export function createSpeaker() {
  let pending = "";
  return {
    push(delta: string) {
      pending += delta;
      const match = pending.match(/^[\s\S]*[.!?](\s|$)/);
      if (match) {
        Speech.speak(match[0].trim());
        pending = pending.slice(match[0].length);
      }
    },
    flush() {
      if (pending.trim()) Speech.speak(pending.trim());
      pending = "";
    },
  };
}
