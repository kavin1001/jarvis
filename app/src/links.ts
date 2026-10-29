/**
 * jarvis://ask?text=...   ask a question (add &voice=1 to hear the answer)
 * jarvis://listen         open and start listening (add ?handsfree=1 to keep the conversation going)
 * jarvis://new            start a new chat
 * Used by the iOS Shortcuts app, Siri ("Hey Siri, Ask Jarvis") and the Action button.
 */
export type Command =
  | { id: number; kind: "ask"; text: string; voice: boolean }
  | { id: number; kind: "listen"; handsFree: boolean }
  | { id: number; kind: "new" };

let nextId = 1;

export function parseLink(url: string): Command | null {
  const match = url.match(/^jarvis:\/\/\/?([^?#]*)(?:\?([^#]*))?/i);
  if (!match) return null;
  const path = match[1].replace(/\/$/, "").toLowerCase();
  const params = new URLSearchParams(match[2] ?? "");
  const flag = (name: string) => ["1", "true", "yes"].includes((params.get(name) ?? "").toLowerCase());
  switch (path) {
    case "ask": {
      const text = params.get("text")?.trim();
      if (!text) return { id: nextId++, kind: "listen", handsFree: flag("handsfree") };
      return { id: nextId++, kind: "ask", text: text.slice(0, 20_000), voice: flag("voice") };
    }
    case "listen":
    case "voice":
      return { id: nextId++, kind: "listen", handsFree: flag("handsfree") };
    case "new":
      return { id: nextId++, kind: "new" };
    default:
      return null;
  }
}
