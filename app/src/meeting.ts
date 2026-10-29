import type { Doc } from "./documents";

/**
 * Adds a recognition result to a running transcript. A final result is kept; a partial one is only shown
 * until the next result replaces it. Works whether finals are per utterance (web, Android) or the whole
 * session so far (iOS).
 */
export function addResult(t: { committed: string; live: string }, text: string, isFinal: boolean) {
  text = text.trim();
  if (!isFinal) return { committed: t.committed, live: text };
  return { committed: [t.committed, text].filter(Boolean).join(" "), live: "" };
}

/** Everything heard so far, including words not yet final. */
export const fullText = (t: { committed: string; live: string }) => [t.committed, t.live].filter(Boolean).join(" ");

/** "4:05" or "1:02:09". */
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** UTF-8 text as base64, for sending a transcript as a text file. */
export function utf8ToBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += abc[a >> 2] + abc[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : abc[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : abc[c & 63];
  }
  return out;
}

/** The message and transcript file that ask Jarvis to write up a recorded meeting and save it as a note. */
export function meetingMessage(transcript: string, startedAt: Date, ms: number) {
  const day = startedAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = startedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const doc: Doc = { name: `Meeting transcript, ${day} ${time}.txt`, media_type: "text/plain", data: utf8ToBase64(transcript) };
  const text =
    `I recorded a meeting (${minutes} minute${minutes === 1 ? "" : "s"}, started ${day} at ${time}). The transcript is attached; ` +
    `my phone's speech recognition made it, so expect wrong words and no speaker names. Write it up: a short summary, ` +
    `decisions, and action items with who owns them where you can tell. Then save that as a note titled "Meeting notes, ${day}".`;
  return { text, doc };
}
