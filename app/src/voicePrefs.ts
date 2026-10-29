import { useSyncExternalStore } from "react";
import * as storage from "./storage";

/** When replies are read aloud: only after you spoke, every time, or never. */
export type ReadReplies = "voice" | "always" | "never";

export interface VoicePrefs {
  readReplies: ReadReplies;
  /** Speaking speed; 1 is the voice's normal pace. */
  rate: number;
}

export const RATES: [number, string][] = [
  [0.85, "Slower"],
  [1, "Normal"],
  [1.2, "Faster"],
  [1.4, "Fastest"],
];

const KEY = "jarvis-voice";
const defaults: VoicePrefs = { readReplies: "voice", rate: 1 };
let prefs = defaults;
const listeners = new Set<() => void>();

storage
  .getItemAsync(KEY)
  .then((raw) => {
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<VoicePrefs>;
    prefs = {
      readReplies: saved.readReplies === "always" || saved.readReplies === "never" ? saved.readReplies : "voice",
      rate: RATES.some(([r]) => r === saved.rate) ? saved.rate! : 1,
    };
    listeners.forEach((l) => l());
  })
  .catch(() => {});

export const voicePrefs = () => prefs;

export function setVoicePrefs(change: Partial<VoicePrefs>) {
  prefs = { ...prefs, ...change };
  storage.setItemAsync(KEY, JSON.stringify(prefs));
  listeners.forEach((l) => l());
}

export function useVoicePrefs() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    voicePrefs,
  );
}

/** Whether a reply to a message sent by voice or text should be spoken. */
export function shouldSpeak(source: "text" | "voice") {
  const { readReplies } = prefs;
  return readReplies === "always" || (readReplies === "voice" && source === "voice");
}
