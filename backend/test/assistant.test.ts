import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runTurn, setClient, type ChatEvent } from "../src/assistant.js";
import { pool } from "../src/db.js";
import * as memory from "../src/memory.js";
import { resetDb } from "./helpers.js";

type Msg = Partial<Anthropic.Beta.BetaMessage> & Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">;

/** A fake client that replays scripted responses and records each request. */
function fakeClient(responses: Msg[]) {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Anthropic.Beta.MessageCreateParams) {
          requests.push(structuredClone(params));
          const message = responses.shift();
          if (!message) throw new Error("no scripted response left");
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
    expect(requests[0].messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
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
    expect(texts).toEqual(["[Background task update]\nBooked the table", "(Sent by voice.)", "thanks"]);
  });

  it("does not store a refused turn", async () => {
    fakeClient([{ content: [], stop_reason: "refusal" }]);
    const id = await memory.createConversation("me");
    const events: ChatEvent[] = [];
    await runTurn({ conversationId: id, text: "x", source: "text", emit: (e) => events.push(e) });
    expect((await memory.getApiHistory(id)).map((m) => m.role)).toEqual(["user"]);
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});
