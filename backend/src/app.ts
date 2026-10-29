import { serveStatic } from "@hono/node-server/serve-static";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { deleteAllData, exportData } from "./account.js";
import { runTurn, sourcesOf, type ChatEvent } from "./assistant.js";
import { config } from "./config.js";
import { query } from "./db.js";
import { allowAttempt, authenticate, createPairingCode, isLimited, listDevices, redeemPairingCode, registerDevice, revokeDevice, type Caller } from "./devices.js";
import { clearSheetRange, deleteContact, deleteDraft, disconnectGoogle, googleStatus, handleGoogleCallback, modifyMail, restoreEvent, runGoogleTool, startGoogleAuth, trashDriveFile, upcomingEvents } from "./google.js";
import { addServer, deleteServer, listServers, NewServer, setServerEnabled } from "./mcp.js";
import { handleMcpCallback, startMcpOAuth } from "./mcpOAuth.js";
import * as lists from "./lists.js";
import * as notes from "./notes.js";
import { recentActivity, undoActivity } from "./activity.js";
import { countOldChats, getChatRetention, RETENTION_CHOICES, setChatRetention, sweepOldChats } from "./retention.js";
import { ClaudeExport, importClaudeChats } from "./importClaude.js";
import * as memory from "./memory.js";
import * as mailWatch from "./mailWatch.js";
import * as pageWatch from "./pageWatch.js";
import * as mailSnooze from "./mailSnooze.js";
import * as places from "./places.js";
import { getNotifySettings, savePushToken, sendPush, setNotifySettings } from "./push.js";
import { cancelReminder, createReminder, getTimezone, listReminders, markReminderDone, rescheduleReminder, runReminderNow, skipReminder, snoozeReminder } from "./reminders.js";
import { serverStatus } from "./status.js";
import { firstOccurrence } from "./time.js";
import { summarize } from "./usage.js";
import { weatherGlance } from "./weather.js";
import { cancelTask, decideApproval, downloadTaskFile, listTasks } from "./tasks.js";

export const app = new Hono<{ Variables: { caller: Caller } }>();
// Defaults: nosniff, frame-ancestors via X-Frame-Options, strict referrer, no CSP (the web app uses inline styles).
app.use("*", secureHeaders());

if (process.env.NODE_ENV !== "test") app.use(logger());

// Render restarts the instance when this fails, so it checks the database too.
app.get("/health", async (c) => {
  try {
    await query("SELECT 1");
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }
});

// Chat carries up to 4 base64 photos; everything else is small JSON.
const tooLarge = (c: { json: (b: unknown, s: 413) => Response }) => c.json({ error: "Request too large" }, 413);
app.use("/api/chat", bodyLimit({ maxSize: 32 * 1024 * 1024, onError: tooLarge }));
// A Claude.ai export can be large: years of chats as one JSON file.
app.use("/api/import/claude", bodyLimit({ maxSize: 100 * 1024 * 1024, onError: tooLarge }));
const BIG_BODIES = new Set(["/api/chat", "/api/import/claude"]);
app.use("*", async (c, next) => (BIG_BODIES.has(c.req.path) ? next() : bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge })(c, next)));

/**
 * The caller's address. Behind one proxy (Render, Fly) the right-most
 * X-Forwarded-For entry is the one the proxy added, so a client can't pick it.
 */
const clientIp = (c: { req: { header: (name: string) => string | undefined } }) =>
  c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
const FAILED_SIGN_IN_LIMIT = 20;

app.onError((err, c) => {
  // A malformed id (Postgres can't read it as a uuid or number) can't match anything.
  if ((err as { code?: string }).code === "22P02") return c.json({ error: "Not found" }, 404);
  if (err instanceof SyntaxError) return c.json({ error: "The request body isn't valid JSON." }, 400);
  console.error(`${c.req.method} ${c.req.path} failed`, err);
  return c.json({ error: "Something went wrong" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.use("/api/*", async (c, next) => {
  const ip = clientIp(c);
  // Slows down guessing a weak JARVIS_APP_TOKEN; only failures count.
  if (isLimited(`auth:${ip}`, FAILED_SIGN_IN_LIMIT)) return c.json({ error: "Too many failed sign-ins. Wait a minute." }, 429);
  const token = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  const caller = token ? await authenticate(token) : null;
  if (!caller) {
    allowAttempt(`auth:${ip}`, FAILED_SIGN_IN_LIMIT);
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("caller", caller);
  await next();
});

const DeviceName = z.object({ name: z.string().trim().min(1).max(60) });
const Pair = DeviceName.extend({ code: z.string().min(8).max(20) });

// A new device trades a one-time code (shown on a signed-in device) for its own token.
app.post("/pair", async (c) => {
  if (!allowAttempt(`pair:${clientIp(c)}`)) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
  const body = Pair.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Enter the code and a device name" }, 400);
  const device = await redeemPairingCode(body.data.code, body.data.name);
  return device ? c.json(device) : c.json({ error: "That code is wrong or expired" }, 400);
});

const page = (title: string, body: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui;background:#0b0b0f;color:#eee;display:grid;place-items:center;min-height:90vh;text-align:center">` +
  `<div><h2>${title}</h2><p>${body}</p></div>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Google redirects the browser here, so it cannot carry the app's bearer token; the one-time state authenticates it.
app.get("/oauth/google/callback", async (c) => {
  const { code, state, error } = c.req.query();
  if (error || !code || !state) return c.html(page("Google not connected", escapeHtml(error ?? "Missing code.")), 400);
  try {
    const email = await handleGoogleCallback(code, state);
    return c.html(page("Google connected", `${email ? escapeHtml(email) + " is" : "Your account is"} linked to Jarvis. You can close this page.`));
  } catch (err) {
    console.error("google callback failed", err);
    return c.html(page("Google not connected", escapeHtml(err instanceof Error ? err.message : "Something went wrong.")), 400);
  }
});

app.get("/oauth/mcp/callback", async (c) => {
  const { code, state, error, error_description } = c.req.query();
  if (error || !code || !state) return c.html(page("Not connected", escapeHtml(error_description ?? error ?? "Missing code.")), 400);
  try {
    const name = await handleMcpCallback(code, state);
    return c.html(page("Connected", `Jarvis can now use ${escapeHtml(name)}. You can close this page.`));
  } catch (err) {
    console.error("mcp oauth callback failed", err);
    return c.html(page("Not connected", escapeHtml(err instanceof Error ? err.message : "Something went wrong.")), 400);
  }
});

const ChatBody = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().min(1).max(20_000),
  source: z.enum(["text", "voice"]).default("text"),
  timezone: z.string().max(64).optional(),
  images: z
    .array(
      z.object({
        media_type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
        data: z.string().max(7_000_000), // ~5 MB decoded, the API's per-image limit
      }),
    )
    .max(4)
    .optional(),
  documents: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        media_type: z.enum(["application/pdf", "text/plain"]),
        data: z.string().max(28_000_000), // ~20 MB decoded
      }),
    )
    .max(2)
    .optional(),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      label: z.string().max(120).optional(),
    })
    .optional(),
});

function describeChatError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return "The server's Claude API key is missing or invalid. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limiting this account right now. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "The server couldn't reach Claude. Try again.";
  if (err instanceof Anthropic.InternalServerError) return "Claude is having trouble right now. Try again shortly.";
  return "Jarvis hit an error. Try again.";
}

// Streams the reply as server-sent events: conversation, text, task_started, done, error.
app.post("/api/chat", async (c) => {
  const body = ChatBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  let { conversationId } = body.data;
  if (conversationId && !(await memory.conversationBelongsTo(conversationId, config.userId))) {
    return c.json({ error: "Unknown conversation" }, 404);
  }
  conversationId ??= await memory.createConversation(config.userId);
  const id = conversationId;

  return streamSSE(c, async (stream) => {
    // Stop comes from POST /api/conversations/:id/stop. A dropped connection (the
    // phone locked, the app went to the background) lets the reply finish and
    // sends it as a notification instead.
    const stop = new AbortController();
    turnsInFlight.set(id, stop);
    let detached = false;
    stream.onAbort(() => {
      detached = true;
    });
    const send = (e: ChatEvent | { type: "conversation"; conversationId: string }) =>
      detached ? Promise.resolve() : stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    await send({ type: "conversation", conversationId: id });
    let reply = "";
    try {
      reply = await runTurn({
        conversationId: id,
        text: body.data.text,
        source: body.data.source,
        timezone: body.data.timezone,
        images: body.data.images,
        documents: body.data.documents,
        location: body.data.location,
        signal: stop.signal,
        emit: (e) => void send(e),
      });
    } catch (err) {
      console.error("chat turn failed", err);
      await send({ type: "error", message: describeChatError(err) });
    } finally {
      if (turnsInFlight.get(id) === stop) turnsInFlight.delete(id);
    }
    if (detached && !stop.signal.aborted && reply.trim()) {
      const preview = reply.length > 180 ? `${reply.slice(0, 177)}…` : reply;
      await sendPush(config.userId, "Jarvis replied", preview, { conversationId: id }, "reply", "replies").catch((err) => console.warn("reply push failed", err));
    }
  });
});

// "Hey Siri, Ask Jarvis": an iPhone Shortcut posts what was dictated and speaks the plain-text
// answer, so Jarvis answers without opening the app. Questions a few minutes apart share a chat.
const AskBody = z.object({ text: z.string().trim().min(1).max(4000), new_chat: z.boolean().default(false) });
const ASK_SESSION_MINUTES = 10;
app.post("/api/ask", async (c) => {
  // JSON {"text": …} from "Get Contents of URL", or the question as the whole plain-text body.
  const raw = c.req.header("content-type")?.includes("json") ? await c.req.json().catch(() => null) : { text: await c.req.text() };
  const body = AskBody.safeParse(raw);
  if (!body.success) return c.text("Send the question as text.", 400);
  const [recent] = body.data.new_chat
    ? []
    : await query<{ conversation_id: string }>(
        `SELECT conversation_id FROM ask_sessions WHERE user_id = $1 AND updated_at > now() - make_interval(mins => $2)`,
        [config.userId, ASK_SESSION_MINUTES],
      );
  const conversationId = recent?.conversation_id ?? (await memory.createConversation(config.userId));
  await query(
    `INSERT INTO ask_sessions (user_id, conversation_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET conversation_id = $2, updated_at = now()`,
    [config.userId, conversationId],
  );
  try {
    const answer = await runTurn({ conversationId, text: body.data.text, source: "voice", emit: () => {} });
    return c.text(answer.trim() || "Done.");
  } catch (err) {
    console.error("ask failed", err);
    // Still a 200, so the Shortcut speaks the reason instead of showing an error.
    return c.text(describeChatError(err));
  }
});

/** The reply being written in each conversation, so Stop can end it. */
const turnsInFlight = new Map<string, AbortController>();

app.post("/api/conversations/:id/stop", async (c) => {
  const turn = turnsInFlight.get(c.req.param("id"));
  turn?.abort();
  return c.json({ stopped: Boolean(turn) });
});

app.get("/api/status", async (c) => c.json(await serverStatus(config.userId)));

// Next events for the home card. A Google error leaves the card empty rather than failing the screen.
// ?lat=&lon=&units= (the phone's approximate location) adds a line about today's weather.
const AgendaQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
});
app.get("/api/agenda", async (c) => {
  const q = AgendaQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: q.error.message }, 400);
  const { lat, lon, units } = q.data;
  const [events, weather] = await Promise.all([
    upcomingEvents(config.userId).catch((err) => {
      console.warn("agenda failed", err instanceof Error ? err.message : err);
      return [];
    }),
    lat !== undefined && lon !== undefined
      ? weatherGlance(lat, lon, units).catch((err) => {
          console.warn("weather failed", err instanceof Error ? err.message : err);
          return null;
        })
      : null,
  ]);
  return c.json({ events, weather });
});

// ?before=<updated_at>&before_id=<id> of the last chat shown loads the next, older page.
app.get("/api/conversations", async (c) => {
  const updated_at = c.req.query("before");
  const id = c.req.query("before_id");
  if (updated_at && Number.isNaN(Date.parse(updated_at))) return c.json({ error: "before must be a date" }, 400);
  return c.json(await memory.listConversations(config.userId, updated_at && id ? { updated_at, id } : undefined));
});

app.get("/api/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json([]);
  return c.json(await memory.searchMessages(config.userId, q.slice(0, 200), { limit: 25 }));
});

// What the app renders: user and assistant text plus task updates, no tool plumbing.
app.get("/api/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  if (!(await memory.conversationBelongsTo(id, config.userId))) return c.json({ error: "Not found" }, 404);
  const rows = await memory.getMessages(id);
  return c.json(
    rows
      .filter((r) => r.display_text)
      .map((r) => {
        const sources = r.role === "assistant" ? sourcesOf(r.content) : [];
        return { id: r.id, role: r.role, kind: r.kind, text: r.display_text, source: r.source, createdAt: r.created_at, ...(sources.length ? { sources } : {}) };
      }),
  );
});

const ConversationChange = z
  .object({ title: z.string().trim().min(1).max(80).optional(), pinned: z.boolean().optional() })
  .refine((b) => b.title !== undefined || b.pinned !== undefined, "Send a title or pinned");
app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const body = ConversationChange.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  if (!(await memory.conversationBelongsTo(id, config.userId))) return c.json({ error: "Not found" }, 404);
  const { title, pinned } = body.data;
  if (title !== undefined) await memory.setTitle(id, title);
  if (pinned !== undefined) await memory.setPinned(id, pinned);
  return c.json({ id, ...body.data });
});

app.delete("/api/conversations/:id", async (c) =>
  c.json({ deleted: await memory.deleteConversation(c.req.param("id"), config.userId) }),
);

app.get("/api/facts", async (c) => c.json(await memory.listFacts(config.userId)));
const FactBody = z.object({ fact: z.string().min(1).max(500) });
app.post("/api/facts", async (c) => {
  const body = FactBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const id = await memory.addFact(config.userId, body.data.fact);
  return c.json({ id, fact: body.data.fact });
});
app.patch("/api/facts/:id", async (c) => {
  const body = FactBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const id = c.req.param("id");
  if (!(await memory.updateFact(config.userId, id, body.data.fact))) return c.json({ error: "Not found" }, 404);
  return c.json({ id, fact: body.data.fact });
});
app.delete("/api/facts/:id", async (c) =>
  c.json({ deleted: await memory.deleteFact(config.userId, c.req.param("id")) }),
);

app.get("/api/lists", async (c) => c.json(await lists.allLists(config.userId)));
const NewItems = z.object({ items: z.array(z.string().trim().min(1).max(200)).min(1).max(50) }).strict();
app.post("/api/lists/:name/items", async (c) => {
  const body = NewItems.safeParse(await c.req.json());
  const name = lists.listName(c.req.param("name"));
  if (!body.success) return c.json({ error: body.error.message }, 400);
  if (!name || name.length > 60) return c.json({ error: "Give the list a name of up to 60 characters." }, 400);
  try {
    return c.json(await lists.addItems(config.userId, name, body.data.items));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
const ItemChange = z
  .object({ done: z.boolean().optional(), text: z.string().trim().min(1).max(200).optional() })
  .strict()
  .refine((b) => b.done !== undefined || b.text !== undefined, "Nothing to change");
app.patch("/api/list-items/:id", async (c) => {
  const body = ItemChange.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const item = await lists.updateItem(config.userId, c.req.param("id"), body.data);
  return item ? c.json(item) : c.json({ error: "Not found" }, 404);
});
app.delete("/api/list-items/:id", async (c) => c.json({ deleted: (await lists.removeItems(config.userId, [c.req.param("id")])) > 0 }));
app.post("/api/import/claude", async (c) => {
  const body = ClaudeExport.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "That isn't a Claude.ai conversations.json. Unzip the export and pick conversations.json." }, 400);
  return c.json(await importClaudeChats(config.userId, body.data));
});
// ?preview=90: how many chats that setting would delete right away.
app.get("/api/privacy", async (c) => {
  const preview = Number(c.req.query("preview"));
  return c.json({
    chat_retention_days: await getChatRetention(config.userId),
    ...((RETENTION_CHOICES as readonly number[]).includes(preview) ? { would_delete: await countOldChats(config.userId, preview) } : {}),
  });
});
const PrivacyChange = z
  .object({ chat_retention_days: z.union([z.null(), ...RETENTION_CHOICES.map((d) => z.literal(d))] as [z.ZodNull, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]) })
  .strict();
app.patch("/api/privacy", async (c) => {
  const body = PrivacyChange.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: `chat_retention_days must be null or one of ${RETENTION_CHOICES.join(", ")}` }, 400);
  await setChatRetention(config.userId, body.data.chat_retention_days);
  // Apply it now rather than at the next hourly sweep.
  const deleted = await sweepOldChats();
  return c.json({ chat_retention_days: body.data.chat_retention_days, deleted });
});
app.get("/api/instructions", async (c) => c.json({ instructions: await memory.getInstructions(config.userId) }));
const InstructionsBody = z.object({ instructions: z.string().max(memory.MAX_INSTRUCTIONS).nullable() }).strict();
app.put("/api/instructions", async (c) => {
  const body = InstructionsBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: `instructions must be text up to ${memory.MAX_INSTRUCTIONS} characters, or null` }, 400);
  return c.json({ instructions: await memory.setInstructions(config.userId, body.data.instructions) });
});
// Settings, Undo: puts archived mail back, deletes a draft, contact or event Jarvis added, bins a doc it made, moves an event back or puts a deleted one back, ends a snooze.
app.post("/api/activity/:id/undo", async (c) => {
  try {
    const undone = await undoActivity(config.userId, c.req.param("id"), async (u) => {
      if (u.tool === "unsnooze") {
        if (!(await mailSnooze.unsnooze(config.userId, u.snooze_id, modifyMail))) throw new Error("That email is already back in the inbox.");
      } else if (u.tool === "gmail_delete_draft") await deleteDraft(config.userId, u.draft_id);
      else if (u.tool === "delete_contact") await deleteContact(config.userId, u.contact_id);
      else if (u.tool === "restore_event") await restoreEvent(config.userId, u.copy_id);
      else if (u.tool === "trash_drive_file") await trashDriveFile(config.userId, u.file_id);
      else if (u.tool === "clear_sheet_range") await clearSheetRange(config.userId, u.file_id, u.range);
      else if (u.tool === "gmail_organize") await runGoogleTool(config.userId, "gmail_organize", { message_ids: u.message_ids, action: u.action, label: u.label });
      else if (u.tool === "calendar_update_event") await runGoogleTool(config.userId, "calendar_update_event", { event_id: u.event_id, start: u.start, end: u.end });
      else await runGoogleTool(config.userId, "calendar_delete_event", { event_id: u.event_id });
    });
    return undone ? c.json({ undone: true }) : c.json({ error: "There's nothing to undo there any more." }, 404);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
// Crashes and unhandled errors from the app, so they show up in the server logs without a crash-reporting service.
const ClientError = z
  .object({
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
    where: z.enum(["render", "global", "promise"]),
    fatal: z.boolean().default(false),
    platform: z.string().max(20),
    version: z.string().max(40),
  })
  .strict();
app.post("/api/client-errors", async (c) => {
  const body = ClientError.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid error report" }, 400);
  // A crash loop shouldn't flood the logs.
  const caller = c.get("caller");
  if (!allowAttempt(`client-errors:${caller.kind === "device" ? caller.deviceId : "owner"}`, 20, 10 * 60_000)) return c.json({ logged: false }, 429);
  const e = body.data;
  console.error(`app error (${e.where}${e.fatal ? ", fatal" : ""}, ${e.platform} ${e.version}): ${e.message}${e.stack ? `\n${e.stack}` : ""}`);
  return c.json({ logged: true });
});
app.get("/api/activity", async (c) => c.json(await recentActivity(config.userId, Math.min(200, Number(c.req.query("limit")) || 50))));
app.get("/api/notes", async (c) => c.json(await notes.findNotes(config.userId, (c.req.query("q") ?? "").slice(0, 200))));
const NewNote = z.object({ body: z.string().trim().min(1).max(notes.MAX_BODY), title: z.string().trim().max(120).optional() }).strict();
app.post("/api/notes", async (c) => {
  const body = NewNote.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  try {
    return c.json(await notes.createNote(config.userId, body.data.body, body.data.title));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
const NoteChange = z
  .object({ body: z.string().trim().min(1).max(notes.MAX_BODY).optional(), title: z.string().trim().min(1).max(120).optional() })
  .strict()
  .refine((b) => b.body !== undefined || b.title !== undefined, "Nothing to change");
app.patch("/api/notes/:id", async (c) => {
  const body = NoteChange.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const note = await notes.updateNote(config.userId, c.req.param("id"), body.data);
  return note ? c.json(note) : c.json({ error: "Not found" }, 404);
});
app.delete("/api/notes/:id", async (c) => c.json({ deleted: await notes.deleteNote(config.userId, c.req.param("id")) }));
// ?all=1 deletes the whole list; otherwise only the checked-off items.
app.delete("/api/lists/:name", async (c) =>
  c.json({ removed: await lists.clearList(config.userId, c.req.param("name"), c.req.query("all") === "1") }),
);

app.get("/api/reminders", async (c) => c.json(await listReminders(config.userId)));

// Routines from the app ("every weekday at 8, brief me"), without going through chat.
const NewRoutine = z.object({
  text: z.string().trim().min(1).max(1000),
  action: z.enum(["notify", "run"]).default("run"),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour"),
  repeat: z.enum(["daily", "weekdays", "weekends", "weekly", "biweekly", "monthly"]).nullable().default("daily"),
  // For weekly routines: the day it runs, 0 for Sunday. Without it, the first run is the next time the clock reads `time`.
  weekday: z.number().int().min(0).max(6).optional(),
});
app.post("/api/reminders", async (c) => {
  const body = NewRoutine.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues.map((i) => i.message).join("; ") }, 400);
  const [hour, minute] = body.data.time.split(":").map(Number);
  const tz = await getTimezone(config.userId);
  const { weekday, ...routine } = body.data;
  const dueAt = firstOccurrence(hour, minute, routine.repeat, tz, new Date(), weekday);
  const id = await createReminder({ userId: config.userId, conversationId: null, ...routine, dueAt });
  return c.json({ id, due_at: dueAt.toISOString() });
});
// A one-off reminder from the app ("remind me about this" on a message), in that message's chat.
const NewReminder = z
  .object({ text: z.string().trim().min(1).max(1000), due_at: z.string().datetime({ offset: true }), conversation_id: z.string().uuid().optional() })
  .strict();
app.post("/api/reminders/once", async (c) => {
  const body = NewReminder.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const dueAt = new Date(body.data.due_at);
  if (dueAt.getTime() < Date.now() - 60_000) return c.json({ error: "That time is in the past." }, 400);
  const conversationId = body.data.conversation_id ?? null;
  if (conversationId && !(await memory.conversationBelongsTo(conversationId, config.userId))) return c.json({ error: "Unknown conversation" }, 404);
  const id = await createReminder({ userId: config.userId, conversationId, text: body.data.text, action: "notify", dueAt, repeat: null });
  return c.json({ id, due_at: dueAt.toISOString() });
});
const SnoozeBody = z.object({ minutes: z.number().int().min(1).max(24 * 60) });
app.post("/api/reminders/:id/snooze", async (c) => {
  const body = SnoozeBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const reminderId = c.req.param("id");
  if (!z.string().uuid().safeParse(reminderId).success) return c.json({ error: "Not found" }, 404);
  const id = await snoozeReminder(config.userId, reminderId, body.data.minutes);
  return id ? c.json({ id }) : c.json({ error: "Not found" }, 404);
});

// "Done" on a reminder that keeps coming back.
app.post("/api/reminders/:id/done", async (c) => {
  const reminderId = c.req.param("id");
  if (!z.string().uuid().safeParse(reminderId).success) return c.json({ error: "Not found" }, 404);
  return (await markReminderDone(config.userId, reminderId)) ? c.json({ done: true }) : c.json({ error: "Not found" }, 404);
});

const Reschedule = z.object({ due_at: z.string().datetime({ offset: true }) }).strict();
app.patch("/api/reminders/:id", async (c) => {
  const body = Reschedule.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const dueAt = new Date(body.data.due_at);
  if (dueAt.getTime() < Date.now() - 60_000) return c.json({ error: "That time is in the past." }, 400);
  const ok = await rescheduleReminder(config.userId, c.req.param("id"), dueAt);
  return ok ? c.json({ id: c.req.param("id"), due_at: dueAt.toISOString() }) : c.json({ error: "Not found" }, 404);
});
app.post("/api/reminders/:id/skip", async (c) => {
  const next = await skipReminder(config.userId, c.req.param("id"));
  return next ? c.json({ id: c.req.param("id"), due_at: next.toISOString() }) : c.json({ error: "Not found" }, 404);
});
app.post("/api/reminders/:id/run", async (c) => {
  const run = (conversationId: string, text: string) => runTurn({ conversationId, text, source: "scheduled", emit: () => {} });
  return (await runReminderNow(config.userId, c.req.param("id"), run)) ? c.json({ started: true }) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/reminders/:id", async (c) =>
  c.json({ cancelled: await cancelReminder(config.userId, c.req.param("id")) }),
);

// Places and place reminders. The phone saves a precise spot, and fetches the active
// reminders to watch; when it arrives or leaves, it tells the server, which sends the reminder.
app.get("/api/places", async (c) => c.json(await places.listPlaces(config.userId)));
const NewPlace = z
  .object({ name: z.string().trim().min(1).max(60), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
  .strict();
app.post("/api/places", async (c) => {
  const body = NewPlace.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  await places.savePlace(config.userId, { ...body.data, radius_m: places.PRECISE_RADIUS_M });
  return c.json({ name: places.placeName(body.data.name) });
});
app.delete("/api/places/:name", async (c) => c.json({ deleted: await places.deletePlace(config.userId, c.req.param("name")) }));
app.get("/api/place-reminders", async (c) => c.json(await places.listPlaceReminders(config.userId)));
app.delete("/api/place-reminders/:id", async (c) => c.json({ cancelled: await places.cancelPlaceReminder(config.userId, c.req.param("id")) }));
app.get("/api/mail-watches", async (c) =>
  c.json((await mailWatch.listMailWatches(config.userId)).map(({ id, about, query, once, if_none, expires_at }) => ({ id, about, query, once, if_none, expires_at }))),
);
app.get("/api/mail-snoozes", async (c) =>
  c.json((await mailSnooze.listSnoozes(config.userId)).map(({ id, about, due_at, message_ids }) => ({ id, about, due_at, count: message_ids.length }))),
);
// Brings the emails back now.
app.delete("/api/mail-snoozes/:id", async (c) => {
  try {
    return c.json({ returned: await mailSnooze.unsnooze(config.userId, c.req.param("id"), modifyMail) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
app.get("/api/page-watches", async (c) =>
  c.json((await pageWatch.listPageWatches(config.userId)).map(({ id, about, url, look_for, expires_at }) => ({ id, about, url, look_for, expires_at }))),
);
app.delete("/api/page-watches/:id", async (c) => c.json({ cancelled: await pageWatch.cancelPageWatch(config.userId, c.req.param("id")) }));
app.delete("/api/mail-watches/:id", async (c) => c.json({ cancelled: await mailWatch.cancelMailWatch(config.userId, c.req.param("id")) }));
const PlaceEvent = z.object({ event: z.enum(["arrive", "leave"]) }).strict();
app.post("/api/place-reminders/:id/trigger", async (c) => {
  const body = PlaceEvent.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const outcome = await places.triggerPlaceReminder(config.userId, c.req.param("id"), body.data.event);
  return outcome === "not_found" ? c.json({ error: "Not found" }, 404) : c.json({ sent: outcome === "sent" });
});

app.get("/api/usage", async (c) =>
  c.json(await summarize(config.userId, await getTimezone(config.userId), config.dailyBudgetUsd)),
);

app.get("/api/tasks", async (c) => c.json(await listTasks(config.userId)));
app.get("/api/tasks/:id/files/:fileId", async (c) => {
  const file = await downloadTaskFile(config.userId, c.req.param("id"), c.req.param("fileId"));
  if (!file?.body) return c.json({ error: "Not found" }, 404);
  return new Response(file.body, {
    headers: {
      "Content-Type": file.mime_type || "application/octet-stream",
      // The agent picked the name, so it's encoded rather than trusted in the header.
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.post("/api/tasks/:id/cancel", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  const cancelled = id.success && (await cancelTask(config.userId, id.data));
  return cancelled ? c.json({ cancelled }) : c.json({ error: "No running task with that id" }, 404);
});

const Decision = z.object({ decision: z.enum(["allow", "deny"]) });
app.post("/api/approvals/:id", async (c) => {
  const body = Decision.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const ok = await decideApproval(config.userId, c.req.param("id"), body.data.decision);
  return ok ? c.json({ ok }) : c.json({ error: "No pending approval with that id" }, 404);
});

const PushToken = z.object({ token: z.string().min(1) });
app.post("/api/push-token", async (c) => {
  const body = PushToken.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  await savePushToken(config.userId, body.data.token);
  return c.json({ ok: true });
});

app.get("/api/notifications", async (c) => c.json(await getNotifySettings(config.userId)));
const minuteOfDay = z.number().int().min(0).max(1439).nullable();
const NotifyChange = z
  .object({ replies: z.boolean(), tasks: z.boolean(), spending: z.boolean(), quiet_start: minuteOfDay, quiet_end: minuteOfDay })
  .partial()
  .strict();
app.patch("/api/notifications", async (c) => {
  const body = NotifyChange.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  return c.json(await setNotifySettings(config.userId, body.data));
});

app.get("/api/connectors", async (c) => c.json({ google: await googleStatus(config.userId) }));
app.post("/api/connectors/google/start", async (c) => {
  const status = await googleStatus(config.userId);
  if (!status.available) return c.json({ error: "Google is not configured on the server" }, 400);
  return c.json({ url: await startGoogleAuth(config.userId) });
});
app.delete("/api/connectors/google", async (c) => c.json({ disconnected: await disconnectGoogle(config.userId) }));

app.get("/api/mcp-servers", async (c) => c.json(await listServers(config.userId)));
app.post("/api/mcp-servers", async (c) => {
  const body = NewServer.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  try {
    return c.json({ id: await addServer(config.userId, body.data) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
const Toggle = z.object({ enabled: z.boolean() });
app.patch("/api/mcp-servers/:id", async (c) => {
  const body = Toggle.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Not found" }, 404);
  const ok = await setServerEnabled(config.userId, id.data, body.data.enabled);
  return ok ? c.json({ ok }) : c.json({ error: "Not found" }, 404);
});
app.post("/api/mcp-servers/:id/oauth", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Not found" }, 404);
  try {
    return c.json({ url: await startMcpOAuth(config.userId, id.data) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
app.delete("/api/mcp-servers/:id", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  return c.json({ deleted: id.success && (await deleteServer(config.userId, id.data)) });
});

// The owner token can mint a device token, so the app swaps it for one at setup and forgets the master.
app.post("/api/devices", async (c) => {
  if (c.get("caller").kind !== "owner") return c.json({ error: "Only the app token can register devices" }, 403);
  const body = DeviceName.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.message }, 400);
  return c.json(await registerDevice(config.userId, body.data.name));
});
app.get("/api/devices", async (c) => {
  const caller = c.get("caller");
  const current = caller.kind === "device" ? caller.deviceId : null;
  const rows = await listDevices(config.userId);
  return c.json(rows.map((d) => ({ ...d, current: d.id === current })));
});
app.delete("/api/devices/:id", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  return c.json({ revoked: id.success && (await revokeDevice(config.userId, id.data)) });
});
// A token for an iPhone Shortcut. It's listed and revoked like any other device.
app.post("/api/devices/shortcut", async (c) => c.json(await registerDevice(config.userId, "Siri Shortcut")));
app.post("/api/devices/pair-codes", async (c) => c.json(await createPairingCode(config.userId)));

app.get("/api/export", async (c) => {
  c.header("Content-Disposition", `attachment; filename="jarvis-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(await exportData(config.userId));
});
const ConfirmDelete = z.object({ confirm: z.literal("DELETE") });
app.delete("/api/data", async (c) => {
  if (!ConfirmDelete.safeParse(await c.req.json().catch(() => null)).success) {
    return c.json({ error: 'Send {"confirm":"DELETE"} to erase everything' }, 400);
  }
  await deleteAllData(config.userId);
  return c.json({ deleted: true });
});

// The web build of the app, when present (the Docker image puts it in ./public). Same origin, so no CORS.
const webDir = process.env.WEB_DIR ?? "public";
if (existsSync(join(webDir, "index.html"))) {
  app.use("/*", serveStatic({ root: webDir }));
  // Client-side routes fall back to the app shell.
  app.get("/*", serveStatic({ root: webDir, path: "index.html" }));
}
