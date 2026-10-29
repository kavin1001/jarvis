import type Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { decrypt, encrypt } from "./crypto.js";
import { query } from "./db.js";

// Read mail, save drafts (never send), read and add calendar events.
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
];

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // ms epoch
}

function env() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL, CONNECTOR_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !PUBLIC_URL || !CONNECTOR_SECRET) return null;
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: `${PUBLIC_URL.replace(/\/$/, "")}/oauth/google/callback`,
    secret: CONNECTOR_SECRET,
  };
}

export function googleConfigured() {
  return env() !== null;
}

export async function googleStatus(userId: string) {
  const [row] = await query<{ account_email: string | null; updated_at: string }>(
    "SELECT account_email, updated_at FROM connectors WHERE user_id = $1 AND provider = 'google'",
    [userId],
  );
  return { available: googleConfigured(), connected: Boolean(row), email: row?.account_email ?? null };
}

/** Returns the Google consent URL. The state ties the callback to this user and expires in 10 minutes. */
export async function startGoogleAuth(userId: string): Promise<string> {
  const e = env();
  if (!e) throw new Error("Google connector is not configured");
  const state = randomBytes(24).toString("base64url");
  await query("INSERT INTO oauth_states (state, user_id, provider, expires_at) VALUES ($1, $2, 'google', now() + interval '10 minutes')", [
    state,
    userId,
  ]);
  const params = new URLSearchParams({
    client_id: e.clientId,
    redirect_uri: e.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
}

/** Finishes the OAuth flow. Returns the connected account's email. */
export async function handleGoogleCallback(code: string, state: string): Promise<string | null> {
  const e = env();
  if (!e) throw new Error("Google connector is not configured");
  const [claimed] = await query<{ user_id: string }>(
    "DELETE FROM oauth_states WHERE state = $1 AND provider = 'google' AND expires_at > now() RETURNING user_id",
    [state],
  );
  if (!claimed) throw new Error("This sign-in link expired. Start again from the app.");

  const t = await tokenRequest({
    code,
    client_id: e.clientId,
    client_secret: e.clientSecret,
    redirect_uri: e.redirectUri,
    grant_type: "authorization_code",
  });
  const tokens: Tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };

  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const email = info.ok ? ((await info.json()) as { email?: string }).email ?? null : null;

  await query(
    `INSERT INTO connectors (user_id, provider, account_email, tokens, scopes) VALUES ($1, 'google', $2, $3, $4)
     ON CONFLICT (user_id, provider) DO UPDATE SET account_email = $2, tokens = $3, scopes = $4, updated_at = now()`,
    [claimed.user_id, email, encrypt(JSON.stringify(tokens), e.secret), t.scope],
  );
  return email;
}

export async function disconnectGoogle(userId: string) {
  const e = env();
  const [row] = await query<{ tokens: string }>(
    "DELETE FROM connectors WHERE user_id = $1 AND provider = 'google' RETURNING tokens",
    [userId],
  );
  if (row && e) {
    const tokens = JSON.parse(decrypt(row.tokens, e.secret)) as Tokens;
    // Best effort: also revoke Google's grant so the token is useless if leaked.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token ?? tokens.access_token)}`, {
      method: "POST",
    }).catch(() => {});
  }
  return Boolean(row);
}

async function accessToken(userId: string): Promise<string> {
  const e = env();
  if (!e) throw new Error("Google connector is not configured");
  const [row] = await query<{ tokens: string }>("SELECT tokens FROM connectors WHERE user_id = $1 AND provider = 'google'", [userId]);
  if (!row) throw new Error("Google is not connected. Ask the user to connect it in Jarvis settings.");
  const tokens = JSON.parse(decrypt(row.tokens, e.secret)) as Tokens;
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error("Google access expired. Ask the user to reconnect Google in settings.");

  const t = await tokenRequest({
    refresh_token: tokens.refresh_token,
    client_id: e.clientId,
    client_secret: e.clientSecret,
    grant_type: "refresh_token",
  });
  const refreshed: Tokens = { ...tokens, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 };
  await query("UPDATE connectors SET tokens = $3, updated_at = now() WHERE user_id = $1 AND provider = $2", [
    userId,
    "google",
    encrypt(JSON.stringify(refreshed), e.secret),
  ]);
  return refreshed.access_token;
}

async function google<T>(userId: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${await accessToken(userId)}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// ---- Tools ---------------------------------------------------------------

export const googleTools: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "gmail_search",
    description:
      "Search the user's Gmail with Gmail search syntax (from:, subject:, newer_than:2d, is:unread, ...). Returns sender, subject, date, snippet and id for each match.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", description: "1-10, default 5" },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read",
    description: "Read one email's full text by id (from gmail_search).",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
  },
  {
    name: "gmail_create_draft",
    description:
      "Save an email draft in the user's Gmail. It is NOT sent; the user reviews and sends it from Gmail. Pass reply_to_message_id to draft a reply in the same thread.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text." },
        reply_to_message_id: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_list_events",
    description: "List events on the user's primary Google Calendar between two ISO 8601 times.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string" },
        time_max: { type: "string" },
        query: { type: "string", description: "Optional free-text filter." },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Add an event to the user's primary calendar. No invitations are sent. Confirm the details with the user first unless they were explicit.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        start: { type: "string", description: "ISO 8601 with offset" },
        end: { type: "string", description: "ISO 8601 with offset" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["summary", "start", "end"],
    },
  },
];

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date-time");
const inputs = {
  gmail_search: z.object({ query: z.string(), max_results: z.number().int().min(1).max(10).default(5) }),
  gmail_read: z.object({ message_id: z.string() }),
  gmail_create_draft: z.object({
    to: z.string().min(3),
    subject: z.string(),
    body: z.string(),
    reply_to_message_id: z.string().optional(),
  }),
  calendar_list_events: z.object({ time_min: isoDate, time_max: isoDate, query: z.string().optional() }),
  calendar_create_event: z.object({
    summary: z.string().min(1),
    start: isoDate,
    end: isoDate,
    location: z.string().optional(),
    description: z.string().optional(),
  }),
};

export function isGoogleTool(name: string): name is keyof typeof inputs {
  return name in inputs;
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: GmailPart & { headers: GmailHeader[] };
}

const header = (m: GmailMessage, name: string) =>
  m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function plainText(part: GmailPart): string {
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const text = plainText(p);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

// Header values must not carry line breaks (header injection).
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

export async function runGoogleTool(userId: string, name: keyof typeof inputs, raw: unknown): Promise<string> {
  const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
  const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  switch (name) {
    case "gmail_search": {
      const { query: q, max_results } = inputs.gmail_search.parse(raw);
      const list = await google<{ messages?: { id: string }[] }>(
        userId,
        `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(max_results) })}`,
      );
      if (!list.messages?.length) return "No matching emails.";
      const metas = await Promise.all(
        list.messages.map((m) =>
          google<GmailMessage>(
            userId,
            `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          ),
        ),
      );
      return metas
        .map((m) => `[${m.id}] ${header(m, "Date")}\nFrom: ${header(m, "From")}\nSubject: ${header(m, "Subject")}\n${m.snippet}`)
        .join("\n\n");
    }
    case "gmail_read": {
      const { message_id } = inputs.gmail_read.parse(raw);
      const m = await google<GmailMessage>(userId, `${GMAIL}/messages/${encodeURIComponent(message_id)}?format=full`);
      const body = plainText(m.payload).slice(0, 8000);
      // Email bodies are untrusted: label them so the model treats them as data.
      return `From: ${header(m, "From")}\nTo: ${header(m, "To")}\nDate: ${header(m, "Date")}\nSubject: ${header(m, "Subject")}\n\n<email_body untrusted="true">\n${body}\n</email_body>`;
    }
    case "gmail_create_draft": {
      const { to, subject, body, reply_to_message_id } = inputs.gmail_create_draft.parse(raw);
      const lines = [`To: ${oneLine(to)}`, `Subject: ${oneLine(subject)}`, "Content-Type: text/plain; charset=UTF-8"];
      let threadId: string | undefined;
      if (reply_to_message_id) {
        const original = await google<GmailMessage>(
          userId,
          `${GMAIL}/messages/${encodeURIComponent(reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID`,
        );
        threadId = original.threadId;
        const messageId = header(original, "Message-ID");
        if (messageId) lines.push(`In-Reply-To: ${messageId}`, `References: ${messageId}`);
      }
      const rawMessage = Buffer.from(`${lines.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
      const draft = await google<{ id: string }>(userId, `${GMAIL}/drafts`, {
        method: "POST",
        body: { message: { raw: rawMessage, ...(threadId ? { threadId } : {}) } },
      });
      return `Draft ${draft.id} saved in Gmail. It has not been sent; the user can review and send it from Gmail.`;
    }
    case "calendar_list_events": {
      const { time_min, time_max, query: q } = inputs.calendar_list_events.parse(raw);
      const params = new URLSearchParams({
        timeMin: new Date(time_min).toISOString(),
        timeMax: new Date(time_max).toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "25",
        ...(q ? { q } : {}),
      });
      const res = await google<{
        items: { summary?: string; location?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }[];
      }>(userId, `${CAL}?${params}`);
      if (!res.items.length) return "No events in that range.";
      return res.items
        .map((ev) => `${ev.start.dateTime ?? ev.start.date} to ${ev.end.dateTime ?? ev.end.date}: ${ev.summary ?? "(no title)"}${ev.location ? ` @ ${ev.location}` : ""}`)
        .join("\n");
    }
    case "calendar_create_event": {
      const e = inputs.calendar_create_event.parse(raw);
      const created = await google<{ id: string; htmlLink: string }>(userId, `${CAL}?sendUpdates=none`, {
        method: "POST",
        body: {
          summary: e.summary,
          location: e.location,
          description: e.description,
          start: { dateTime: new Date(e.start).toISOString() },
          end: { dateTime: new Date(e.end).toISOString() },
        },
      });
      return `Event created: ${created.htmlLink}`;
    }
  }
}

export interface AgendaEvent {
  summary: string;
  start: string;
  all_day: boolean;
  location: string | null;
}

/** The next few calendar events, for the app's "coming up" card. Empty when Google isn't connected. */
export async function upcomingEvents(userId: string, hours = 24, max = 3): Promise<AgendaEvent[]> {
  if (!env()) return [];
  const [row] = await query("SELECT 1 FROM connectors WHERE user_id = $1 AND provider = 'google'", [userId]);
  if (!row) return [];
  const now = new Date();
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + hours * 3600_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const res = await google<{
    items: { summary?: string; location?: string; start: { dateTime?: string; date?: string } }[];
  }>(userId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return res.items.map((e) => ({
    summary: e.summary ?? "(No title)",
    start: e.start.dateTime ?? e.start.date ?? "",
    all_day: !e.start.dateTime,
    location: e.location ?? null,
  }));
}
