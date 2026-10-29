import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { setClient } from "../src/assistant.js";
import { pool } from "../src/db.js";
import * as memory from "../src/memory.js";
import { savePushToken } from "../src/push.js";
import { auth, resetDb } from "./helpers.js";

const realFetch = globalThis.fetch;

/** A model that says "The answer" and then waits until released (or aborted). */
function slowModel() {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let started = false;
  setClient({
    beta: {
      messages: {
        create: async () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Title" }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null } }),
        stream(_params: unknown, opts: { signal?: AbortSignal }) {
          started = true;
          return {
            on(event: string, fn: (delta: string) => void) {
              if (event === "text") fn("The answer");
            },
            finalMessage: () =>
              new Promise((resolve, reject) => {
                opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                released.then(() =>
                  resolve({
                    model: "claude-opus-5-5",
                    stop_reason: "end_turn",
                    content: [{ type: "text", text: "The answer is 42.", citations: null }],
                    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null },
                  }),
                );
              }),
          };
        },
      },
    },
  } as unknown as Anthropic);
  return { release, started: async () => started };
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

const chat = (conversationId: string) =>
  app.request("/api/chat", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, text: "what is the answer?" }),
  });
const stop = async (id: string) =>
  ((await (await app.request(`/api/conversations/${id}/stop`, { method: "POST", headers: auth })).json()) as { stopped: boolean }).stopped;

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

describe("chat stream", () => {
  it("Stop ends the reply and keeps what was shown", async () => {
    const model = slowModel();
    const id = await memory.createConversation("me");
    const res = await chat(id);
    await until(model.started);
    expect(await stop(id)).toBe(true);
    const body = await res.text();
    expect(body).toContain("The answer");
    await until(async () => (await memory.getMessages(id)).length === 2);
    expect((await memory.getMessages(id))[1].display_text).toBe("The answer …(stopped)");
  });

  it("a dropped connection lets the reply finish and sends it as a notification", async () => {
    const pushes: { title: string; body: string; data: { conversationId: string } }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://exp.host/")) {
        pushes.push(...JSON.parse(init!.body as string));
        return Response.json({ data: [{ status: "ok" }] });
      }
      return realFetch(input, init);
    });
    await savePushToken("me", "ExponentPushToken[phone]");
    const model = slowModel();
    const id = await memory.createConversation("me");
    const res = await chat(id);
    await until(model.started);
    await res.body!.cancel(); // the phone locked and dropped the connection
    model.release();
    await until(async () => pushes.length === 1);
    expect(pushes[0]).toMatchObject({ title: "Jarvis replied", body: "The answer is 42.", data: { conversationId: id }, categoryId: "reply" });
    expect((await memory.getMessages(id)).at(-1)?.display_text).toBe("The answer is 42.");
    expect(await stop(id)).toBe(false);
  });
});
