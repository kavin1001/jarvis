import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runTurn, setClient, type ChatEvent } from "../src/assistant.js";
import { pool } from "../src/db.js";
import { addServer } from "../src/mcp.js";
import * as memory from "../src/memory.js";
import { resetDb } from "./helpers.js";

type Msg = Partial<Anthropic.Beta.BetaMessage> & Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">;

/** A fake client that replays scripted responses and records each request. */
function fakeClient(responses: Msg[]) {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  const client = {
    files: { upload: async () => ({ id: "file_123" }) },
    beta: {
      messages: {
        // Conversation titling.
        create: async () => ({
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "\"Sushi in Austin.\"" }],
          usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null },
        }),
        stream(params: Anthropic.Beta.MessageCreateParams) {
          requests.push(structuredClone(params));
          const scripted = responses.shift();
          if (!scripted) throw new Error("no scripted response left");
          const message = {
            model: "claude-opus-5-5",
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null },
            ...scripted,
          };
          return {
            on(event: string, fn: (delta: string) => void) {
              if (event !== "text") return;
              for (const b of message.content) if (b.type === "text") fn(b.text);
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
  setClient(client as unknown as Anthropic);
  return requests;
}

beforeEach(resetDb);
afterAll(() => pool.end());

describe("runTurn", () => {
  it("streams text and stores both turns", async () => {
    const requests = fakeClient([
      { content: [{ type: "text", text: "Hi there.", citations: null }], stop_reason: "end_turn" },
    ]);
    const id = await memory.createConversation("me");
    const events: ChatEvent[] = [];
    await runTurn({ conversationId: id, text: "hello", source: "text", emit: (e) => events.push(e) });

    expect(events).toEqual([{ type: "text", text: "Hi there." }, { type: "done" }]);
    expect(requests).toHaveLength(1);
    const first = requests[0].messages[0].content as { text: string }[];
    expect(first.at(-1)).toEqual({ type: "text", text: "hello" });
    const stored = await memory.getApiHistory(id);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs the remember tool and continues the loop", async () => {
    const requests = fakeClient([
      {
        content: [{ type: "tool_use", id: "tu_1", name: "remember", input: { fact: "Likes tea" }, caller: undefined } as never],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Noted.", citations: null }], stop_reason: "end_turn" },
    ]);
    const id = await memory.createConversation("me");
    await runTurn({ conversationId: id, text: "I like tea", source: "text", emit: () => {} });

    expect((await memory.listFacts("me")).map((f) => f.fact)).toEqual(["Likes tea"]);
    const second = requests[1].messages;
    const last = second.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("tool_result");
  });

  it("marks voice turns and folds in pending task updates", async () => {
    const requests = fakeClient([
      { content: [{ type: "text", text: "Sure.", citations: null }], stop_reason: "end_turn" },
    ]);
    const id = await memory.createConversation("me");
    await memory.appendMessage(id, "assistant", [{ type: "text", text: "u" }], "Booked the table", "system", "task_update");
    await runTurn({ conversationId: id, text: "thanks", source: "voice", emit: () => {} });

    const texts = (requests[0].messages[0].content as { text: string }[]).map((b) => b.text);
    expect(texts[0]).toBe("[Background task update]\nBooked the table");
    expect(texts[1]).toMatch(/^\(User's local time: .+, UTC\.\)$/);
    expect(texts.slice(2)).toEqual(["(Sent by voice.)", "thanks"]);
  });

  it("adds the approximate location to the user turn", async () => {
    const requests = fakeClient([{ content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn" }]);
    const id = await memory.createConversation("me");
    await runTurn({
      conversationId: id,
      text: "coffee near me?",
      source: "text",
      emit: () => {},
      location: { latitude: 30.2672, longitude: -97.7431, label: "Austin, Texas\n(US)" },
    });
    const texts = (requests[0].messages[0].content as { text: string }[]).map((b) => b.text);
    expect(texts).toContain("(User's approximate location: Austin, Texas US (30.27, -97.74).)");
  });

  it("schedules a reminder through the tool", async () => {
    fakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "tu_r",
            name: "set_reminder",
            input: { text: "Stretch", due_at: new Date(Date.now() + 3_600_000).toISOString(), repeat: "daily" },
          } as never,
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Done.", citations: null }], stop_reason: "end_turn" },
    ]);
    const id = await memory.createConversation("me");
    const answer = await runTurn({ conversationId: id, text: "remind me", source: "text", emit: () => {}, timezone: "Europe/Paris" });
    expect(answer).toBe("Done.");
    const { listReminders } = await import("../src/reminders.js");
    const [r] = await listReminders("me");
    expect(r).toMatchObject({ text: "Stretch", repeat: "daily", action: "notify", timezone: "Europe/Paris" });
  });

  it("uploads photos and sends them as file references", async () => {
    const requests = fakeClient([{ content: [{ type: "text", text: "A cat.", citations: null }], stop_reason: "end_turn" }]);
    const id = await memory.createConversation("me");
    await runTurn({
      conversationId: id,
      text: "what is this?",
      source: "text",
      emit: () => {},
      images: [{ media_type: "image/jpeg", data: Buffer.from("fake").toString("base64") }],
    });
    const content = requests[0].messages[0].content as { type: string }[];
    expect(content).toContainEqual({ type: "image", source: { type: "file", file_id: "file_123" } });
    const rows = await memory.getMessages(id);
    expect(rows[0].display_text).toBe("📷 what is this?");
  });

  it("does not store a refused turn", async () => {
    fakeClient([{ content: [], stop_reason: "refusal" }]);
    const id = await memory.createConversation("me");
    const events: ChatEvent[] = [];
    await runTurn({ conversationId: id, text: "x", source: "text", emit: (e) => events.push(e) });
    expect((await memory.getApiHistory(id)).map((m) => m.role)).toEqual(["user"]);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("passes enabled MCP servers as servers plus toolsets", async () => {
    process.env.CONNECTOR_SECRET = "s";
    await addServer("me", { name: "notion", url: "https://mcp.notion.example/mcp", token: "tok" });
    await addServer("me", { name: "linear", url: "https://mcp.linear.example/sse" });
    const requests = fakeClient([{ content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn" }]);
    const id = await memory.createConversation("me");
    await runTurn({ conversationId: id, text: "hi", source: "text", emit: () => {} });
    const req = requests[0] as Anthropic.Beta.MessageCreateParams & { mcp_servers?: unknown[] };
    expect(req.betas).toContain("mcp-client-2026-09-15");
    expect(req.mcp_servers).toEqual([
      { type: "url", name: "linear", url: "https://mcp.linear.example/sse" },
      { type: "url", name: "notion", url: "https://mcp.notion.example/mcp", authorization_token: "tok" },
    ]);
    expect(req.tools!.slice(-2)).toEqual([
      { type: "mcp_toolset", mcp_server_name: "linear" },
      { type: "mcp_toolset", mcp_server_name: "notion" },
    ]);
  });

  it("runs overlapping turns in one conversation one after another", async () => {
    const requests = fakeClient([
      { content: [{ type: "text", text: "first", citations: null }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: "second", citations: null }], stop_reason: "end_turn" },
    ]);
    const id = await memory.createConversation("me");
    await Promise.all([
      runTurn({ conversationId: id, text: "one", source: "text", emit: () => {} }),
      runTurn({ conversationId: id, text: "two", source: "text", emit: () => {} }),
    ]);
    // The second request already sees the first exchange, so roles alternate.
    expect(requests[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("attaches PDFs through the Files API and text files inline", async () => {
    const requests = fakeClient([{ content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn" }]);
    const id = await memory.createConversation("me");
    await runTurn({
      conversationId: id,
      text: "compare these",
      source: "text",
      emit: () => {},
      documents: [
        { name: "lease.pdf", media_type: "application/pdf", data: Buffer.from("%PDF-1.4 fake").toString("base64") },
        { name: "notes.txt", media_type: "text/plain", data: Buffer.from("rent is $2000").toString("base64") },
      ],
    });
    const blocks = requests[0].messages[0].content as { type: string; title?: string; source?: unknown }[];
    expect(blocks.filter((b) => b.type === "document")).toEqual([
      { type: "document", title: "lease.pdf", source: { type: "file", file_id: "file_123" } },
      { type: "document", title: "notes.txt", source: { type: "text", media_type: "text/plain", data: "rent is $2000" } },
    ]);
    const [stored] = await memory.getMessages(id);
    expect(stored.display_text).toBe("📄 lease.pdf\n📄 notes.txt\ncompare these");
  });

  it("names a new conversation after its first exchange", async () => {
    fakeClient([{ content: [{ type: "text", text: "Try Uchi.", citations: null }], stop_reason: "end_turn" }]);
    const id = await memory.createConversation("me");
    await runTurn({ conversationId: id, text: "good sushi around here?", source: "text", emit: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    const [conv] = (await memory.listConversations("me")).filter((c) => c.id === id);
    expect(conv.title).toBe("Sushi in Austin");
  });

  it("stops mid-reply and keeps the part already shown", async () => {
    const stop = new AbortController();
    setClient({
      beta: {
        messages: {
          stream(_params: unknown, opts: { signal?: AbortSignal }) {
            return {
              on(event: string, fn: (delta: string) => void) {
                if (event === "text") fn("The best sushi in Austin is");
              },
              finalMessage: () => {
                // Stop once the first words are out, as a user tapping Stop would.
                setTimeout(() => stop.abort(), 0);
                return new Promise((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
              },
            };
          },
        },
      },
    } as unknown as Anthropic);
    const id = await memory.createConversation("me");
    const events: ChatEvent[] = [];
    const turn = runTurn({ conversationId: id, text: "sushi?", source: "text", emit: (e) => events.push(e), signal: stop.signal });
    expect(await turn).toBe("The best sushi in Austin is");
    expect(events.at(-1)).toEqual({ type: "done" });
    const stored = await memory.getMessages(id);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored[1].display_text).toBe("The best sushi in Austin is …(stopped)");
  });
});
