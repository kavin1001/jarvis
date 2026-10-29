import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn, type ChatEvent } from "./assistant.js";
import { config } from "./config.js";
import * as memory from "./memory.js";
import { savePushToken } from "./push.js";
import { cancelReminder, getTimezone, listReminders } from "./reminders.js";
import { summarize } from "./usage.js";
import { decideApproval, listTasks } from "./tasks.js";

export const app = new Hono();

if (process.env.NODE_ENV !== "test") app.use(logger());

app.get("/health", (c) => c.json({ ok: true }));
app.use("/api/*", bearerAuth({ token: config.appToken }));

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
});

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
        emit: (e) => void send(e),
      });
    } catch (err) {
      console.error("chat turn failed", err);
      await send({ type: "error", message: "Jarvis hit an error. Try again." });
    }
  });
});

app.get("/api/conversations", async (c) => c.json(await memory.listConversations(config.userId)));

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
