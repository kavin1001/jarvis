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
import { runTurn, type ChatEvent } from "./assistant.js";
import { config } from "./config.js";
import { query } from "./db.js";
import { allowAttempt, authenticate, createPairingCode, listDevices, redeemPairingCode, registerDevice, revokeDevice, type Caller } from "./devices.js";
import { disconnectGoogle, googleStatus, handleGoogleCallback, startGoogleAuth } from "./google.js";
import { addServer, deleteServer, listServers, NewServer, setServerEnabled } from "./mcp.js";
import * as memory from "./memory.js";
import { savePushToken } from "./push.js";
import { cancelReminder, createReminder, getTimezone, listReminders, snoozeReminder } from "./reminders.js";
import { serverStatus } from "./status.js";
import { firstOccurrence } from "./time.js";
import { summarize } from "./usage.js";
import { decideApproval, listTasks } from "./tasks.js";

export const app = new Hono<{ Variables: { caller: Caller } }>();

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
app.use("*", async (c, next) => (c.req.path === "/api/chat" ? next() : bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge })(c, next)));
app.use("/oauth/*", secureHeaders());

app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} failed`, err);
  return c.json({ error: "Something went wrong" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.use("/api/*", async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  const caller = token ? await authenticate(token) : null;
  if (!caller) return c.json({ error: "Unauthorized" }, 401);
  c.set("caller", caller);
  await next();
});

const DeviceName = z.object({ name: z.string().trim().min(1).max(60) });
const Pair = DeviceName.extend({ code: z.string().min(8).max(20) });

// A new device trades a one-time code (shown on a signed-in device) for its own token.
app.post("/pair", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (!allowAttempt(`pair:${ip}`)) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
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
    // The app closes the request when the user taps Stop.
    const stop = new AbortController();
    stream.onAbort(() => stop.abort());
    const send = (e: ChatEvent | { type: "conversation"; conversationId: string }) =>
      stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    await send({ type: "conversation", conversationId: id });
    try {
      await runTurn({
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
    }
  });
});

app.get("/api/status", async (c) => c.json(await serverStatus(config.userId)));

app.get("/api/conversations", async (c) => c.json(await memory.listConversations(config.userId)));

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
      .map((r) => ({ id: r.id, role: r.role, kind: r.kind, text: r.display_text, source: r.source, createdAt: r.created_at })),
  );
});

const RenameBody = z.object({ title: z.string().trim().min(1).max(80) });
app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const body = RenameBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.message }, 400);
  if (!(await memory.conversationBelongsTo(id, config.userId))) return c.json({ error: "Not found" }, 404);
  await memory.setTitle(id, body.data.title);
  return c.json({ id, title: body.data.title });
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
app.delete("/api/facts/:id", async (c) =>
  c.json({ deleted: await memory.deleteFact(config.userId, c.req.param("id")) }),
);

app.get("/api/reminders", async (c) => c.json(await listReminders(config.userId)));

// Routines from the app ("every weekday at 8, brief me"), without going through chat.
const NewRoutine = z.object({
  text: z.string().trim().min(1).max(1000),
  action: z.enum(["notify", "run"]).default("run"),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour"),
  repeat: z.enum(["daily", "weekdays", "weekly"]).nullable().default("daily"),
});
app.post("/api/reminders", async (c) => {
  const body = NewRoutine.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues.map((i) => i.message).join("; ") }, 400);
  const [hour, minute] = body.data.time.split(":").map(Number);
  const tz = await getTimezone(config.userId);
  const dueAt = firstOccurrence(hour, minute, body.data.repeat, tz);
  const id = await createReminder({ userId: config.userId, conversationId: null, ...body.data, dueAt });
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

app.delete("/api/reminders/:id", async (c) =>
  c.json({ cancelled: await cancelReminder(config.userId, c.req.param("id")) }),
);

app.get("/api/usage", async (c) =>
  c.json(await summarize(config.userId, await getTimezone(config.userId), config.dailyBudgetUsd)),
);

app.get("/api/tasks", async (c) => c.json(await listTasks(config.userId)));

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
