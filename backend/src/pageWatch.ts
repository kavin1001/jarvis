import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { query } from "./db.js";
import * as memory from "./memory.js";
import { sendPush } from "./push.js";

/**
 * "Tell me when tickets go on sale", "let me know when this page changes": a web page
 * Jarvis fetches every half hour, notifying when the words appear or the text changes.
 */

export interface PageWatch {
  id: string;
  user_id: string;
  conversation_id: string | null;
  url: string;
  look_for: string | null;
  about: string;
  status: "active" | "done" | "cancelled" | "expired";
  last_hash: string | null;
  failures: number;
  checked_at: string;
  expires_at: string;
  created_at: string;
}

export const MAX_ACTIVE = 10;
export const CHECK_EVERY_MS = 30 * 60_000;
// A page that keeps failing (gone, blocking us) is dropped after a day of tries, with a note.
const MAX_FAILURES = 48;
const MAX_BYTES = 2 * 1024 * 1024;

// The server fetches these, so keep it to the public internet: no localhost, private networks or cloud metadata.
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Checks a URL is http(s) on the usual ports and every address its host resolves to is public. */
export async function checkUrl(raw: string, resolve: Resolve = resolveHost): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be watched.");
  if (url.port && url.port !== "443" && url.port !== "80") throw new Error("Only pages on the usual web ports can be watched.");
  if (url.username || url.password) throw new Error("Web addresses with a login in them can't be watched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new Error(`Couldn't find ${url.hostname}.`);
  if (!addresses.every(isPublicAddress)) throw new Error("Only public web pages can be watched.");
  return url;
}

/** The readable text of a page: tags, scripts and styles stripped, whitespace collapsed. */
export function pageText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export type FetchText = (url: string) => Promise<string>;

/** Fetches a page's text, following up to 3 redirects and checking each hop is public. */
export async function fetchPageText(raw: string, resolve: Resolve = resolveHost): Promise<string> {
  let url = await checkUrl(raw, resolve);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Jarvis page watch (personal assistant)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await checkUrl(new URL(res.headers.get("location")!, url).toString(), resolve);
      continue;
    }
    if (!res.ok) throw new Error(`The page answered ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/.test(type)) throw new Error(`That isn't a web page (${type || "unknown type"}).`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error("The page is too large to watch.");
    const text = body.toString("utf8");
    return /html/.test(type) ? pageText(text) : text.replace(/\s+/g, " ").trim();
  }
  throw new Error("The page redirects too many times.");
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const contains = (text: string, words: string) => text.toLowerCase().includes(words.toLowerCase().replace(/\s+/g, " ").trim());

/** The words around the first match, for the notification and the chat. */
function around(text: string, words: string) {
  const i = text.toLowerCase().indexOf(words.toLowerCase().replace(/\s+/g, " ").trim());
  if (i < 0) return "";
  const start = Math.max(0, i - 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, i + words.length + 120).trim()}…`;
}

/**
 * Starts watching after one fetch now, so a bad address fails at once. Returns null with a
 * snippet when the words are already on the page: nothing to wait for.
 */
export async function createPageWatch(
  w: { userId: string; conversationId: string | null; url: string; lookFor: string | null; about: string; days: number },
  fetchText: FetchText = (u) => fetchPageText(u),
): Promise<{ id: string } | { already: string }> {
  const [{ count }] = await query<{ count: number }>("SELECT count(*)::int AS count FROM page_watches WHERE user_id = $1 AND status = 'active'", [w.userId]);
  if (count >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} page watches at once. Cancel one first (list_reminders shows them).`);
  const text = await fetchText(w.url);
  if (w.lookFor && contains(text, w.lookFor)) return { already: around(text, w.lookFor) };
  const [row] = await query<{ id: string }>(
    `INSERT INTO page_watches (user_id, conversation_id, url, look_for, about, last_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id`,
    [w.userId, w.conversationId, w.url, w.lookFor, w.about, hashOf(text), w.days],
  );
  return { id: row.id };
}

export async function listPageWatches(userId: string) {
  return query<PageWatch>("SELECT * FROM page_watches WHERE user_id = $1 AND status = 'active' AND expires_at > now() ORDER BY created_at", [userId]);
}

export async function cancelPageWatch(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return (await query("UPDATE page_watches SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id", [id, userId])).length > 0;
}

export function describePageWatch(w: Pick<PageWatch, "about" | "url" | "look_for" | "expires_at">, timeZone = "UTC") {
  const until = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(w.expires_at));
  const what = w.look_for ? `for "${w.look_for}"` : "for changes";
  return `watching ${w.url} ${what} (${w.about}) until ${until}`;
}

/** Checks each watch that is due; claimed by moving checked_at first, so sweeps don't overlap. */
export async function checkPageWatches(fetchText: FetchText = (u) => fetchPageText(u), now = new Date()) {
  await query("UPDATE page_watches SET status = 'expired' WHERE status = 'active' AND expires_at <= $1", [now]);
  const dueBy = new Date(now.getTime() - CHECK_EVERY_MS);
  const due = await query<PageWatch>("SELECT * FROM page_watches WHERE status = 'active' AND checked_at <= $1 ORDER BY checked_at LIMIT 20", [dueBy]);
  for (const w of due) {
    const claimed = await query("UPDATE page_watches SET checked_at = $3 WHERE id = $1 AND checked_at <= $2 AND status = 'active' RETURNING id", [w.id, dueBy, now]);
    if (claimed.length === 0) continue;
    let text: string;
    try {
      text = await fetchText(w.url);
    } catch (err) {
      const [row] = await query<{ failures: number }>("UPDATE page_watches SET failures = failures + 1 WHERE id = $1 RETURNING failures", [w.id]);
      if (row.failures >= MAX_FAILURES) {
        await query("UPDATE page_watches SET status = 'done' WHERE id = $1", [w.id]);
        await notify(w, `Stopped watching ${w.url} for ${w.about}: it hasn't loaded for a day (${(err as Error).message}).`, `Stopped watching for ${w.about}`, "The page kept failing to load.");
      }
      continue;
    }
    const hash = hashOf(text);
    if (w.look_for ? contains(text, w.look_for) : hash !== w.last_hash) {
      await query("UPDATE page_watches SET status = 'done', last_hash = $2, failures = 0 WHERE id = $1", [w.id, hash]);
      const snippet = w.look_for ? around(text, w.look_for) : "";
      await notify(
        w,
        w.look_for ? `"${w.look_for}" is now on ${w.url} (${w.about}):\n${snippet}` : `${w.url} changed (${w.about}).`,
        w.look_for ? `It's up: ${w.about}` : `Page changed: ${w.about}`,
        snippet || w.url,
      );
    } else {
      await query("UPDATE page_watches SET last_hash = $2, failures = 0 WHERE id = $1", [w.id, hash]);
    }
  }
}

async function notify(w: PageWatch, text: string, title: string, body: string) {
  const conversationId = w.conversation_id ?? (await memory.createConversation(w.user_id));
  await memory.appendMessage(conversationId, "assistant", [{ type: "text", text }], text, "system", "task_update");
  await sendPush(w.user_id, title, body, { conversationId }, "reply");
}
