/**
 * jarvis://ask?text=...   ask a question (add &voice=1 to hear the answer)
 * jarvis://listen         open and start listening
 * jarvis://new            start a new chat
 * Used by the iOS Shortcuts app, Siri ("Hey Siri, Ask Jarvis") and the Action button.
 */
export type Command =
  | { id: number; kind: "ask"; text: string; voice: boolean }
  | { id: number; kind: "listen" }
  | { id: number; kind: "new" };

let nextId = 1;

export function parseLink(url: string): Command | null {
  const match = url.match(/^jarvis:\/\/\/?([^?#]*)(?:\?([^#]*))?/i);
  if (!match) return null;
  const path = match[1].replace(/\/$/, "").toLowerCase();
  const params = new URLSearchParams(match[2] ?? "");
  switch (path) {
    case "ask": {
      const text = params.get("text")?.trim();
      if (!text) return { id: nextId++, kind: "listen" };
      const voice = ["1", "true", "yes"].includes((params.get("voice") ?? "").toLowerCase());
      return { id: nextId++, kind: "ask", text: text.slice(0, 20_000), voice };
    }
    case "listen":
    case "voice":
      return { id: nextId++, kind: "listen" };
    case "new":
      return { id: nextId++, kind: "new" };
    default:
      return null;
  }
}
