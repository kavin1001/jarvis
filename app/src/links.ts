/**
 * jarvis://ask?text=...   ask a question (add &voice=1 to hear the answer)
 * jarvis://listen         open and start listening (add ?handsfree=1 to keep the conversation going)
 * jarvis://new            start a new chat
 * Used by the iOS Shortcuts app, Siri ("Hey Siri, Ask Jarvis") and the Action button.
 *
 * The web app takes the same paths on its own address (https://your-backend/ask?text=...),
 * plus /share?title=&text=&url=, which Android's share sheet opens once Jarvis is installed
 * from the browser. A share fills in the message box instead of sending.
 */
export type Command =
  | { id: number; kind: "ask"; text: string; voice: boolean }
  | { id: number; kind: "listen"; handsFree: boolean }
  | { id: number; kind: "new" }
  | { id: number; kind: "draft"; text: string };

let nextId = 1;

/** Ask Jarvis something from outside the chat screen, such as a notification reply. */
export const askCommand = (text: string): Command => ({ id: nextId++, kind: "ask", text: text.slice(0, 20_000), voice: false });

export function parseLink(url: string): Command | null {
  const match = url.match(/^(?:jarvis:\/\/\/?|https?:\/\/[^/?#]+\/)([^?#]*)(?:\?([^#]*))?/i);
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
    case "share": {
      // Apps fill these in differently: a link may arrive as url, or inside text.
      const parts = [params.get("title"), params.get("text"), params.get("url")].map((p) => p?.trim()).filter(Boolean);
      const text = [...new Set(parts)].join("\n");
      return text ? { id: nextId++, kind: "draft", text: text.slice(0, 20_000) } : null;
    }
    default:
      return null;
  }
}
